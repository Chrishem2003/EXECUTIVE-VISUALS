import { executeMediaJob } from "./media.mjs";
import { getAccessibleAsset, json, parseJson } from "./db.mjs";
import { validateWorkflowGraph } from "./workflow-validation.mjs";

const now=()=>new Date().toISOString();
const inputAsset=(values,config)=>String(config.assetId||config.sourceAssetId||values.asset||values.media||values.video||values.image||values.audio||values.input||"");
const nodeOutput=(node,value)=>Object.fromEntries((node.outputs||[]).map((port,index)=>[port.id,index===0?value:undefined]).filter(([,v])=>v!==undefined));
function saveNode(db,runId,nodeId,status,{input={},output=null,error=null,attempt=0}={}){
 db.prepare("UPDATE workflow_node_runs SET status=?,attempt=?,input_json=?,output_json=?,error_json=?,completed_at=? WHERE run_id=? AND node_id=?")
  .run(status,attempt,json(input),output===null?null:json(output),error===null?null:json(error),["completed","failed","blocked","skipped"].includes(status)?now():null,runId,nodeId);
}
export async function executeWorkflowRun({db,job,mediaRoot,activeProcesses=new Map(),onProgress=()=>{}}){
 const input=parseJson(job.input_json),runId=String(input.runId||"");
 const run=db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(runId);
 if(!run)throw Object.assign(new Error("Workflow run not found."),{code:"WORKFLOW_RUN_NOT_FOUND"});
 const graph=parseJson(run.snapshot_json),validation=validateWorkflowGraph(graph);
 if(!validation.valid)throw Object.assign(new Error("Saved workflow snapshot failed validation."),{code:"WORKFLOW_INVALID",details:validation.issues});
 const executionOrder=Array.isArray(graph.runPlan?.executionOrder)?graph.runPlan.executionOrder:validation.executionOrder;
 db.prepare("UPDATE workflow_runs SET status='running',updated_at=? WHERE id=?").run(now(),runId);
 const stored=db.prepare("SELECT * FROM workflow_node_runs WHERE run_id=?").all(runId);
 const completed=new Map(stored.filter(row=>row.status==="completed").map(row=>[row.node_id,parseJson(row.output_json,{})]));
 const outputs=new Map(completed),nodeCount=Math.max(1,executionOrder.length);
 let completedCount=completed.size;
 for(const nodeId of executionOrder){
  const currentJob=db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id);
  if(currentJob?.status==="cancelled"){
   db.prepare("UPDATE workflow_runs SET status='cancelled',updated_at=?,completed_at=? WHERE id=?").run(now(),now(),runId);
   db.prepare("UPDATE workflow_node_runs SET status='skipped',completed_at=? WHERE run_id=? AND status='pending'").run(now(),runId);
   return {status:"cancelled",runId,completedNodes:completedCount,totalNodes:nodeCount};
  }
  const node=graph.nodes.find(item=>item.id===nodeId);if(!node)continue;
  if(outputs.has(nodeId))continue;
  if(node.locked&&(node.lockedOutputIds?.length||0)>0){
   const lockedOutput={};
   for(let index=0;index<(node.outputs||[]).length;index++){
    const assetId=String(node.lockedOutputIds[index]||"");
    if(!assetId)continue;
    const asset=getAccessibleAsset(db,job.owner_id,assetId,false);
    if(!asset)throw Object.assign(new Error("Locked output asset is missing or inaccessible: "+assetId),{code:"LOCKED_OUTPUT_MISSING"});
    lockedOutput[node.outputs[index].id]=asset.id;lockedOutput.asset=asset.id;lockedOutput.media=asset.id;
    if(asset.media_type.startsWith("image/"))lockedOutput.image=asset.id;
    if(asset.media_type.startsWith("video/"))lockedOutput.video=asset.id;
    if(asset.media_type.startsWith("audio/"))lockedOutput.audio=asset.id;
   }
   outputs.set(nodeId,lockedOutput);
   saveNode(db,runId,nodeId,"skipped",{input:{locked:true},output:lockedOutput,attempt:0});
   completedCount++;onProgress(Math.min(95,Math.round(completedCount/nodeCount*95)));
   continue;
  }
  const incomingEdges=graph.edges.filter(item=>item.targetNodeId===nodeId);
  const values={};
  for(const edge of incomingEdges){
   const upstream=outputs.get(edge.sourceNodeId)||{};
   if(upstream[edge.sourcePortId]!==undefined){
    const current=values[edge.targetPortId];
    values[edge.targetPortId]=current===undefined?upstream[edge.sourcePortId]:Array.isArray(current)?[...current,upstream[edge.sourcePortId]]:[current,upstream[edge.sourcePortId]];
   }
  }
  const config=node.config||{};
  const missingRequired=(node.inputs||[]).some(port=>{
   if(!port.required||Object.hasOwn(config,port.id))return false;
   const connected=incomingEdges.filter(edge=>edge.targetPortId===port.id);
   return connected.length>0&&!connected.some(edge=>(outputs.get(edge.sourceNodeId)||{})[edge.sourcePortId]!==undefined);
  });
  if(missingRequired){
   saveNode(db,runId,nodeId,"skipped",{input:values,output:{},attempt:0});
   completedCount++;onProgress(Math.min(95,Math.round(completedCount/nodeCount*95)));
   continue;
  }
  const nodeInput={...values,...config};
  const attempt=(stored.find(row=>row.node_id===nodeId)?.attempt||0)+1;
  saveNode(db,runId,nodeId,"running",{input:nodeInput,attempt});
  try{
   let output={};
   if(node.kind==="text"||node.kind==="prompt"){
    const text=String(config.text??config.prompt??config.value??"");
    output=nodeOutput(node,text);
   }else if(node.kind==="upload"||node.kind==="reference"){
    const assetId=inputAsset(values,config);
    const asset=assetId&&getAccessibleAsset(db,job.owner_id,assetId,false);
    if(!asset)throw Object.assign(new Error("Upload/reference node requires an accessible assetId in its configuration or incoming connection."),{code:"SOURCE_ASSET_NOT_FOUND"});
    output=nodeOutput(node,asset.id);output.asset=asset.id;output.media=asset.id;
    if(asset.media_type.startsWith("video/"))output.video=asset.id;
    if(asset.media_type.startsWith("image/"))output.image=asset.id;
    if(asset.media_type.startsWith("audio/"))output.audio=asset.id;
   }else if(node.kind==="merge"||node.kind==="batch"){
    const collected=Object.values(values).flat().filter(value=>value!==undefined);
    output=nodeOutput(node,collected);
   }else if(node.kind==="branch"){
    const left=values[config.field||"input"]??values.input??config.value??false;
    const right=config.compareTo;
    const operator=String(config.operator||"truthy");
    let condition=false;
    if(operator==="equals")condition=String(left)===String(right);
    else if(operator==="not-equals")condition=String(left)!==String(right);
    else if(operator==="contains")condition=String(left??"").includes(String(right??""));
    else if(operator==="greater-than")condition=Number(left)>Number(right);
    else if(operator==="less-than")condition=Number(left)<Number(right);
    else if(operator==="falsy")condition=!Boolean(left);
    else condition=Boolean(left);
    const payload=values.input??left;
    output=condition?{true:payload}:{false:payload};
   }else if(node.kind==="approval"){
    saveNode(db,runId,nodeId,"awaiting_approval",{input:nodeInput,attempt});
    db.prepare("UPDATE workflow_runs SET status='awaiting_approval',updated_at=? WHERE id=?").run(now(),runId);
    return {status:"awaiting_approval",runId,waitingNodeId:nodeId,completedNodes:completedCount,totalNodes:nodeCount};
   }else if(node.kind==="export"){
    const assetId=inputAsset(values,config);
    if(!assetId||!getAccessibleAsset(db,job.owner_id,assetId,false))throw Object.assign(new Error("Export node requires an accessible asset input."),{code:"SOURCE_ASSET_NOT_FOUND"});
    output=nodeOutput(node,assetId);output.asset=assetId;
   }else{
    let mediaType=null,mediaInput={};
    const sourceAssetId=inputAsset(values,config);
    if(["utility.frame-extract","video.extract-frame"].includes(node.kind)){
      mediaType="media.thumbnail";mediaInput={sourceAssetId,timecodeSeconds:Number(config.timecodeSeconds??1)};
    }else if(["utility.audio-extract","video.extract-audio"].includes(node.kind)){
      mediaType="media.audio_extract";mediaInput={sourceAssetId};
    }else if(["utility.convert","utility.compress","media.convert","media.compress"].includes(node.kind)){
      mediaType="media.transcode";mediaInput={sourceAssetId,outputFormat:String(config.outputFormat||"mp4"),preset:String(config.preset||"medium")};
    }else if(node.kind==="quality-check"){
      mediaType="media.probe";mediaInput={sourceAssetId};
    }else if(node.kind==="timeline"&&config.timelineId){
      mediaType="timeline.render";mediaInput={timelineId:String(config.timelineId)};
    }
    if(!mediaType)throw Object.assign(new Error("No local execution adapter is registered for node kind: "+node.kind),{code:"ENGINE_UNAVAILABLE"});
    if(mediaType!=="timeline.render"&&(!sourceAssetId||!getAccessibleAsset(db,job.owner_id,sourceAssetId,true)))throw Object.assign(new Error("Node input asset is missing or not editable."),{code:"SOURCE_ASSET_NOT_FOUND"});
    const result=await executeMediaJob({
      db,
      job:{...job,id:job.id,job_type:mediaType,input_json:json(mediaInput)},
      mediaRoot,activeProcesses,
      onProgress:value=>onProgress(Math.min(94,Math.round((completedCount+value/100)/nodeCount*100)))
    });
    if(result.outputAsset){
      const assetId=result.outputAsset.id;
      output=nodeOutput(node,assetId);output.asset=assetId;
      if(mediaType==="media.thumbnail")output.image=assetId;
      if(mediaType==="media.audio_extract")output.audio=assetId;
      if(mediaType==="media.transcode"||mediaType==="timeline.render")output.video=assetId;
    }else if(result.metadata){
      output=nodeOutput(node,result.metadata);output.report=result.metadata;
    }else output=nodeOutput(node,result);
   }
   outputs.set(nodeId,output);
   saveNode(db,runId,nodeId,"completed",{input:nodeInput,output,attempt});
   completedCount++;onProgress(Math.min(95,Math.round(completedCount/nodeCount*95)));
  }catch(error){
   const latestJob=db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id);
   if(latestJob?.status==="cancelled"){
    saveNode(db,runId,nodeId,"skipped",{input:nodeInput,attempt});
    db.prepare("UPDATE workflow_runs SET status='cancelled',updated_at=?,completed_at=? WHERE id=?").run(now(),now(),runId);
    return {status:"cancelled",runId,completedNodes:completedCount,totalNodes:nodeCount};
   }
   const detail={code:error.code||"NODE_FAILED",message:error.message||"Workflow node failed."};
   saveNode(db,runId,nodeId,detail.code==="ENGINE_UNAVAILABLE"?"blocked":"failed",{input:nodeInput,error:detail,attempt});
   const status=detail.code==="ENGINE_UNAVAILABLE"?"blocked":completedCount>0?"partial":"failed";
   db.prepare("UPDATE workflow_runs SET status=?,error_json=?,updated_at=?,completed_at=? WHERE id=?").run(status,json(detail),now(),now(),runId);
   throw Object.assign(new Error("Workflow stopped at node "+node.label+": "+detail.message),{code:detail.code});
  }
 }
 db.prepare("UPDATE workflow_runs SET status='completed',updated_at=?,completed_at=?,error_json=NULL WHERE id=?").run(now(),now(),runId);
 onProgress(100);
 return {status:"completed",runId,completedNodes:completedCount,totalNodes:nodeCount,nodeOutputs:Object.fromEntries(outputs)};
}
