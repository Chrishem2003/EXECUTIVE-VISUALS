import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../server/db.mjs";
import { executeWorkflowRun, hasApprovedAncestor } from "../server/workflow-executor.mjs";


const approvalGraph={
 nodes:[
  {id:"brief",kind:"text"},
  {id:"gate",kind:"approval"},
  {id:"model",kind:"llm.prompt"}
 ],
 edges:[
  {id:"brief-gate",sourceNodeId:"brief",targetNodeId:"gate"},
  {id:"gate-model",sourceNodeId:"gate",targetNodeId:"model"}
 ]
};
assert.equal(hasApprovedAncestor(approvalGraph,"model",new Map()),false,
 "a model node must not run before its upstream approval is completed");
assert.equal(hasApprovedAncestor(approvalGraph,"model",new Map([["gate",{approved:false}]])),false,
 "an unapproved gate must not authorize model execution");
assert.equal(hasApprovedAncestor(approvalGraph,"model",new Map([["gate",{approved:true}]])),true,
 "a completed upstream approval authorizes the gated model node");
assert.equal(hasApprovedAncestor(approvalGraph,"brief",new Map([["gate",{approved:true}]])),false,
 "an approval node downstream cannot authorize an upstream model node");

const root=await mkdtemp(join(tmpdir(),"executive-visuals-workflow-"));
const mediaRoot=join(root,"media");await mkdir(join(mediaRoot,"uploads"),{recursive:true});
await writeFile(join(mediaRoot,"uploads","source.mp4"),"fixture");
const db=openDatabase(join(root,"workflow.sqlite"));
const now=new Date().toISOString();
function seedRun(id,graph){
 const snapshot=JSON.stringify(graph),workflowId="workflow-"+id,jobId="job-"+id;
 db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,revision,graph_json,graph_hash) VALUES(?,?,NULL,?,1,?,?)")
  .run(workflowId,"user-1","Test "+id,snapshot,"f".repeat(64));
 db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,NULL,1,? ,?,'queued',?)")
  .run(id,workflowId,"user-1","e".repeat(64),snapshot,jobId);
 for(const node of graph.nodes)db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("node-run-"+id+"-"+node.id,id,node.id);
 db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,? ,NULL,'workflow.execute','running',5,?)")
  .run(jobId,"user-1",json({runId:id}));
 return {id:jobId,owner_id:"user-1",project_id:null,job_type:"workflow.execute",input_json:json({runId:id})};
}
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("user-1","workflow@example.test");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("asset-1","user-1","source.mp4","video/mp4",7,"a".repeat(64),"uploads/source.mp4","{}");
 const simple={
  id:"simple",projectId:"",revision:1,nodes:[
   {id:"text",kind:"text",label:"Brief",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"A strong opening"}},
   {id:"merge",kind:"merge",label:"Merge",inputs:[{id:"items",type:"any",required:true,multiple:true}],outputs:[{id:"result",type:"any"}],config:{}}
  ],edges:[{id:"edge",sourceNodeId:"text",sourcePortId:"text",targetNodeId:"merge",targetPortId:"items"}]
 };
 const simpleJob=seedRun("run-simple",simple);
 const simpleResult=await executeWorkflowRun({db,job:simpleJob,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(simpleResult.status,"completed");
 assert.deepEqual(simpleResult.nodeOutputs.merge.result,["A strong opening"]);
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id=?").get("run-simple").status,"completed");

 const approval={
  id:"approval",projectId:"",revision:1,nodes:[
   {id:"source",kind:"upload",label:"Source asset",inputs:[],outputs:[{id:"media",type:"media"}],config:{assetId:"asset-1"}},
   {id:"gate",kind:"approval",label:"Human approval",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"media",type:"media"}],config:{}}
  ],edges:[{id:"gate-edge",sourceNodeId:"source",sourcePortId:"media",targetNodeId:"gate",targetPortId:"media"}]
 };
 const approvalJob=seedRun("run-approval",approval);
 const waiting=await executeWorkflowRun({db,job:approvalJob,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(waiting.status,"awaiting_approval");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id=? AND node_id='gate'").get("run-approval").status,"awaiting_approval");
 db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id='gate'")
  .run(json({media:"asset-1",approved:true}),now,"run-approval");
 db.prepare("UPDATE workflow_runs SET status='queued' WHERE id=?").run("run-approval");
 const resumedJob={...approvalJob,id:"job-approval-resumed"};
 db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,? ,NULL,'workflow.execute','running',5,?)")
  .run(resumedJob.id,"user-1",json({runId:"run-approval"}));
 const resumed=await executeWorkflowRun({db,job:resumedJob,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(resumed.status,"completed");
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id=?").get("run-approval").status,"completed");

 const provider={
  id:"provider",projectId:"",revision:1,nodes:[
   {id:"text",kind:"text",label:"Brief",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"Create a scene"}},
   {id:"gate",kind:"approval",label:"Approved gate",inputs:[],outputs:[{id:"approved",type:"any"}],config:{}},
   {id:"image",kind:"image.generate",label:"Image generation",inputs:[{id:"prompt",type:"text",required:true},{id:"approval",type:"any"}],outputs:[{id:"image",type:"image"}],config:{}}
  ],edges:[
   {id:"prompt-edge",sourceNodeId:"text",sourcePortId:"text",targetNodeId:"image",targetPortId:"prompt"},
   {id:"approval-edge",sourceNodeId:"gate",sourcePortId:"approved",targetNodeId:"image",targetPortId:"approval"}
  ]
 };
 const providerJob=seedRun("run-provider",provider);
 db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id='gate'")
  .run(json({approved:true}),now,"run-provider");
 await assert.rejects(()=>executeWorkflowRun({db,job:providerJob,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}}),/No local execution adapter/);
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id=?").get("run-provider").status,"blocked");
 assert.equal(db.prepare("SELECT status FROM workflow_node_runs WHERE run_id=? AND node_id='image'").get("run-provider").status,"blocked");
 console.log("Workflow executor checks passed: DAG data propagation, local node execution, human approval pause/resume and explicit blocking of unavailable provider nodes.");
}finally{db.close();await rm(root,{recursive:true,force:true});}
