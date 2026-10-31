import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../server/db.mjs";
import { executeWorkflowRun } from "../server/workflow-executor.mjs";

const envKeys=["AI_GATEWAY_ENABLED","AI_GATEWAY_URL","AI_GATEWAY_MODEL","AI_GATEWAY_API_KEY","AI_GATEWAY_TIMEOUT_MS"];
const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const restore=()=>envKeys.forEach(key=>saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key]);
const root=await mkdtemp(join(tmpdir(),"ev-ai-workflow-"));
const mediaRoot=join(root,"media");
const db=openDatabase(join(root,"ai-workflow.sqlite"));
let requests=0;
const gateway=createServer(async(req,res)=>{
 let body="";for await(const chunk of req)body+=chunk;
 requests++;
 assert.equal(req.url,"/v1/chat/completions");
 assert.equal(req.headers.authorization,"Bearer workflow-test-secret");
 const payload=JSON.parse(body);
 assert.equal(payload.model,"workflow-test-model");
 assert.equal(payload.messages.at(-1).content,"Write a short scene");
 res.writeHead(200,{"content-type":"application/json"});
 res.end(JSON.stringify({model:"workflow-test-model",choices:[{message:{content:"A tested scene."}}],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}}));
});
await new Promise(resolve=>gateway.listen(0,"127.0.0.1",resolve));
const address=gateway.address();
process.env.AI_GATEWAY_ENABLED="true";
process.env.AI_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";
process.env.AI_GATEWAY_MODEL="workflow-test-model";
process.env.AI_GATEWAY_API_KEY="workflow-test-secret";
process.env.AI_GATEWAY_TIMEOUT_MS="5000";

function seedRun(id,graph){
 const workflowId="workflow-"+id,jobId="job-"+id,snapshot=json(graph);
 db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,revision,graph_json,graph_hash) VALUES(?,?,NULL,?,1,?,?)")
  .run(workflowId,"ai-user","Test "+id,snapshot,"a".repeat(64));
 db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,NULL,1,?,?,'queued',?)")
  .run(id,workflowId,"ai-user","b".repeat(64),snapshot,jobId);
 for(const node of graph.nodes)db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("nr-"+id+"-"+node.id,id,node.id);
 db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,?,NULL,'workflow.execute','running',5,?)")
  .run(jobId,"ai-user",json({runId:id}));
 return {id:jobId,owner_id:"ai-user",project_id:null,job_type:"workflow.execute",input_json:json({runId:id})};
}
const graph={
 id:"approved-ai",projectId:"",revision:1,
 nodes:[
  {id:"brief",kind:"text",label:"Brief",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"Write a short scene"}},
  {id:"gate",kind:"approval",label:"Human approval",inputs:[{id:"input",type:"any",required:true}],outputs:[{id:"result",type:"any"},{id:"approved",type:"structured-data"}],config:{}},
  {id:"model",kind:"llm.prompt",label:"Text model",inputs:[{id:"prompt",type:"text",required:true}],outputs:[{id:"text",type:"text"}],config:{systemPrompt:"Write concise creative copy",maxTokens:128}}
 ],
 edges:[
  {id:"brief-gate",sourceNodeId:"brief",sourcePortId:"text",targetNodeId:"gate",targetPortId:"input"},
  {id:"gate-model",sourceNodeId:"gate",sourcePortId:"result",targetNodeId:"model",targetPortId:"prompt"}
 ]
};
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("ai-user","ai-workflow@example.test");
 const firstJob=seedRun("approved-run",graph);
 const paused=await executeWorkflowRun({db,job:firstJob,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(paused.status,"awaiting_approval");
 assert.equal(paused.waitingNodeId,"gate");
 assert.equal(requests,0,"no text request may occur before human approval");
 db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id='gate'")
  .run(json({result:"Write a short scene",approved:true,approvedBy:"ai-user"}),new Date().toISOString(),"approved-run");
 db.prepare("UPDATE workflow_runs SET status='queued' WHERE id='approved-run'").run();
 db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES('job-approved-resume','ai-user',NULL,'workflow.execute','running',5,?)")
  .run(json({runId:"approved-run"}));
 const resumed=await executeWorkflowRun({db,job:{...firstJob,id:"job-approved-resume"},mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 assert.equal(resumed.status,"completed");
 assert.equal(resumed.nodeOutputs.model.text,"A tested scene.");
 assert.equal(resumed.nodeOutputs.model.model,"workflow-test-model");
 assert.deepEqual(resumed.nodeOutputs.model.usage,{promptTokens:8,completionTokens:4,totalTokens:12});
 assert.equal(requests,1,"approved workflow must dispatch exactly one text request");

 const unapproved={
  id:"unapproved-ai",projectId:"",revision:1,
  nodes:[
   {id:"brief",kind:"text",label:"Brief",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"Write a short scene"}},
   {id:"model",kind:"llm.prompt",label:"Text model",inputs:[{id:"prompt",type:"text",required:true}],outputs:[{id:"text",type:"text"}],config:{}}
  ],
  edges:[{id:"brief-model",sourceNodeId:"brief",sourcePortId:"text",targetNodeId:"model",targetPortId:"prompt"}]
 };
 const blockedJob=seedRun("unapproved-run",unapproved);
 await assert.rejects(()=>executeWorkflowRun({db,job:blockedJob,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}}),error=>error.code==="APPROVAL_REQUIRED");
 assert.equal(db.prepare("SELECT status FROM workflow_runs WHERE id='unapproved-run'").get().status,"blocked");
 assert.equal(requests,1,"workflow without an approval ancestor must never reach the gateway");
 console.log("AI workflow integration passed: approval pause, reviewer-approved resume, one server-side text request, usage capture and fail-closed unapproved execution.");
}finally{
 restore();
 await new Promise(resolve=>gateway.close(resolve));
 db.close();
 await rm(root,{recursive:true,force:true});
}
