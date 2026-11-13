import { createHash, randomUUID } from "node:crypto";
import { json, parseJson } from "./db.mjs";

const NODE_TYPES=new Set(["project","brief","intent","evidence","evidence_candidate","character","world_record","scene","shot","timeline","clip","asset"]);
const RELATIONS=new Set(["contains","guides","supports","features","uses","appears_in","derived_from","evidence_for"]);
const STATUSES=new Set(["linked","needs_evidence","review"]);
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stable(value[key])).join(",")+"}":(JSON.stringify(value)??"null");

export function normalizeCreativeGraphSnapshot(graph,projectId){
 if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length<1||graph.nodes.length>1000||graph.edges.length>5000)throw new Error("CREATIVE_GRAPH_SNAPSHOT_INVALID");
 const nodes=[],nodeIds=new Set();
 for(const item of graph.nodes){
  if(!item||typeof item.id!=="string"||!item.id.trim()||item.id.length>240||!NODE_TYPES.has(item.type)||typeof item.label!=="string"||item.label.length>240||!STATUSES.has(item.status)||nodeIds.has(item.id))throw new Error("CREATIVE_GRAPH_SNAPSHOT_INVALID");
  nodeIds.add(item.id);
  nodes.push({id:item.id,type:item.type,label:item.label,...(typeof item.detail==="string"?{detail:item.detail.slice(0,2000)}:{}),status:item.status});
 }
 if(!nodeIds.has("project:"+projectId))throw new Error("CREATIVE_GRAPH_PROJECT_MISMATCH");
 const edges=[];
 for(const item of graph.edges){
  if(!item||!nodeIds.has(item.from)||!nodeIds.has(item.to)||!RELATIONS.has(item.relation)||!["explicit","project_scope"].includes(item.evidence))throw new Error("CREATIVE_GRAPH_SNAPSHOT_INVALID");
  edges.push({from:item.from,to:item.to,relation:item.relation,evidence:item.evidence});
 }
 return {nodes,edges};
}

export function saveCreativeGraphSnapshot(db,{projectId,ownerId,graph}){
 const normalized=normalizeCreativeGraphSnapshot(graph,projectId),graphJson=stable(normalized),graphHash=createHash("sha256").update(graphJson).digest("hex");
 db.exec("BEGIN IMMEDIATE");
 try{
  const revision=Number(db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM creative_graph_snapshots WHERE project_id=?").get(projectId).revision);
  const id=randomUUID();
  db.prepare("INSERT INTO creative_graph_snapshots(id,project_id,owner_id,revision,graph_hash,graph_json) VALUES(?,?,?,?,?,?)").run(id,projectId,ownerId,revision,graphHash,graphJson);
  db.exec("COMMIT");
  return {id,revision,graphHash,graph:normalized,createdAt:new Date().toISOString()};
 }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
}

export function getLatestCreativeGraphSnapshot(db,projectId){
 const row=db.prepare("SELECT id,revision,graph_hash,graph_json,created_at FROM creative_graph_snapshots WHERE project_id=? ORDER BY revision DESC LIMIT 1").get(projectId);
 return row?{id:row.id,revision:row.revision,graphHash:row.graph_hash,graph:parseJson(row.graph_json),createdAt:row.created_at}:null;
}
