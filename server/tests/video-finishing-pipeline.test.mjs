import test from "node:test";
import assert from "node:assert/strict";
import {createVideoFinishingPipeline} from "../video-finishing-pipeline.mjs";

const source={id:"source-1",mediaType:"video/mp4",sha256:"a".repeat(64)};
const plan={pipelineId:"pipeline-1",sourceAsset:source,steps:[
 {id:"edit",kind:"transform",adapter:"edit-adapter",capability:"video.transform",remote:true,estimatedCostMicros:1200000,config:{prompt:"Replace the car"}},
 {id:"upscale",kind:"upscale",adapter:"upscale-adapter",capability:"video.upscale",remote:false,estimatedCostMicros:0,config:{resolution:"4k"}},
 {id:"audio",kind:"audio_finish",adapter:"audio-adapter",capability:"audio.finish",remote:false,estimatedCostMicros:0,config:{normalize:true}}
]};
function harness(){
 const store=new Map(),calls=[];
 const checkpoints={get:async(p,s)=>store.get(p+":"+s)||null,save:async record=>store.set(record.pipelineId+":"+record.stepId,record)};
 const adapters={
  "edit-adapter":{status:"ready",remote:true,capabilities:["video.transform"]},
  "upscale-adapter":{status:"ready",remote:false,capabilities:["video.upscale"]},
  "audio-adapter":{status:"ready",remote:false,capabilities:["audio.finish"]}
 };
 const pipeline=createVideoFinishingPipeline({
  resolveAdapter:async id=>adapters[id]||null,checkpoints,
  authorizeExecution:async({approvalId,adapterId,capability,requiredBudgetMicros})=>({approved:true,approvalId,adapterId,capability,approvedBudgetMicros:requiredBudgetMicros}),
  executeStep:async({step,sourceAsset,idempotencyKey})=>{
   calls.push({step:step.id,source:sourceAsset.id,idempotencyKey});
   return{id:step.id+"-output",mediaType:"video/mp4",sha256:String(calls.length).padStart(64,"0"),derivativeOf:sourceAsset.id};
  }
 });
 return{pipeline,calls,store};
}
const approval={remoteExecutionApproved:true,approvalId:"approval-42",approvedBudgetMicros:1200000};
test("preflights all costs and approvals before executing any step",async()=>{
 const {pipeline,calls}=harness();
 await assert.rejects(()=>pipeline.run(plan,{}),e=>e.code==="VIDEO_PIPELINE_APPROVAL_REQUIRED");
 await assert.rejects(()=>pipeline.run(plan,{...approval,approvedBudgetMicros:1}),e=>e.code==="VIDEO_PIPELINE_BUDGET_EXCEEDED");
 await assert.rejects(()=>pipeline.run({...plan,steps:plan.steps.map((s,i)=>i? s:{...s,estimatedCostMicros:null})},approval),e=>e.code==="VIDEO_PIPELINE_COST_UNKNOWN");
 assert.equal(calls.length,0);
});
test("runs edit then finishing steps with immutable derivative lineage",async()=>{
 const {pipeline,calls}=harness();
 const result=await pipeline.run(plan,approval);
 assert.equal(result.status,"completed");
 assert.equal(result.sourceAssetId,source.id);
 assert.equal(result.outputAsset.id,"audio-output");
 assert.deepEqual(calls.map(c=>c.step),["edit","upscale","audio"]);
 assert.deepEqual(calls.map(c=>c.source),["source-1","edit-output","upscale-output"]);
 assert.equal(result.totalEstimatedCostMicros,1200000);
});
test("resumes from durable successful checkpoints without rerunning paid steps",async()=>{
 const {pipeline,calls}=harness();
 await pipeline.run(plan,approval);
 const firstCount=calls.length;
 const result=await pipeline.run(plan,approval);
 assert.equal(calls.length,firstCount);
 assert.equal(result.steps.every(step=>step.status==="reused"),true);
});
test("rejects adapters that are disabled or do not declare exact capabilities",async()=>{
 const {pipeline,calls}=harness();
 await assert.rejects(()=>pipeline.run({...plan,steps:[{...plan.steps[0],capability:"video.face-swap"}]},approval),e=>e.code==="VIDEO_PIPELINE_ADAPTER_NOT_READY");
 assert.equal(calls.length,0);
});
test("rejects output receipts that do not point to the immediate parent asset",async()=>{
 const checkpoints={get:async()=>null,save:async()=>{}};
 const pipeline=createVideoFinishingPipeline({
  resolveAdapter:async()=>({status:"ready",remote:false,capabilities:["video.upscale"]}),
  checkpoints,
  executeStep:async()=>({id:"bad-output",mediaType:"video/mp4",sha256:"b".repeat(64),derivativeOf:"wrong-parent"})
 });
 await assert.rejects(()=>pipeline.run({pipelineId:"x",sourceAsset:source,steps:[{id:"s",kind:"upscale",adapter:"a",capability:"video.upscale",remote:false,estimatedCostMicros:0,config:{}}]},{}),e=>e.code==="VIDEO_PIPELINE_OUTPUT_INVALID");
});
test("rejects conflicting checkpoints when the source hash or settings change",async()=>{
 const {pipeline}=harness();
 await pipeline.run(plan,approval);
 const changed={...plan,steps:plan.steps.map((step,i)=>i?step:{...step,config:{prompt:"A different transformation"}})};
 await assert.rejects(()=>pipeline.run(changed,approval),e=>e.code==="VIDEO_PIPELINE_CHECKPOINT_CONFLICT");
});


