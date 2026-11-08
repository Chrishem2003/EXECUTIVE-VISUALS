import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../db.mjs";
import { getLatestCreativeGraphSnapshot, saveCreativeGraphSnapshot } from "../creative-graph-snapshots.mjs";

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),"ev-graph-snapshot-"));
 const db=openDatabase(join(dir,"test.sqlite"));
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("owner","owner@example.test");
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run("project-1","owner","Review project");
 return db;
}
const graph={nodes:[{id:"project:project-1",type:"project",label:"Review project",status:"linked"},{id:"shot:shot-1",type:"shot",label:"Shot 1",detail:"Original direction",status:"linked"}],edges:[{from:"project:project-1",to:"shot:shot-1",relation:"contains",evidence:"project_scope"}]};

test("persists immutable graph baselines with monotonically increasing project revisions",async t=>{
 const db=await fixture(t);
 const first=saveCreativeGraphSnapshot(db,{projectId:"project-1",ownerId:"owner",graph});
 assert.equal(first.revision,1);
 assert.equal(getLatestCreativeGraphSnapshot(db,"project-1").graphHash,first.graphHash);
 const changed={...graph,nodes:graph.nodes.map(node=>node.id==="shot:shot-1"?{...node,detail:"Revised direction"}:node)};
 const second=saveCreativeGraphSnapshot(db,{projectId:"project-1",ownerId:"owner",graph:changed});
 assert.equal(second.revision,2);
 assert.notEqual(second.graphHash,first.graphHash);
 assert.equal(getLatestCreativeGraphSnapshot(db,"project-1").id,second.id);
 assert.equal(db.prepare("SELECT COUNT(*) AS count FROM creative_graph_snapshots WHERE project_id=?").get("project-1").count,2);
});

test("rejects a graph that does not contain the selected project node",async t=>{
 const db=await fixture(t);
 assert.throws(()=>saveCreativeGraphSnapshot(db,{projectId:"project-1",ownerId:"owner",graph:{...graph,nodes:[graph.nodes[1]],edges:[]}}),/CREATIVE_GRAPH_PROJECT_MISMATCH/);
});

test("rejects duplicate nodes and edges to unknown nodes",async t=>{
 const db=await fixture(t);
 assert.throws(()=>saveCreativeGraphSnapshot(db,{projectId:"project-1",ownerId:"owner",graph:{...graph,nodes:[...graph.nodes,graph.nodes[0]]}}),/CREATIVE_GRAPH_SNAPSHOT_INVALID/);
 assert.throws(()=>saveCreativeGraphSnapshot(db,{projectId:"project-1",ownerId:"owner",graph:{...graph,edges:[{from:"project:project-1",to:"shot:missing",relation:"contains",evidence:"explicit"}]}}),/CREATIVE_GRAPH_SNAPSHOT_INVALID/);
});

test("snapshot serialization omits absent optional fields so an unchanged graph compares identically",async t=>{
 const db=await fixture(t);
 const saved=saveCreativeGraphSnapshot(db,{projectId:"project-1",ownerId:"owner",graph});
 assert.equal(Object.hasOwn(saved.graph.nodes[0],"detail"),false);
 assert.equal(getLatestCreativeGraphSnapshot(db,"project-1").graph.nodes[0].detail,undefined);
});
