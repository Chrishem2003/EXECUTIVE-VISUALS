export type CreativeGraphNodeType = "project"|"brief"|"intent"|"evidence"|"character"|"scene"|"shot"|"timeline"|"clip"|"asset";
export interface CreativeGraphNode { id:string; type:CreativeGraphNodeType; label:string; detail?:string; status:"linked"|"needs_evidence"|"review"; }
export interface CreativeGraphEdge { from:string; to:string; relation:"contains"|"guides"|"supports"|"features"|"uses"|"appears_in"|"derived_from"; evidence:"explicit"|"project_scope"; }
export interface CreativeGraphInput {
 project?:{id:string;name:string;brief?:string};
 creativeDNA?:{creativePromise?:string;proofAndTrustChecks?:string[];storyBeats?:string[]};
 characters?:Array<{id:string;name:string;description?:string;referenceAssetIds?:string[]}>;
 shots?:Array<{id:string;scene?:string;action?:string;characterIds?:string[];proofReference?:string;referenceAssetIds?:string[]}>;
 seriesPlans?:Array<{id:string;title?:string;storyBible?:{entries?:Array<{id:string;kind:string;name:string;description?:string;referenceAssetIds?:string[]}>};seasons?:Array<{episodes?:Array<{id:string;title?:string;scenes?:Array<{id:string;title?:string;purpose?:string;shots?:Array<{id:string;prompt?:string;characterIds?:string[];proofReference?:string;referenceAssetIds?:string[]}>}>}>}>}>;
 timelines?:Array<{id:string;name:string;timeline?:{markers?:Array<{id:string;name?:string;note?:string}>;tracks?:Array<{clips?:Array<{id:string;assetId:string;name?:string;metadata?:Record<string,unknown>}>}>}}>;
 assets?:Array<{id:string;name:string;mediaType?:string}>;
}
export interface CreativeGraph { nodes:CreativeGraphNode[]; edges:CreativeGraphEdge[]; counts:Record<CreativeGraphNodeType,number>; unlinkedShots:string[]; notes:string[]; }
const clean=(value:unknown,max=500)=>typeof value==="string"?value.trim().replace(/\\s+/g," ").slice(0,max):"";
const key=(value:string)=>value.toLocaleLowerCase().replace(/\\s+/g," ").trim();
export function buildCreativeGraph(input:CreativeGraphInput):CreativeGraph{
 const nodes=new Map<string,CreativeGraphNode>(),edges:CreativeGraphEdge[]=[],edgeKeys=new Set<string>(),unlinkedShots:string[]=[];
 const add=(node:CreativeGraphNode)=>{if(!nodes.has(node.id))nodes.set(node.id,node);};
 const link=(from:string,to:string,relation:CreativeGraphEdge["relation"],evidence:CreativeGraphEdge["evidence"]="explicit")=>{if(!nodes.has(from)||!nodes.has(to)||from===to)return;const id=from+"|"+to+"|"+relation;if(!edgeKeys.has(id)){edgeKeys.add(id);edges.push({from,to,relation,evidence});}};
 const projectId=clean(input.project?.id,120),projectNode=projectId?"project:"+projectId:"";
 if(projectNode)add({id:projectNode,type:"project",label:clean(input.project?.name,160)||"Production",status:"linked"});
 const brief=clean(input.project?.brief,5000);
 const briefNode=brief?"brief:"+projectId:"";
 if(briefNode){add({id:briefNode,type:"brief",label:"Creative brief",detail:brief,status:"linked"});link(projectNode,briefNode,"contains","project_scope");}
 const promise=clean(input.creativeDNA?.creativePromise,500);
 const intentNode=promise?"intent:"+projectId:"";
 if(intentNode){add({id:intentNode,type:"intent",label:"Creative intent",detail:promise,status:"linked"});link(briefNode,intentNode,"guides");}
 const evidenceCandidates=(input.creativeDNA?.proofAndTrustChecks||[]).map(x=>clean(x,500)).filter(Boolean);
 const proofCandidate=evidenceCandidates.find(x=>/^proof candidate supplied:/i.test(x));
 if(proofCandidate){const id="evidence:"+projectId+":"+key(proofCandidate).slice(0,100);add({id,type:"evidence",label:"Proof candidate",detail:proofCandidate,status:"needs_evidence"});link(intentNode,id,"supports");}
 const assetIds=new Set<string>();
 for(const asset of input.assets||[]){const id=clean(asset.id,120);if(!id)continue;assetIds.add(id);add({id:"asset:"+id,type:"asset",label:clean(asset.name,180)||id,detail:clean(asset.mediaType,80),status:"linked"});if(projectNode)link(projectNode,"asset:"+id,"contains","project_scope");}
 const characterMap=new Map<string,string>();
 const addCharacter=(character:{id:string;name:string;description?:string;referenceAssetIds?:string[]})=>{const id=clean(character.id,120);if(!id)return;const nodeId="character:"+id;characterMap.set(id,nodeId);add({id:nodeId,type:"character",label:clean(character.name,160)||"Unnamed character",detail:clean(character.description,1000),status:"linked"});if(projectNode)link(projectNode,nodeId,"contains","project_scope");for(const assetId of character.referenceAssetIds||[]){const assetNode="asset:"+clean(assetId,120);if(nodes.has(assetNode))link(assetNode,nodeId,"features");}};
 for(const character of input.characters||[])addCharacter(character);
 for(const series of input.seriesPlans||[])for(const entry of series.storyBible?.entries||[])if(entry.kind==="character")addCharacter(entry);
 const shotIds=new Set<string>(),sceneByKey=new Map<string,string>();
 const addShot=(shot:{id:string;scene?:string;action?:string;characterIds?:string[];proofReference?:string;referenceAssetIds?:string[]},sceneNode?:string)=>{
  const id=clean(shot.id,120);if(!id||shotIds.has(id))return;shotIds.add(id);const nodeId="shot:"+id;
  add({id:nodeId,type:"shot",label:id,detail:clean(shot.action,600),status:"linked"});
  if(sceneNode)link(sceneNode,nodeId,"contains");
  else if(projectNode)link(projectNode,nodeId,"contains","project_scope");
  let linked=false;for(const characterId of shot.characterIds||[]){const target=characterMap.get(clean(characterId,120));if(target){link(target,nodeId,"features");linked=true;}}
  if((shot.characterIds||[]).length&&!linked)unlinkedShots.push(id);
  const proof=clean(shot.proofReference,200);if(proof){const proofNode="evidence-ref:"+key(proof).slice(0,120);add({id:proofNode,type:"evidence",label:"Shot evidence reference",detail:proof,status:"needs_evidence"});link(proofNode,nodeId,"supports");}
  for(const assetId of shot.referenceAssetIds||[]){const assetNode="asset:"+clean(assetId,120);if(nodes.has(assetNode))link(assetNode,nodeId,"features");}
 };
 for(const series of input.seriesPlans||[])for(const season of series.seasons||[])for(const episode of season.episodes||[])for(const scene of episode.scenes||[]){
  const sceneId=clean(scene.id,120);if(!sceneId)continue;const nodeId="scene:"+sceneId;
  add({id:nodeId,type:"scene",label:clean(scene.title,160)||sceneId,detail:clean(scene.purpose,500),status:"linked"});
  if(projectNode)link(projectNode,nodeId,"contains","project_scope");
  sceneByKey.set(key(scene.title||sceneId),nodeId);
  for(const shot of scene.shots||[])addShot(shot,nodeId);
 }
 for(const shot of input.shots||[]){const scene=clean(shot.scene,160),sceneNode=scene?sceneByKey.get(key(scene)):undefined;addShot(shot,sceneNode);}
 const timelineNodes=new Map<string,string>();
 for(const timeline of input.timelines||[]){
  const id=clean(timeline.id,120);if(!id)continue;const nodeId="timeline:"+id;timelineNodes.set(id,nodeId);
  add({id:nodeId,type:"timeline",label:clean(timeline.name,180)||"Editorial timeline",status:"linked"});
  if(projectNode)link(projectNode,nodeId,"contains","project_scope");
  for(const marker of timeline.timeline?.markers||[]){
   const target=shotIds.has(marker.id)?"shot:"+marker.id: nodes.has("scene:"+marker.id)?"scene:"+marker.id:"";
   if(target)link(target,nodeId,"appears_in");
  }
  for(const track of timeline.timeline?.tracks||[])for(const clip of track.clips||[]){
   const clipId=clean(clip.id,120);if(!clipId)continue;const clipNode="clip:"+clipId;
   add({id:clipNode,type:"clip",label:clean(clip.name,160)||"Timeline clip",detail:"Timeline "+clean(timeline.name,120),status:"linked"});
   link(clipNode,nodeId,"appears_in");
   const assetNode="asset:"+clean(clip.assetId,120);if(nodes.has(assetNode))link(assetNode,clipNode,"uses");
  }
 }
 const counts={} as Record<CreativeGraphNodeType,number>;
 for(const type of ["project","brief","intent","evidence","character","scene","shot","timeline","clip","asset"] as CreativeGraphNodeType[])counts[type]=[...nodes.values()].filter(n=>n.type===type).length;
 return {nodes:[...nodes.values()],edges,counts,unlinkedShots,notes:["Only explicit IDs and saved project membership create links. Shared project scope is labelled separately from authored relationships.","Proof candidates are not verified evidence. Missing references remain visible; no character-to-shot relationship is inferred from names or descriptions."]};
}
export function analyzeCreativeImpact(graph:CreativeGraph,changedNodeId:string){
 if(!graph.nodes.some(node=>node.id===changedNodeId))throw new Error("Choose a node that exists in the current creative graph.");
 const adjacency=new Map<string,string[]>();for(const edge of graph.edges){const list=adjacency.get(edge.from)||[];list.push(edge.to);adjacency.set(edge.from,list);}
 const visited=new Set<string>(),queue=[changedNodeId];while(queue.length){const current=queue.shift()!;for(const next of adjacency.get(current)||[])if(!visited.has(next)){visited.add(next);queue.push(next);}}
 visited.delete(changedNodeId);
 const nodes=graph.nodes.filter(node=>visited.has(node.id));
 return {changed:graph.nodes.find(node=>node.id===changedNodeId)!,impacted:nodes,impactedCount:nodes.length,requiresReview:nodes.filter(node=>["timeline","clip","shot"].includes(node.type)).map(node=>node.id),message:nodes.length?nodes.length+" downstream item(s) may need review. This is dependency-based impact, not an automatic edit or stale-state assertion.":"No downstream dependencies are recorded for this node."};
}
