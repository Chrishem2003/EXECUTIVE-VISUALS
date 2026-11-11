import { apiRequest } from "../core/api";
import { createEmptyWorkflow, planWorkflowExecution, validateWorkflow, type MediaPortType, type WorkflowEdge, type WorkflowGraph, type WorkflowNode, type WorkflowNodeKind, type WorkflowPort } from "../core/workflow";

type SavedWorkflow={id:string;projectId?:string|null;name:string;revision:number;graph?:WorkflowGraph;graphHash?:string};
type WorkflowRunNode={node_id:string;status:string;error?:{code?:string;message?:string}|null};
type VideoCostEstimate={available:boolean;estimated:boolean;reason?:string;provider?:string;model?:string;currency?:string;amount?:number;billableSeconds?:number;breakdown?:{video:number;audio:number;references:number;minimumApplied:number};pricing?:{sourceUrl:string;observedAt:string;expiresAt:string};disclaimer?:string};
const state:{graph:WorkflowGraph|null;workflows:SavedWorkflow[];serverRevision:number;status:"loading"|"ready"|"offline"|"auth";message:string;selectedNode:string;plan:string;latestRunId:string;runStatus:string;runNodes:WorkflowRunNode[];costEstimate:VideoCostEstimate|null}={
 graph:null,workflows:[],serverRevision:0,status:"loading",message:"Loading workflow canvas…",selectedNode:"",plan:"",latestRunId:"",runStatus:"",runNodes:[],costEstimate:null
};
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const port=(id:string,type:MediaPortType,required=false,multiple=false):WorkflowPort=>({id,label:id,type,required,multiple});
const palette:Record<string,{kind:WorkflowNodeKind;label:string;inputs:WorkflowPort[];outputs:WorkflowPort[]}>={
 knowledge:{kind:"knowledge.search",label:"Search Project Knowledge",inputs:[port("query","text",true)],outputs:[port("document","document"),port("records","structured-data"),port("sources","document",false,true),port("text","text")]},
 text:{kind:"text",label:"Text / Prompt",inputs:[],outputs:[port("text","text")]},
 upload:{kind:"upload",label:"Use Uploaded Asset",inputs:[],outputs:[port("asset","asset"),port("media","media")]},
 reference:{kind:"reference",label:"Reference Asset",inputs:[],outputs:[port("asset","asset"),port("media","media")]},
 llm:{kind:"llm.prompt",label:"AI Text Processor",inputs:[port("prompt","text",true)],outputs:[port("text","text")]},
 image:{kind:"image.generate",label:"Image Generation",inputs:[port("prompt","text",true),port("reference","image")],outputs:[port("image","image")]},
 video:{kind:"video.generate",label:"Video Generation",inputs:[port("prompt","text",true),port("start-frame","start-frame"),port("reference","video",false,true)],outputs:[port("video","video")]},
 voice:{kind:"voice.generate",label:"Voice Generation",inputs:[port("script","text",true)],outputs:[port("audio","audio")]},
 transcribe:{kind:"voice.transcribe",label:"Audio Transcription",inputs:[port("audio","audio",true),port("approval","any")],outputs:[port("transcript","transcript"),port("text","text"),port("segments","structured-data"),port("sourceAudio","audio"),port("language","text")]},
 translate:{kind:"voice.translate",label:"Translate Captions",inputs:[port("segments","structured-data",true),port("approval","any"),port("language","text")],outputs:[port("segments","structured-data"),port("language","text")]},
 captions:{kind:"voice.caption",label:"Create Timed Captions",inputs:[port("segments","structured-data",true),port("sourceAudio","audio"),port("language","text")],outputs:[port("subtitle","subtitle-file"),port("asset","asset")]},
 frame:{kind:"utility.frame-extract",label:"Extract Video Frame",inputs:[port("media","media",true)],outputs:[port("image","image")]},
 audio:{kind:"video.extract-audio",label:"Extract Audio",inputs:[port("media","media",true)],outputs:[port("audio","audio")]},
 transcode:{kind:"utility.convert",label:"Convert / Compress",inputs:[port("asset","asset",true)],outputs:[port("asset","asset")]},
 timeline:{kind:"timeline",label:"Render Saved Timeline",inputs:[],outputs:[port("video","video")]},
 upscale:{kind:"media.upscale",label:"Image Upscale",inputs:[port("image","image",true)],outputs:[port("image","image")]},
 approval:{kind:"approval",label:"Human Approval",inputs:[port("input","any",true)],outputs:[port("result","any"),port("approved","structured-data")]},
 quality:{kind:"quality-check",label:"Quality Gate",inputs:[port("media","media",true)],outputs:[port("report","structured-data")]},
 export:{kind:"export",label:"Export Deliverable",inputs:[port("media","media",true)],outputs:[port("deliverable","asset")]},
 merge:{kind:"merge",label:"Merge Branches",inputs:[port("items","any",true,true)],outputs:[port("result","any")]},
 batch:{kind:"batch",label:"Batch Inputs",inputs:[port("items","asset",true,true)],outputs:[port("results","asset",false,true)]}
};
function nodePosition(index:number){return {x:30+(index%3)*300,y:30+Math.floor(index/3)*210};}
function addNode(definition:keyof typeof palette){
 if(!state.graph)return;
 const spec=palette[definition],id=crypto.randomUUID();
 const node:WorkflowNode={id,kind:spec.kind,label:spec.label,inputs:spec.inputs.map(x=>({...x})),outputs:spec.outputs.map(x=>({...x})),config:{},position:nodePosition(state.graph.nodes.length)};
 state.graph={...state.graph,revision:state.graph.revision+1,nodes:[...state.graph.nodes,node]};
 state.selectedNode=id;state.plan="";state.costEstimate=null;void persist().then(paint).catch(error=>{state.message=error.message;paint();});
}
function options(values:Array<{id:string;label:string}> ,selected=""){return values.map(x=>'<option value="'+esc(x.id)+'" '+(selected===x.id?"selected":"")+'>'+esc(x.label)+'</option>').join("");}
function portOptions(node:WorkflowNode|undefined,side:"inputs"|"outputs"){
 return (node?.[side]||[]).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.label)+' · '+esc(p.type)+'</option>').join("");
}
function renderNode(node:WorkflowNode){
 const position=node.position||{x:30,y:30};
 return '<article class="wf-node" draggable="true" data-wf-node="'+esc(node.id)+'" style="left:'+position.x+'px;top:'+position.y+'px"><header><span>'+esc(node.kind)+'</span><button data-wf-remove-node="'+esc(node.id)+'">×</button></header><b>'+esc(node.label)+'</b><small>'+esc(node.id.slice(0,8))+'</small><div class="wf-ports"><div><strong>IN</strong>'+node.inputs.map(p=>'<span>'+esc(p.label)+' · '+esc(p.type)+'</span>').join("")+'</div><div><strong>OUT</strong>'+node.outputs.map(p=>'<span>'+esc(p.label)+' · '+esc(p.type)+'</span>').join("")+'</div></div></article>';
}
function renderEdges(){
 return state.graph?.edges.map(edge=>'<div class="wf-edge-row"><span>'+esc(state.graph?.nodes.find(n=>n.id===edge.sourceNodeId)?.label||edge.sourceNodeId)+' / '+esc(edge.sourcePortId)+' → '+esc(state.graph?.nodes.find(n=>n.id===edge.targetNodeId)?.label||edge.targetNodeId)+' / '+esc(edge.targetPortId)+'</span><button data-wf-remove-edge="'+esc(edge.id)+'">Remove</button></div>').join("")||'<div class="empty">No connections yet.</div>';
}
function renderGraphSvg(){
 if(!state.graph)return "";
 const paths=state.graph.edges.map(edge=>{
  const source=state.graph!.nodes.find(n=>n.id===edge.sourceNodeId),target=state.graph!.nodes.find(n=>n.id===edge.targetNodeId);
  if(!source||!target)return "";
  const s=source.position||{x:30,y:30},t=target.position||{x:30,y:30};
  const x1=s.x+238,y1=s.y+92,x2=t.x,y2=t.y+92,curve=Math.max(40,Math.abs(x2-x1)*.45);
  return '<path d="M '+x1+' '+y1+' C '+(x1+curve)+' '+y1+', '+(x2-curve)+' '+y2+', '+x2+' '+y2+'" />';
 }).join("");
 return '<svg class="wf-links" width="1400" height="900" viewBox="0 0 1400 900">'+paths+'</svg>';
}
function renderCanvas(){
 if(!state.graph)return '<div class="empty">'+esc(state.message)+'</div>';
 return '<div class="wf-canvas-scroll"><div id="wf-canvas" class="wf-canvas">'+renderGraphSvg()+state.graph.nodes.map(renderNode).join("")+'</div></div>';
}
function renderVideoCostEstimate(){
 const quote=state.costEstimate;
 if(!quote)return '<section class="wf-cost-estimate"><b>Cost preflight</b><p>Configure an exact provider, model and duration, then estimate against a current source-attributed pricing schedule. This check never submits a generation job or reserves credits.</p></section>';
 if(!quote.available)return '<section class="wf-cost-estimate is-unavailable"><b>Estimate unavailable</b><p>'+esc(quote.reason||"No verified pricing is available for this configuration.")+'</p></section>';
 const breakdown=quote.breakdown||{video:0,audio:0,references:0,minimumApplied:0};
 return '<section class="wf-cost-estimate"><div class="wf-cost-heading"><b>Estimated generation cost</b><strong>'+esc(Number(quote.amount||0).toFixed(4))+' '+esc(quote.currency||"")+'</strong></div><p>'+esc(quote.provider||"")+' · '+esc(quote.model||"")+' · '+esc(String(quote.billableSeconds||0))+' billable seconds</p><dl><div><dt>Video</dt><dd>'+esc(breakdown.video.toFixed(4))+'</dd></div><div><dt>Audio</dt><dd>'+esc(breakdown.audio.toFixed(4))+'</dd></div><div><dt>References</dt><dd>'+esc(breakdown.references.toFixed(4))+'</dd></div><div><dt>Minimum applied</dt><dd>'+esc(breakdown.minimumApplied.toFixed(4))+'</dd></div></dl><small>Source: <a href="'+esc(quote.pricing?.sourceUrl||"#")+'" target="_blank" rel="noopener noreferrer">pricing schedule</a> · observed '+esc(quote.pricing?.observedAt||"")+' · expires '+esc(quote.pricing?.expiresAt||"")+'</small><p class="wf-cost-disclaimer">'+esc(quote.disclaimer||"Estimate only; the provider invoice is authoritative.")+'</p></section>';
}
export function renderWorkflowWorkspace(){
 const nodes=state.graph?.nodes||[];
 const selected=nodes.find(n=>n.id===state.selectedNode)||nodes[0];
 return '<div id="workflow-workspace"><div class="wf-toolbar"><span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="ready"?"WORKFLOW SAVED":state.status==="auth"?"SIGN IN REQUIRED":state.status==="offline"?"API OFFLINE":"LOADING")+'</span><select id="wf-select">'+options(state.workflows.map(w=>({id:w.id,label:w.name+" · r"+w.revision})),state.graph?.id||"")+'</select><button class="secondary" data-wf-action="new">＋ New workflow</button><button class="secondary" data-wf-action="validate">Validate</button><button class="secondary" data-wf-action="plan">Preview run</button><button class="primary" data-wf-action="run">Run local workflow</button><button class="primary" data-wf-action="save">Save version</button></div>'+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+
 '<div class="wf-layout"><aside class="panel wf-palette"><div class="eyebrow">NODE PALETTE</div><h3>Build a workflow</h3><p>Drag nodes into the canvas, position them, then connect typed ports.</p>'+Object.entries(palette).map(([key,value])=>'<button data-wf-add="'+key+'">＋ '+esc(value.label)+'</button>').join("")+'</aside>'+
 '<section class="panel wf-main"><div class="wf-canvas-heading"><div><div class="eyebrow">VISUAL NODE GRAPH</div><h3>'+(state.graph?esc(state.graph.name||"Untitled workflow"):"Workflow")+'</h3></div><span>'+nodes.length+' nodes · '+(state.graph?.edges.length||0)+' connections</span></div>'+renderCanvas()+
 '<div class="wf-connection"><div class="eyebrow">CONNECT NODES</div><form id="wf-connect-form"><label>Source node</label><select name="sourceNode">'+options(nodes.map(n=>({id:n.id,label:n.label+" · "+n.id.slice(0,6)})))+'</select><label>Output port</label><select name="sourcePort">'+portOptions(nodes[0],"outputs")+'</select><label>Target node</label><select name="targetNode">'+options(nodes.map(n=>({id:n.id,label:n.label+" · "+n.id.slice(0,6)})))+'</select><label>Input port</label><select name="targetPort">'+portOptions(nodes[0],"inputs")+'</select><button class="secondary">＋ Connect ports</button></form><div class="wf-edge-list">'+renderEdges()+'</div></div></section>'+
 '<aside class="panel wf-inspector"><div class="eyebrow">NODE INSPECTOR</div><h3>Configuration</h3>'+(selected?'<form id="wf-config-form"><input type="hidden" name="nodeId" value="'+esc(selected.id)+'"><label>Node label</label><input name="label" value="'+esc(selected.label)+'" maxlength="120">'+(selected.kind==="voice.translate"?'<label>Target language</label><input name="targetLanguage" maxlength="48" value="'+esc(selected.config.targetLanguage||"")+'" placeholder="e.g. Lango, English, Swahili" required>':"")+'<label>Node configuration (JSON)</label><textarea name="config" rows="9">'+esc(JSON.stringify(selected.config,null,2))+'</textarea>'+(selected.kind==="video.generate"?'<p>Image-to-video: connect a JPEG, PNG or WebP asset to the Start Frame port. The server must set FAL_VIDEO_IMAGE_INPUT_FIELD to the exact input field documented by the selected model. For saved shot continuity, add a shotId to node configuration.</p>':selected.kind==="image.generate"?'<p>Reference-conditioned image generation: optionally connect one private JPEG, PNG or WebP asset to Reference. Set FAL_IMAGE_REFERENCE_FIELD only to the exact field documented by the configured model. For saved shot continuity, add a shotId to node configuration.</p>':"")+'<button class="secondary">Apply configuration</button>'+(selected.kind==="video.generate"?'<button type="button" class="secondary" data-wf-action="estimate-cost">Estimate generation cost</button>':"")+'</form>'+(selected.kind==="video.generate"?renderVideoCostEstimate():""):'<div class="empty">Select a node to configure it.</div>')+
 '<div class="wf-run-status">'+(state.latestRunId?'<div><b>Latest run</b> · '+esc(state.runStatus)+' <button data-wf-action="refresh-run">Refresh</button>'+(state.runStatus==="awaiting_approval"?'<button data-wf-action="approve">Approve step</button>':'')+'</div>'+state.runNodes.map(n=>'<span>'+esc(n.node_id)+' · '+esc(n.status)+(n.error?.message?' · '+esc(n.error.message):'')+'</span>').join(""):'No workflow runs yet.')+'</div><div class="wf-plan">'+(state.plan?'<pre>'+esc(state.plan)+'</pre>':'<p>Run planning uses registered local adapters only. Unsupported provider nodes are blocked; no paid provider calls are made.</p>')+'</div></aside></div></div>';
}
async function refresh(){
 const list=await apiRequest<{workflows:SavedWorkflow[]}>("/api/workflows");state.workflows=list.workflows;
 if(state.graph&&state.workflows.some(w=>w.id===state.graph?.id)){
  const current=await apiRequest<{workflow:SavedWorkflow}>("/api/workflows/"+state.graph.id);
  state.graph=current.workflow.graph||null;state.serverRevision=current.workflow.revision;
 }else if(state.workflows.length){
  const current=await apiRequest<{workflow:SavedWorkflow}>("/api/workflows/"+state.workflows[0].id);
  state.graph=current.workflow.graph||null;state.serverRevision=current.workflow.revision;
 }else{
  const graph=createEmptyWorkflow("","local-workflow");
  const created=await apiRequest<{workflow:SavedWorkflow}>("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Untitled workflow",graph})});
  state.graph=created.workflow.graph||graph;state.serverRevision=created.workflow.revision;
 }
 state.selectedNode=state.graph?.nodes[0]?.id||"";
 const runs=await apiRequest<{runs:Array<{id:string;status:string}>}>("/api/workflows/"+state.graph!.id+"/runs");
 state.latestRunId=runs.runs[0]?.id||"";
 if(state.latestRunId)await loadRun();else{state.runStatus="";state.runNodes=[];}
 state.status="ready";state.message="";
}
async function loadRun(){
 if(!state.latestRunId)return;
 const response=await apiRequest<{run:{status:string};nodes:WorkflowRunNode[]}>("/api/workflow-runs/"+state.latestRunId);
 state.runStatus=response.run.status;state.runNodes=response.nodes;
}
async function persist(){
 if(!state.graph)return;
 const result=await apiRequest<{revision:number}>("/api/workflows/"+state.graph.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:state.serverRevision,name:state.graph.name||"Untitled workflow",graph:state.graph})});
 state.serverRevision=result.revision;state.graph={...state.graph,revision:result.revision};state.status="ready";state.message="Saved workflow revision "+result.revision+".";
}
async function createNew(){
 const graph=createEmptyWorkflow("","local-workflow");
 const created=await apiRequest<{workflow:SavedWorkflow}>("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Untitled workflow",graph})});
 state.graph=created.workflow.graph||graph;state.serverRevision=created.workflow.revision;state.workflows.unshift(created.workflow);state.selectedNode="";state.plan="";state.costEstimate=null;state.latestRunId="";state.runStatus="";state.runNodes=[];state.message="New workflow created.";paint();
}
export async function initWorkflowWorkspace(){
 try{await refresh();}catch(error){state.status=error instanceof Error&&error.message.includes("Sign in")?"auth":"offline";state.message=error instanceof Error?error.message:"Workflow service unavailable.";}
 paint();
}
function paint(){const root=document.querySelector<HTMLElement>("#workflow-workspace");if(root)root.outerHTML=renderWorkflowWorkspace();}
async function action(actionName:string){
 if(actionName==="new"){await createNew();return;}
 if(actionName==="refresh-run"){await loadRun();paint();return;}
 if(actionName==="approve"){if(!state.latestRunId)return;const result=await apiRequest<{status:string}>("/api/workflow-runs/"+state.latestRunId+"/approve",{method:"POST"});state.runStatus=result.status;await loadRun();window.dispatchEvent(new Event("ev:jobs-updated"));paint();return;}
 if(!state.graph)return;
 if(actionName==="estimate-cost"){
  const node=state.graph.nodes.find(item=>item.id===state.selectedNode)||state.graph.nodes.find(item=>item.kind==="video.generate");
  if(!node||node.kind!=="video.generate"){state.message="Select a video-generation node before estimating cost.";paint();return;}
  const config=node.config||{};
  try{
   state.costEstimate=await apiRequest<VideoCostEstimate>("/api/video-cost-estimate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:String(config.provider||""),model:String(config.model||""),durationSeconds:Number(config.durationSeconds),resolution:String(config.resolution||"provider_default"),audioMode:String(config.audioMode||"provider_default"),referenceImageCount:Number(config.referenceImageCount??0)})});
   state.message=state.costEstimate.available?"Read-only estimate calculated. No provider request or charge was made.":state.costEstimate.reason||"A verified estimate is unavailable.";
  }catch(error){state.costEstimate={available:false,estimated:false,reason:error instanceof Error?error.message:"Cost estimation request failed."};state.message="Cost preflight could not be completed.";}
  paint();return;
 }
 if(actionName==="save"){await persist();paint();return;}
 if(actionName==="run"){await persist();const result=await apiRequest<{runId:string;status:string}>("/api/workflows/"+state.graph.id+"/run",{method:"POST"});state.latestRunId=result.runId;state.runStatus=result.status;await loadRun();window.dispatchEvent(new Event("ev:jobs-updated"));state.message="Workflow run queued. Only registered local adapters execute; unsupported provider nodes are blocked.";paint();return;}
 if(actionName==="validate"||actionName==="plan"){
  const validation=validateWorkflow(state.graph),plan=planWorkflowExecution(state.graph,{kind:"all"});
  state.plan=validation.valid&&plan.valid
   ?"VALID · "+plan.executionOrder.length+" nodes\n\n"+plan.executionOrder.map((id,i)=>(i+1)+". "+(state.graph?.nodes.find(n=>n.id===id)?.label||id)).join("\n")+(plan.reusedNodeIds.length?"\n\nREUSED OUTPUTS\n"+plan.reusedNodeIds.join(", "):"")+(plan.runNodeIds.length?"\n\nPLANNED NODES\n"+plan.runNodeIds.join(", "):"")+(actionName==="plan"?"\n\nPlanning only · no provider calls":"")
   :"BLOCKED\n"+[...validation.issues,...plan.issues].map(issue=>issue.code+": "+issue.message).join("\n");
  paint();return;
 }
}
document.addEventListener("click",event=>{
 const target=event.target as HTMLElement;
 const actionButton=target.closest<HTMLElement>("[data-wf-action]");if(actionButton){void action(actionButton.dataset.wfAction||"");return;}
 const add=target.closest<HTMLElement>("[data-wf-add]");if(add){addNode(add.dataset.wfAdd as keyof typeof palette);return;}
 const removeNode=target.closest<HTMLElement>("[data-wf-remove-node]");
 if(removeNode&&state.graph){const id=removeNode.dataset.wfRemoveNode||"";state.graph={...state.graph,revision:state.graph.revision+1,nodes:state.graph.nodes.filter(n=>n.id!==id),edges:state.graph.edges.filter(e=>e.sourceNodeId!==id&&e.targetNodeId!==id)};state.selectedNode="";state.plan="";void persist().then(paint).catch(error=>{state.message=error.message;paint();});return;}
 const removeEdge=target.closest<HTMLElement>("[data-wf-remove-edge]");
 if(removeEdge&&state.graph){const id=removeEdge.dataset.wfRemoveEdge||"";state.graph={...state.graph,revision:state.graph.revision+1,edges:state.graph.edges.filter(e=>e.id!==id)};void persist().then(paint).catch(error=>{state.message=error.message;paint();});return;}
 const node=target.closest<HTMLElement>("[data-wf-node]");
 if(node){state.selectedNode=node.dataset.wfNode||"";state.costEstimate=null;paint();}
});
document.addEventListener("submit",event=>{
 const form=event.target as HTMLFormElement;if(!state.graph)return;
 if(form.id==="wf-connect-form"){
  event.preventDefault();const data=new FormData(form),sourceNodeId=String(data.get("sourceNode")),sourcePortId=String(data.get("sourcePort")),targetNodeId=String(data.get("targetNode")),targetPortId=String(data.get("targetPort"));
  const edge:WorkflowEdge={id:crypto.randomUUID(),sourceNodeId,sourcePortId,targetNodeId,targetPortId};
  state.graph={...state.graph,revision:state.graph.revision+1,edges:[...state.graph.edges,edge]};state.plan="";void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="wf-config-form"){
  event.preventDefault();const data=new FormData(form),nodeId=String(data.get("nodeId")),node=state.graph.nodes.find(n=>n.id===nodeId);if(!node)return;
  try{const config=JSON.parse(String(data.get("config")||"{}"));if(!config||typeof config!=="object"||Array.isArray(config))throw new Error("Configuration must be a JSON object.");if(node.kind==="voice.translate"){const targetLanguage=String(data.get("targetLanguage")||"").trim();if(!targetLanguage)throw new Error("Choose a target language.");config.targetLanguage=targetLanguage;}node.label=String(data.get("label")||node.label).trim().slice(0,120);node.config=config;state.costEstimate=null;state.graph={...state.graph,revision:state.graph.revision+1};state.plan="";void persist().then(paint).catch(error=>{state.message=error.message;paint();});}
  catch(error){alert(error instanceof Error?error.message:String(error));}
 }
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLSelectElement;if(!state.graph)return;
 if(target.id==="wf-select"){void apiRequest<{workflow:SavedWorkflow}>("/api/workflows/"+target.value).then(response=>{state.graph=response.workflow.graph||null;state.serverRevision=response.workflow.revision;state.selectedNode=state.graph?.nodes[0]?.id||"";state.plan="";state.costEstimate=null;paint();}).catch(error=>alert(error.message||error));}
 if(target.name==="sourceNode"||target.name==="targetNode"){const form=target.closest("form");if(!form)return;const source=form.querySelector<HTMLSelectElement>('[name="sourceNode"]'),targetNode=form.querySelector<HTMLSelectElement>('[name="targetNode"]');const sourceNode=state.graph.nodes.find(n=>n.id===source?.value),dest=state.graph.nodes.find(n=>n.id===targetNode?.value);const sourcePort=form.querySelector<HTMLSelectElement>('[name="sourcePort"]'),targetPort=form.querySelector<HTMLSelectElement>('[name="targetPort"]');if(sourcePort)sourcePort.innerHTML=portOptions(sourceNode,"outputs");if(targetPort)targetPort.innerHTML=portOptions(dest,"inputs");}
});
document.addEventListener("dragstart",event=>{
 const target=event.target as HTMLElement,node=target.closest<HTMLElement>("[data-wf-node]");
 if(node&&event.dataTransfer){event.dataTransfer.setData("text/plain",node.dataset.wfNode||"");event.dataTransfer.effectAllowed="move";}
});
document.addEventListener("dragover",event=>{if((event.target as HTMLElement).closest("#wf-canvas"))event.preventDefault();});
document.addEventListener("drop",event=>{
 const canvas=(event.target as HTMLElement).closest<HTMLElement>("#wf-canvas");if(!canvas||!state.graph)return;
 event.preventDefault();const id=event.dataTransfer?.getData("text/plain")||"",node=state.graph.nodes.find(n=>n.id===id);if(!node)return;
 const rect=canvas.getBoundingClientRect(),x=Math.max(0,Math.round(event.clientX-rect.left)),y=Math.max(0,Math.round(event.clientY-rect.top));
 node.position={x,y};state.graph={...state.graph,revision:state.graph.revision+1};void persist().then(paint).catch(error=>{state.message=error.message;paint();});
});
window.addEventListener("ev:authenticated",()=>void initWorkflowWorkspace());
window.addEventListener("ev:jobs-updated",()=>{if(state.latestRunId)void loadRun().then(paint).catch(()=>{});});
