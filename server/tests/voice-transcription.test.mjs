import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../db.mjs";
import { executeWorkflowRun } from "../workflow-executor.mjs";

const keys=["VOICE_GATEWAY_ENABLED","VOICE_GATEWAY_URL","VOICE_GATEWAY_MODEL","VOICE_GATEWAY_API_KEY","VOICE_GATEWAY_TIMEOUT_MS","VOICE_GATEWAY_ALLOW_REMOTE","VOICE_TRANSCRIPTION_ENABLED","VOICE_TRANSCRIPTION_MODEL"];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
function restore(){for(const key of keys)saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key];}
const audio=Buffer.from([0xff,0xfb,0x90,0x64,0,0,0,0]);

test("approved transcription workflow verifies source audio and persists timestamped transcript output",async()=>{
 const server=createServer(async(req,res)=>{
  assert.equal(req.method,"POST");
  assert.equal(req.url,"/v1/audio/transcriptions");
  assert.match(req.headers["content-type"],/^multipart\/form-data; boundary=/);
  assert.equal(req.headers.authorization,"Bearer transcription-test-secret");
  let body=Buffer.alloc(0);for await(const chunk of req)body=Buffer.concat([body,chunk]);
  const form=body.toString("latin1");
  assert.match(form,/name="model"/);
  assert.match(form,/transcription-test-model/);
  assert.match(form,/name="file"; filename="source\.mp3"/);
  assert.ok(body.includes(audio));
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({text:"A clear transcript for the production timeline.",language:"en",duration:2.4,segments:[{start:0,end:2.4,text:"A clear transcript for the production timeline."}]}));
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const root=await mkdtemp(join(tmpdir(),"ev-transcription-")),mediaRoot=join(root,"media");
 await mkdir(join(mediaRoot,"uploads"),{recursive:true});
 await writeFile(join(mediaRoot,"uploads","source.mp3"),audio);
 const db=openDatabase(join(root,"transcription.sqlite"));
 try{
  const address=server.address();
  process.env.VOICE_GATEWAY_ENABLED="true";
  process.env.VOICE_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";
  process.env.VOICE_GATEWAY_MODEL="transcription-test-model";
  process.env.VOICE_GATEWAY_API_KEY="transcription-test-secret";
  process.env.VOICE_GATEWAY_TIMEOUT_MS="5000";
  process.env.VOICE_GATEWAY_ALLOW_REMOTE="false";
  process.env.VOICE_TRANSCRIPTION_ENABLED="true";
  process.env.VOICE_TRANSCRIPTION_MODEL="transcription-test-model";
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("transcribe-user","transcribe@example.test");
  db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
   .run("audio-asset","transcribe-user","source.mp3","audio/mpeg",audio.length,createHash("sha256").update(audio).digest("hex"),"uploads/source.mp3","{}");
  const graph={id:"transcription",projectId:"",revision:1,nodes:[
   {id:"source",kind:"upload",label:"Source audio",inputs:[],outputs:[{id:"audio",type:"audio"}],config:{assetId:"audio-asset"}},
   {id:"approval",kind:"approval",label:"Human approval",inputs:[{id:"audio",type:"audio"}],outputs:[{id:"approved",type:"any"}],config:{}},
   {id:"transcribe",kind:"voice.transcribe",label:"Transcribe audio",inputs:[{id:"audio",type:"audio",required:true}],outputs:[{id:"transcript",type:"transcript"},{id:"text",type:"text"}],config:{}}
  ],edges:[
   {id:"source-approval",sourceNodeId:"source",sourcePortId:"audio",targetNodeId:"approval",targetPortId:"audio"},
   {id:"source-transcribe",sourceNodeId:"source",sourcePortId:"audio",targetNodeId:"transcribe",targetPortId:"audio"},
   {id:"approval-transcribe",sourceNodeId:"approval",sourcePortId:"approved",targetNodeId:"transcribe",targetPortId:"approval"}
  ]};
  const snapshot=JSON.stringify(graph);
  db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,revision,graph_json,graph_hash) VALUES(?,?,NULL,?,1,?,?)").run("workflow-1","transcribe-user","Transcription",snapshot,"f".repeat(64));
  db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,NULL,1,?,?,'queued',?)").run("run-1","workflow-1","transcribe-user","e".repeat(64),snapshot,"job-1");
  for(const node of graph.nodes)db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status) VALUES(?,?,?,'pending')").run("nr-"+node.id,"run-1",node.id);
  db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id=?").run(json({audio:"audio-asset",asset:"audio-asset"}),new Date().toISOString(),"run-1","source");
  db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND node_id=?").run(json({approved:true}),new Date().toISOString(),"run-1","approval");
  db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,? ,NULL,'workflow.execute','running',5,?)").run("job-1","transcribe-user",json({runId:"run-1"}));
  const job={id:"job-1",owner_id:"transcribe-user",project_id:null,job_type:"workflow.execute",input_json:json({runId:"run-1"})};
  const result=await executeWorkflowRun({db,job,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
  assert.equal(result.status,"completed");
  const saved=db.prepare("SELECT status,output_json FROM workflow_node_runs WHERE run_id=? AND node_id=?").get("run-1","transcribe");
  assert.equal(saved.status,"completed");
  const output=JSON.parse(saved.output_json);
  assert.equal(output.transcript,"A clear transcript for the production timeline.");
  assert.equal(output.language,"en");
  assert.equal(output.duration,2.4);
  assert.equal(output.segments[0].start,0);
  assert.equal(output.sourceAssetId,"audio-asset");
 }finally{
  restore();db.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});
 }
});
