import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.mjs";
import { executeWorkflowRun } from "../server/workflow-executor.mjs";

const root=await mkdtemp(join(tmpdir(),"executive-visuals-workflow-run-"));
const mediaRoot=join(root,"media");
await mkdir(join(mediaRoot,"uploads"),{recursive:true});
const db=openDatabase(join(root,"runtime.sqlite"));
const now=()=>new Date().toISOString();
const graph={
 id:"workflow-approval-test",projectId:"",revision:1,name:"Approval test",
 nodes:[
  {id:"source",kind:"upload",label:"Source",inputs:[],outputs:[{id:"asset",type:"asset"},{id:"media",type:"media"}],config:{assetId:"asset-1"},locked:true,lockedOutputIds:["asset-1"]},
  {id:"approval",kind:"approval",label:"Approval",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"media",type:"media"}],config:{}},
  {id:"export",kind:"export",label:"Export",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"deliverable",type:"asset"}],config:{}}
 ],
 edges:[
  {id:"source-approval",sourceNodeId:"source",sourcePortId:"media",targetNodeId:"approval",targetPortId:"media"},
  {id:"approval-export",sourceNodeId:"approval",sourcePortId:"media",targetNodeId:"export",targetPortId:"media"}
 ]
};
const plan={target:{kind:"node",nodeId:"export"},includedNodeIds:["source","approval","export"],executionOrder:["source","approval","export"],runNodeIds:["approval","export"],reusedNodeIds:["source"]};
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("workflow-user","workflow@example.test");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("asset-1","workflow-user","source.png","image/png",12,"a".repeat(64),"uploads/source.png","{}");
 db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,graph_json,graph_hash) VALUES(?,?,?,?,?,?)")
  .run("workflow-1","workflow-user",null,"Approval test",JSON.stringify(graph),"b".repeat(64));
 const snapshot={...graph,runPlan:plan};
 db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,?,?,?,?,'queued',?)")
  .run("run-1","workflow-1","workflow-user",null,1,"c".repeat(64),JSON.stringify(snapshot),"job-1");
 db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status,output_json) VALUES(?,?,?,?,?)")
  .run("node-run-source","run-1","source","skipped",JSON.stringify({lockedOutputIds:["asset-1"]}));
 for(const nodeId of ["approval","export"])db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("node-run-"+nodeId,"run-1",nodeId);
 db.prepare("INSERT INTO jobs(id,owner_id,job_type,status,progress,input_json) VALUES(?,?,?,'running',5,?)")
  .run("job-1","workflow-user","workflow.execute",JSON.stringify({runId:"run-1"}));
 const job={id:"job-1",owner_id:"workflow-user",project_id:null,job_type:"workflow.execute",input_json:JSON.stringify({runId:"run-1"})};
 const waiting=await executeWorkflowRun({db,job,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(waiting.status,"awaiting_approval");
 assert.equal(waiting.waitingNodeId,"approval");
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id='run-1'").get().status,"awaiting_approval");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-1' AND node_id='source'").get().status,"skipped");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-1' AND node_id='approval'").get().status,"awaiting_approval");

 const approvedOutput={media:"asset-1",approved:true,approvedBy:"workflow-user",approvedAt:now()};
 db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id=?")
  .run(JSON.stringify(approvedOutput),now(),"run-1","approval");
 db.prepare("UPDATE workflow_runs SET status='queued',updated_at=? WHERE id=?").run(now(),"run-1");
 const completed=await executeWorkflowRun({db,job,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(completed.status,"completed");
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id='run-1'").get().status,"completed");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-1' AND node_id='export'").get().status,"completed");
 const exportOutput=JSON.parse(db.prepare("SELECT output_json FROM workflow_node_runs WHERE run_id='run-1' AND node_id='export'").get().output_json);
 assert.equal(exportOutput.deliverable,"asset-1");

 const blockedGraph={id:"blocked-graph",projectId:"",revision:1,name:"Provider gate",nodes:[
  {id:"generate",kind:"image.generate",label:"Generate",inputs:[{id:"prompt",type:"text",required:true}],outputs:[{id:"image",type:"image"}],config:{prompt:"A test image"}}
 ],edges:[]};
 db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,graph_json,graph_hash) VALUES(?,?,?,?,?,?)")
  .run("workflow-2","workflow-user",null,"Provider gate",JSON.stringify(blockedGraph),"d".repeat(64));
 db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,?,?,?,'queued',?)")
  .run("run-2","workflow-2","workflow-user",1,"e".repeat(64),JSON.stringify({...blockedGraph,runPlan:{executionOrder:["generate"]}}),"job-2");
 db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("node-run-generate","run-2","generate");
 db.prepare("INSERT INTO jobs(id,owner_id,job_type,status,progress,input_json) VALUES(?,?,?,'running',5,?)")
  .run("job-2","workflow-user","workflow.execute",JSON.stringify({runId:"run-2"}));
 await assert.rejects(
  executeWorkflowRun({db,job:{...job,id:"job-2",input_json:JSON.stringify({runId:"run-2"})},mediaRoot,activeProcesses:new Map(),onProgress:()=>{}}),
  error=>error.code==="APPROVAL_REQUIRED"
 );
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id='run-2'").get().status,"blocked");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-2' AND node_id='generate'").get().status,"blocked");

 const branchGraph={id:"branch-graph",projectId:"",revision:1,name:"Conditional route",nodes:[
  {id:"input",kind:"text",label:"Input",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"publish"}},
  {id:"branch",kind:"branch",label:"Route",inputs:[{id:"input",type:"any",required:true}],outputs:[{id:"true",type:"any"},{id:"false",type:"any"}],config:{operator:"equals",compareTo:"publish"}},
  {id:"yes",kind:"merge",label:"True path",inputs:[{id:"items",type:"any",required:true,multiple:true}],outputs:[{id:"result",type:"any"}],config:{}},
  {id:"no",kind:"merge",label:"False path",inputs:[{id:"items",type:"any",required:true,multiple:true}],outputs:[{id:"result",type:"any"}],config:{}}
 ],edges:[
  {id:"input-branch",sourceNodeId:"input",sourcePortId:"text",targetNodeId:"branch",targetPortId:"input"},
  {id:"branch-yes",sourceNodeId:"branch",sourcePortId:"true",targetNodeId:"yes",targetPortId:"items"},
  {id:"branch-no",sourceNodeId:"branch",sourcePortId:"false",targetNodeId:"no",targetPortId:"items"}
 ]};
 db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,graph_json,graph_hash) VALUES(?,?,?,?,?,?)")
  .run("workflow-3","workflow-user",null,"Conditional route",JSON.stringify(branchGraph),"f".repeat(64));
 db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,?,?,?,'queued',?)")
  .run("run-3","workflow-3","workflow-user",1,"1".repeat(64),JSON.stringify({...branchGraph,runPlan:{executionOrder:["input","branch","yes","no"]}}),"job-3");
 for(const nodeId of ["input","branch","yes","no"])db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("node-run-"+nodeId,"run-3",nodeId);
 db.prepare("INSERT INTO jobs(id,owner_id,job_type,status,progress,input_json) VALUES(?,?,?,'running',5,?)")
  .run("job-3","workflow-user","workflow.execute",JSON.stringify({runId:"run-3"}));
 const branchResult=await executeWorkflowRun({db,job:{...job,id:"job-3",input_json:JSON.stringify({runId:"run-3"})},mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(branchResult.status,"completed");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-3' AND node_id='yes'").get().status,"completed");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id='run-3' AND node_id='no'").get().status,"skipped");
 const trueOutput=JSON.parse(db.prepare("SELECT output_json FROM workflow_node_runs WHERE run_id='run-3' AND node_id='yes'").get().output_json);
 assert.deepEqual(trueOutput.result,["publish"]);
 console.log("Workflow executor integration passed: locked output reuse, partial target execution, approval pause/resume, durable node history and safe blocking of unconnected generation adapters.");
}finally{
 db.close();
 await rm(root,{recursive:true,force:true});
}