test("remote pipeline refuses dispatch without live authorization callback",async()=>{
 const {pipeline,calls}=harness();
 const unguarded=createVideoFinishingPipeline({
  resolveAdapter:async()=>({status:"ready",remote:true,capabilities:["video.transform"]}),
  checkpoints:{get:async()=>null,save:async()=>{}},
  executeStep:async()=>{calls.push("provider-dispatch");return{};}
 });
 await assert.rejects(()=>unguarded.run({...plan,steps:[plan.steps[0]]},approval),e=>e.code==="VIDEO_PIPELINE_LIVE_AUTHORIZATION_REQUIRED");
 assert.equal(calls.length,0);
});

test("remote pipeline rechecks approval and budget before each remote provider call",async()=>{
 const calls=[];
 let authorizationCount=0;
 const twoRemote={...plan,steps:[
  {...plan.steps[0],id:"remote-one"},
  {...plan.steps[0],id:"remote-two",config:{prompt:"Second operation"}}
 ]};
 const pipeline=createVideoFinishingPipeline({
  resolveAdapter:async()=>({status:"ready",remote:true,capabilities:["video.transform"]}),
  checkpoints:{get:async()=>null,save:async()=>{}},
  authorizeExecution:async({approvalId,adapterId,capability,requiredBudgetMicros})=>{
   authorizationCount++;
   return authorizationCount===1
    ?{approved:true,approvalId,adapterId,capability,approvedBudgetMicros:requiredBudgetMicros}
    :{approved:false,approvalId,adapterId,capability,approvedBudgetMicros:requiredBudgetMicros};
  },
  executeStep:async({step,sourceAsset})=>{
   calls.push(step.id);
   return{id:step.id+"-output",mediaType:"video/mp4",sha256:String(calls.length).padStart(64,"0"),derivativeOf:sourceAsset.id};
  }
 });
 await assert.rejects(()=>pipeline.run(twoRemote,{...approval,approvedBudgetMicros:2400000}),e=>e.code==="VIDEO_PIPELINE_LIVE_AUTHORIZATION_DENIED");
 assert.deepEqual(calls,["remote-one"]);
 assert.equal(authorizationCount,2);
});
