import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../db.mjs";
import { executeWorkflowRun } from "../workflow-executor.mjs";

const keys=["AI_GATEWAY_ENABLED","AI_GATEWAY_URL","AI_GATEWAY_MODEL","AI_GATEWAY_API_KEY","AI_GATEWAY_TIMEOUT_MS","AI_GATEWAY_ALLOW_REMOTE"];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
function restore(){for(const key of keys)saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key];}

test("approved caption translation preserves every source cue time and order",async()=>{
 const server=createServer(async(req,res)=>{
  assert.equal(req.method,"POST");assert.equal(req.url,"/v1/chat/completions");
  assert.equal(req.headers.authorization,"Bearer translate-test-secret");
  let body="";for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body);
  assert.equal(request.model,"translate-test-model");
  assert.match(request.messages[0].content,/do not add, remove or combine cues/i);
  const input=JSON.parse(request.messages[1].content);
  assert.equal(input.sourceLanguage,"en");assert.equal(input.targetLanguage,"Lango");
  assert.equal(input.segments.length,2);
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({model:"translate-test-model",choices:[{message:{content:JSON.stringify({segments:[{index:0,text:"Lok me kwo"},{index:1,text:"Apwoyo matek"}]})}}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}}));
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const root=await mkdtemp(join(tmpdir(),"ev-caption-translate-")),db=openDatabase(join(root,"runtime.sqlite"));
 try{
  const address=server.address();
  process.env.AI_GATEWAY_ENABLED="true";process.env.AI_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";
  process.env.AI_GATEWAY_MODEL="translate-test-model";process.env.AI_GATEWAY_API_KEY="translate-test-secret";
  process.env.AI_GATEWAY_TIMEOUT_MS="5000";process.env.AI_GATEWAY_ALLOW_REMOTE="false";
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("translate-user","translate@example.test");
  const graph={id:"translation",projectId:"",revision:1,nodes:[
   {id:"source",kind:"text",label:"Timed source cues",inputs:[],outputs:[{id:"segments",type:"structured-data"},{id:"language",type:"text"}],config:{}},
   {id:"approval",kind:"approval",label:"Human approval",inputs:[],outputs:[{id:"approved",type:"any"}],config:{}},
   {id:"translate",kind:"voice.translate",label:"Translate captions",inputs:[{id:"segments",type:"structured-data",required:true},{id:"approval",type:"any"},{id:"language",type:"text"}],outputs:[{id:"segments",type:"structured-data"},{id:"language",type:"text"}],config:{targetLanguage:"Lango"}}
  ],edges:[
   {id:"source-segments",sourceNodeId:"source",sourcePortId:"segments",targetNodeId:"translate",targetPortId:"segments"},
   {id:"source-language",sourceNodeId:"source",sourcePortId:"language",targetNodeId:"translate",targetPortId:"language"},
   {id:"approval-translation",sourceNodeId:"approval",sourcePortId:"approved",targetNodeId:"translate",targetPortId:"approval"}
  ]};
  const snapshot=JSON.stringify(graph);
  db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,revision,graph_json,graph_hash) VALUES(?,?,NULL,?,1,?,?)").run("workflow-translate","translate-user","Caption translation",snapshot,"f".repeat(64));
  db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,NULL,1,?,?,'queued',?)").run("run-translate","workflow-translate","translate-user","e".repeat(64),snapshot,"job-translate");
  for(const node of graph.nodes)db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("nr-"+node.id,"run-translate",node.id);
  const sourceOutput={segments:[{start:0,end:1.2,text:"Hello"},{start:1.4,end:2.7,text:"Thank you"}],language:"en"};
  db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id=?").run(json(sourceOutput),new Date().toISOString(),"run-translate","source");
  db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id=?").run(json({approved:true}),new Date().toISOString(),"run-translate","approval");
  db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,? ,NULL,'workflow.execute','running',5,?)").run("job-translate","translate-user",json({runId:"run-translate"}));
  const result=await executeWorkflowRun({db,job:{id:"job-translate",owner_id:"translate-user",project_id:null,job_type:"workflow.execute",input_json:json({runId:"run-translate"})},mediaRoot:join(root,"media"),activeProcesses:new Map(),onProgress:()=>{}});
  assert.equal(result.status,"completed");
  const row=db.prepare("SELECT status,output_json FROM workflow_node_runs WHERE run_id=? AND node_id=?").get("run-translate","translate");
  assert.equal(row.status,"completed");
  const output=JSON.parse(row.output_json);
  assert.deepEqual(output.segments,[{start:0,end:1.2,text:"Lok me kwo"},{start:1.4,end:2.7,text:"Apwoyo matek"}]);
  assert.equal(output.language,"Lango");assert.equal(output.usage.totalTokens,18);
 }finally{restore();db.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
