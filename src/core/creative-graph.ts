export type CreativeGraphNodeType = "project"|"brief"|"intent"|"evidence"|"evidence_candidate"|"character"|"scene"|"shot"|"timeline"|"clip"|"asset"|"world_record";
export interface CreativeGraphNode { id:string; type:CreativeGraphNodeType; label:string; detail?:string; status:"linked"|"needs_evidence"|"review"; }
export interface CreativeGraphEdge { from:string; to:string; relation:"contains"|"guides"|"supports"|"features"|"uses"|"appears_in"|"derived_from"|"evidence_for"; evidence:"explicit"|"project_scope"; }
export interface CreativeGraphInput {
 project?:{id:string;name:string;brief?:string};
 creativeDNA?:{creativePromise?:string;proofAndTrustChecks?:string[];storyBeats?:string[]};
 characters?:Array<{id:string;name:string;description?:string;referenceAssetIds?:string[]}>;
 shots?:Array<{id:string;scene?:string;action?:string;characterIds?:string[];storyBibleEntryIds?:string[];proofReference?:string;referenceAssetIds?:string[]}>;
 seriesPlans?:Array<{id:string;title?:string;storyBible?:{entries?:Array<{id:string;kind:string;name:string;description?:string;referenceAssetIds?:string[]}>};seasons?:Array<{episodes?:Array<{id:string;title?:string;scenes?:Array<{id:string;title?:string;purpose?:string;storyBibleEntryIds?:string[];shots?:Array<{id:string;prompt?:string;characterIds?:string[];storyBibleEntryIds?:string[];proofReference?:string;referenceAssetIds?:string[]}>}>}>}>}>;
 timelines?:Array<{id:string;name:string;timeline?:{markers?:Array<{id:string;name?:string;note?:string}>;tracks?:Array<{clips?:Array<{id:string;assetId:string;name?:string;metadata?:Record<string,unknown>}>}>}}>;
 assets?:Array<{id:string;name:string;mediaType?:string;sha256?:string;size?:number}>;
 evidenceRecords?:Array<{id:string;projectId?:string|null;sourceAssetId:string;sourceSha256:string;target:{type:string;id:string};kind:string;claim:string;status:string}>;
}
export interface CreativeGraph { nodes:CreativeGraphNode[]; edges:CreativeGraphEdge[]; counts:Record<CreativeGraphNodeType,number>; unlinkedShots:string[]; unlinkedEvidence:string[]; notes:string[]; }
const clean=(value:unknown,max=500)=>typeof value==="string"?value.trim().replace(/\s+/g," ").slice(0,max):"";
const key=(value:string)=>value.toLocaleLowerCase().replace(/\s+/g," ").trim();
export function buildCreativeGraph(input:CreativeGraphInput):CreativeGraph{
 const nodes=new Map<string,CreativeGraphNode>(),edges:CreativeGraphEdge[]=[],edgeKeys=new Set<string>(),unlinkedShots:string[]=[],unlinkedEvidence:string[]=[];
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
 if(proofCandidate){const id="evidence:"+projectId+":"+key(proofCandidate).slice(0,100);add({id,type:"evidence_candidate",label:"Proof candidate",detail:proofCandidate,status:"needs_evidence"});link(intentNode,id,"supports");}
 for(const asset of input.assets||[]){const id=clean(asset.id,120);if(!id)continue;add({id:"asset:"+id,type:"asset",label:clean(asset.name,180)||id,detail:[clean(asset.mediaType,80),asset.sha256?"SHA-256 "+asset.sha256.slice(0,16):"SHA-256 unavailable",Number.isSafeInteger(asset.size)?String(asset.size)+" bytes":""].filter(Boolean).join(" · "),status:"linked"});if(projectNode)link(projectNode,"asset:"+id,"contains","project_scope");}
 const characterMap=new Map<string,string>(),storyBibleMap=new Map<string,string>();
 const addCharacter=(character:{id:string;name:string;description?:string;referenceAssetIds?:string[]})=>{const id=clean(character.id,120);if(!id)return;const nodeId="character:"+id;characterMap.set(id,nodeId);add({id:nodeId,type:"character",label:clean(character.name,160)||"Unnamed character",detail:clean(character.description,1000),status:"linked"});if(projectNode)link(projectNode,nodeId,"contains","project_scope");if(intentNode)link(intentNode,nodeId,"guides","project_scope");for(const assetId of character.referenceAssetIds||[]){const assetNode="asset:"+clean(assetId,120);if(nodes.has(assetNode))link(assetNode,nodeId,"features");}};
 for(const character of input.characters||[])addCharacter(character);
 for(const series of input.seriesPlans||[])for(const entry of series.storyBible?.entries||[]){
  if(entry.kind==="character"){addCharacter(entry);storyBibleMap.set(entry.id,"character:"+entry.id);}
  else{const id=clean(entry.id,120);if(!id)continue;const nodeId="world-record:"+id;storyBibleMap.set(id,nodeId);add({id:nodeId,type:"world_record",label:clean(entry.name,160)||entry.kind,detail:clean(entry.description,1000),status:"linked"});if(projectNode)link(projectNode,nodeId,"contains","project_scope");if(intentNode)link(intentNode,nodeId,"guides","project_scope");for(const assetId of entry.referenceAssetIds||[]){const assetNode="asset:"+clean(assetId,120);if(nodes.has(assetNode))link(assetNode,nodeId,"features");}}
 }
 const shotIds=new Set<string>(),sceneByKey=new Map<string,string>();
 const addShot=(shot:{id:string;scene?:string;action?:string;prompt?:string;characterIds?:string[];storyBibleEntryIds?:string[];proofReference?:string;referenceAssetIds?:string[]},sceneNode?:string)=>{
  const id=clean(shot.id,120);if(!id||shotIds.has(id))return;shotIds.add(id);const nodeId="shot:"+id;
  add({id:nodeId,type:"shot",label:id,detail:clean(shot.action||shot.prompt,600),status:"linked"});
  if(sceneNode)link(sceneNode,nodeId,"contains");
  else if(projectNode)link(projectNode,nodeId,"contains","project_scope");
  const requestedCharacters=(shot.characterIds||[]).map(value=>clean(value,120)).filter(Boolean);
  for(const characterId of requestedCharacters){const target=characterMap.get(characterId);if(target)link(target,nodeId,"features");}
  const requestedBible=(shot.storyBibleEntryIds||[]).map(value=>clean(value,120)).filter(Boolean);
  for(const entryId of requestedBible){const target=storyBibleMap.get(entryId);if(target)link(target,nodeId,"features");}
  if(requestedCharacters.some(characterId=>!characterMap.has(characterId))||requestedBible.some(entryId=>!storyBibleMap.has(entryId)))unlinkedShots.push(id);
  const proof=clean(shot.proofReference,200);if(proof){const proofNode="evidence-ref:"+key(proof).slice(0,120);add({id:proofNode,type:"evidence_candidate",label:"Shot evidence reference",detail:proof,status:"needs_evidence"});link(proofNode,nodeId,"supports");}
  for(const assetId of shot.referenceAssetIds||[]){const assetNode="asset:"+clean(assetId,120);if(nodes.has(assetNode))link(assetNode,nodeId,"features");}
 };
 for(const series of input.seriesPlans||[])for(const season of series.seasons||[])for(const episode of season.episodes||[])for(const scene of episode.scenes||[]){
  const sceneId=clean(scene.id,120);if(!sceneId)continue;const nodeId="scene:"+sceneId;
  add({id:nodeId,type:"scene",label:clean(scene.title,160)||sceneId,detail:clean(scene.purpose,500),status:"linked"});
  if(projectNode)link(projectNode,nodeId,"contains","project_scope");
  if(intentNode)link(intentNode,nodeId,"guides","project_scope");
  for(const entryId of scene.storyBibleEntryIds||[]){const target=storyBibleMap.get(clean(entryId,120));if(target)link(target,nodeId,"features");else unlinkedShots.push("scene:"+sceneId);}
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
 const assetById=new Map((input.assets||[]).map(asset=>[clean(asset.id,120),asset]));
 for(const record of input.evidenceRecords||[]){
  const id=clean(record.id,120),sourceId=clean(record.sourceAssetId,120);
  if(!id||!sourceId)continue;
  const evidenceNode="evidence:"+id,sourceNode="asset:"+sourceId;
  const targetType=record.target?.type,targetId=clean(record.target?.id,120);
  const targetNode=targetType==="project"?"project:"+targetId:targetType==="scene"?"scene:"+targetId:targetType==="shot"?"shot:"+targetId:targetType==="timeline"?"timeline:"+targetId:targetType==="asset"?"asset:"+targetId:"";
  const sourceAsset=assetById.get(sourceId),hashMatches=Boolean(sourceAsset?.sha256&&record.sourceSha256&&sourceAsset.sha256.toLowerCase()===record.sourceSha256.toLowerCase());
  const sameProject=Boolean(projectId)&&record.projectId===projectId;
  const targetExists=Boolean(targetNode&&nodes.has(targetNode));
  const verified=record.status==="verified"&&hashMatches&&sameProject&&targetExists;
  add({id:evidenceNode,type:"evidence",label:clean(record.kind,100)||"Evidence record",detail:clean(record.claim,1000)+(hashMatches?"":" · Source asset hash mismatch or unavailable")+(sameProject?"":" · Project scope mismatch")+(targetExists?"":" · Target is unresolved"),status:verified?"linked":"review"});
  if(hashMatches&&sameProject&&nodes.has(sourceNode))link(sourceNode,evidenceNode,"derived_from");
  if(hashMatches&&sameProject&&targetExists)link(evidenceNode,targetNode,verified?"supports":"evidence_for");
  if(!hashMatches||!sameProject||!targetExists)unlinkedEvidence.push(id);
 }
 const counts={} as Record<CreativeGraphNodeType,number>;
 for(const type of ["project","brief","intent","evidence","evidence_candidate","character","world_record","scene","shot","timeline","clip","asset"] as CreativeGraphNodeType[])counts[type]=[...nodes.values()].filter(n=>n.type===type).length;
 return {nodes:[...nodes.values()],edges,counts,unlinkedShots,unlinkedEvidence,notes:["Only explicit IDs and saved project membership create links. Shared project scope is labelled separately from authored relationships.","Proof candidates are separate from submitted evidence. Only reviewer-verified records with matching source hashes and project scope create a supporting edge; other records remain review-only."]};
}
export function analyzeCreativeImpact(graph:CreativeGraph,changedNodeId:string){
 if(!graph.nodes.some(node=>node.id===changedNodeId))throw new Error("Choose a node that exists in the current creative graph.");
 const adjacency=new Map<string,string[]>();for(const edge of graph.edges){const list=adjacency.get(edge.from)||[];list.push(edge.to);adjacency.set(edge.from,list);}
 const visited=new Set<string>(),queue=[changedNodeId];while(queue.length){const current=queue.shift()!;for(const next of adjacency.get(current)||[])if(!visited.has(next)){visited.add(next);queue.push(next);}}
 visited.delete(changedNodeId);
 const nodes=graph.nodes.filter(node=>visited.has(node.id));
 return {changed:graph.nodes.find(node=>node.id===changedNodeId)!,impacted:nodes,impactedCount:nodes.length,requiresReview:nodes.filter(node=>["timeline","clip","shot"].includes(node.type)).map(node=>node.id),message:nodes.length?nodes.length+" downstream item(s) may need review. This is dependency-based impact, not an automatic edit or stale-state assertion.":"No downstream dependencies are recorded for this node."};
}

export interface CreativeGraphSnapshotComparison {
 changedNodes:CreativeGraphNode[];
 changedNodeIds:string[];
 addedNodeIds:string[];
 removedNodeIds:string[];
 potentiallyStale:CreativeGraphNode[];
 potentiallyStaleIds:string[];
}
const stable=(value:unknown):string=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value as Record<string,unknown>).sort().map(key=>JSON.stringify(key)+":"+stable((value as Record<string,unknown>)[key])).join(",")+"}":(JSON.stringify(value)??"null");
function nodeFingerprint(graph:Pick<CreativeGraph,"nodes"|"edges">,nodeId:string){
 const node=graph.nodes.find(item=>item.id===nodeId);
 const edges=graph.edges.filter(edge=>(edge.from===nodeId||edge.to===nodeId)&&edge.evidence==="explicit").map(edge=>({from:edge.from,to:edge.to,relation:edge.relation,evidence:edge.evidence})).sort((a,b)=>stable(a).localeCompare(stable(b)));
 return stable({node:node||null,edges});
}
/** Compare a saved human-review baseline with the current graph. This flags possible downstream staleness; it never mutates or invalidates production records. */
export function compareCreativeGraphSnapshot(current:CreativeGraph,baseline:Pick<CreativeGraph,"nodes"|"edges">):CreativeGraphSnapshotComparison{
 const currentIds=new Set(current.nodes.map(node=>node.id)),baselineIds=new Set(baseline.nodes.map(node=>node.id));
 const allIds=new Set([...currentIds,...baselineIds]),changedNodeIds:string[]=[],addedNodeIds:string[]=[],removedNodeIds:string[]=[];
 for(const id of allIds){
  const existsNow=currentIds.has(id),existed=baselineIds.has(id);
  if(existsNow&&!existed){addedNodeIds.push(id);changedNodeIds.push(id);}
  else if(!existsNow&&existed){removedNodeIds.push(id);changedNodeIds.push(id);}
  else if(nodeFingerprint(current,id)!==nodeFingerprint(baseline,id))changedNodeIds.push(id);
 }
 const changedNodes=changedNodeIds.map(id=>current.nodes.find(node=>node.id===id)||baseline.nodes.find(node=>node.id===id)!).filter(Boolean);
 const staleIds=new Set<string>();
 for(const id of changedNodeIds){
  const graph=currentIds.has(id)?current:baseline as CreativeGraph;
  const report=analyzeCreativeImpact(graph,id);
  for(const node of report.impacted)if(!changedNodeIds.includes(node.id))staleIds.add(node.id);
 }
 const potentiallyStale=[...current.nodes,...baseline.nodes].filter((node,index,all)=>staleIds.has(node.id)&&all.findIndex(item=>item.id===node.id)===index);
 return {changedNodes,changedNodeIds:changedNodeIds.sort(),addedNodeIds:addedNodeIds.sort(),removedNodeIds:removedNodeIds.sort(),potentiallyStale,potentiallyStaleIds:potentiallyStale.map(node=>node.id).sort()};
}
