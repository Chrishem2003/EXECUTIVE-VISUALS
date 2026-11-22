import test from "node:test";
import assert from "node:assert/strict";
import {createCloudVideoGenerationDispatch} from "../cloud-video-generation-dispatch.mjs";
const owner="123e4567-e89b-42d3-a456-426614174000";
const project="223e4567-e89b-42d3-a456-426614174000";
const approval="323e4567-e89b-42d3-a456-426614174000";
const jobs=[{jobId:"423e4567-e89b-42d3-a456-426614174000",shotIndex:0,status:"queued"},{jobId:"523e4567-e89b-42d3-a456-426614174000",shotIndex:1,status:"queued"}];
function fixture({status="approved_pending_submission",projectId=project,canWrite=true,registerResult=null,enqueueResult=jobs,registerError=null,enqueueError=null,cancelResult="default",cancelError=null,authorizeSubscription=null,requireSubscription=false,customerCreditSettlementReady=async()=>true}={}){
 const row={id:approval,owner_id:owner,project_id:projectId,idempotency_key:"approval-key-001",request_hash:"a".repeat(64),snapshot_json:JSON.stringify({shots:[{prompt:"Shot one",model:"seedance2_5",estimatedCostMicros:1000000},{prompt:"Shot two",model:"seedance2_5",estimatedCostMicros:1000000}]}),currency:"USD",quoted_amount_micros:2000000,budget_ceiling_micros:2500000,status};
 const calls=[],events=[];let localStatus=status;
 const db={prepare(sql){return{get(...args){calls.push(["get",sql,args]);return row;},run(...args){calls.push(["run",sql,args]);if(localStatus==="approved_pending_submission"){localStatus="consumed";return{changes:1};}return{changes:0};}}}};
 const repositories={approvals:{
  async register(input){calls.push(["register",input]);if(registerError)throw registerError;return registerResult||{id:approval,ownerId:owner,projectId,currency:"USD",requestHash:"a".repeat(64),quotedAmountMicros:2000000,budgetCeilingMicros:2500000,status:"approved_pending_submission"};},
  async enqueue(id,ownerIdArg){calls.push(["enqueue",id,ownerIdArg]);if(enqueueError)throw enqueueError;return enqueueResult;}
 }};
 const queue={async cancel(jobId,ownerIdArg){calls.push(["cancel",jobId,ownerIdArg]);if(cancelError)throw cancelError;return cancelResult==="default"?{id:jobId,owner_id:owner,status:"cancelled",job_type:"video.generate.shot",project_id:project}:cancelResult;}};
 const dispatch=createCloudVideoGenerationDispatch({db,repositories,queue,canWriteProject:(id,pid)=>canWrite&&id===owner&&pid===project,audit:(...args)=>events.push(args),authorizeSubscription,requireSubscription,customerCreditSettlementReady});
 return{dispatch,calls,events,get localStatus(){return localStatus;}};
}
test("dispatch mirrors approval and atomically enqueues each shot without provider execution",async()=>{
 const f=fixture();const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,202);assert.equal(result.body.jobs.length,2);assert.equal(result.body.providerRequestsSubmitted,false);
 assert.equal(f.localStatus,"consumed");assert.ok(f.calls.some(x=>x[0]==="register"));assert.ok(f.calls.some(x=>x[0]==="enqueue"));
 assert.equal(f.events.length,1);assert.equal(f.events[0][1],"video_generation.cloud_jobs_enqueued");
});
test("consumed local approvals safely replay the same cloud enqueue operation",async()=>{
 const f=fixture({status:"consumed"});const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,200);assert.equal(result.body.idempotentReplay,true);assert.equal(f.calls.filter(x=>x[0]==="enqueue").length,1);
});
test("dispatch refuses approvals without a cloud project or editor permission",async()=>{
 assert.equal((await fixture({projectId:null}).dispatch.submit({approvalId:approval,ownerId:owner})).status,422);
 assert.equal((await fixture({canWrite:false}).dispatch.submit({approvalId:approval,ownerId:owner})).status,404);
});
test("dispatch never submits a withdrawn or otherwise non-pending local approval",async()=>{
 const f=fixture({status:"withdrawn"});const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,409);assert.equal(f.calls.some(x=>x[0]==="register"),false);
});
test("dispatch fails closed when cloud registration conflicts with the local approval snapshot",async()=>{
 const f=fixture({registerResult:{id:approval,ownerId:owner,projectId:project,currency:"USD",requestHash:"b".repeat(64),quotedAmountMicros:2000000,budgetCeilingMicros:2500000,status:"approved_pending_submission"}});
 const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,502);assert.equal(f.calls.some(x=>x[0]==="enqueue"),false);
});
test("dispatch leaves local approval pending when cloud enqueue cannot be confirmed",async()=>{
 const f=fixture({enqueueError:Object.assign(new Error("unavailable"),{code:"VIDEO_REPOSITORY_TIMEOUT"})});
 const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,503);assert.equal(f.localStatus,"approved_pending_submission");
});
test("dispatch requires a complete and ordered queue receipt before consuming local approval",async()=>{
 const f=fixture({enqueueResult:[jobs[1]]});const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,502);assert.equal(f.localStatus,"approved_pending_submission");
});
test("dispatch rejects malformed identifiers and never trusts request-supplied owner IDs",async()=>{
 const f=fixture();assert.equal((await f.dispatch.submit({approvalId:"bad",ownerId:owner})).status,400);
 assert.equal((await f.dispatch.submit({approvalId:approval,ownerId:"not-an-id"})).status,400);
 assert.equal(f.calls.length,0);
});

test("cloud video job cancellation is owner-scoped and reports provider reconciliation as asynchronous",async()=>{
 const f=fixture();
 const result=await f.dispatch.cancelJob({jobId:jobs[0].jobId,ownerId:owner});
 assert.equal(result.status,202);
 assert.equal(result.body.job.status,"cancelled");
 assert.equal(result.body.providerCancellation,"requested");
 assert.ok(f.calls.some(x=>x[0]==="cancel"&&x[1]===jobs[0].jobId&&x[2]===owner));
});
test("cloud video job cancellation rejects foreign, missing and already-terminal jobs",async()=>{
 const f=fixture();
 assert.equal((await f.dispatch.cancelJob({jobId:"bad",ownerId:owner})).status,400);
 const missing=fixture({cancelResult:null});
 assert.equal((await missing.dispatch.cancelJob({jobId:jobs[0].jobId,ownerId:owner})).status,404);
 const terminal=fixture({cancelResult:{id:jobs[0].jobId,owner_id:owner,status:"succeeded",job_type:"video.generate.shot"}});
 assert.equal((await terminal.dispatch.cancelJob({jobId:jobs[0].jobId,ownerId:owner})).status,409);
 const unavailable=fixture({cancelError:new Error("network down")});
 assert.equal((await unavailable.dispatch.cancelJob({jobId:jobs[0].jobId,ownerId:owner})).status,503);
});


test("required subscription entitlement is checked before cloud approval registration and enqueue",async()=>{
 const authorized=fixture({requireSubscription:true,authorizeSubscription:async()=>({active:true,entitlements:{features:{videoGeneration:true}}})});
 const result=await authorized.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,202);
 assert.ok(authorized.calls.some(x=>x[0]==="register"));
 assert.ok(authorized.calls.some(x=>x[0]==="enqueue"));
});

test("missing or expired subscription blocks cloud video dispatch before any provider work",async()=>{
 const denied=fixture({requireSubscription:true,authorizeSubscription:async()=>({active:false,reason:"An active subscription is required."})});
 const result=await denied.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ENTITLEMENT_REQUIRED");
 assert.equal(denied.calls.some(x=>x[0]==="register"||x[0]==="enqueue"),false);
});

test("subscription lookup outages fail closed and preserve the local approval for retry",async()=>{
 const unavailable=fixture({requireSubscription:true,authorizeSubscription:async()=>{throw Object.assign(new Error("database unavailable"),{code:"SUBSCRIPTION_ENTITLEMENT_LOOKUP_UNAVAILABLE",status:503});}});
 const result=await unavailable.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,503);
 assert.equal(unavailable.localStatus,"approved_pending_submission");
 assert.equal(unavailable.calls.some(x=>x[0]==="register"||x[0]==="enqueue"),false);
});

test("subscription enforcement cannot be enabled without a trusted reader",()=>{
 assert.throws(()=>createCloudVideoGenerationDispatch({
  db:{prepare(){}},repositories:{approvals:{register(){},enqueue(){}}},canWriteProject:()=>true,requireSubscription:true
 }),/trusted server-side entitlement reader/);
});

test("idempotent replay does not re-query subscription or enqueue a second charge",async()=>{
 let checks=0;
 const replay=fixture({status:"consumed",requireSubscription:true,authorizeSubscription:async()=>{checks++;return {active:false};}});
 const result=await replay.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(checks,0);
 assert.equal(replay.calls.filter(x=>x[0]==="enqueue").length,1);
});

test("direct cloud shot queue fails closed without atomic customer credit settlement",async()=>{
 const {dispatch,calls}=fixture({customerCreditSettlementReady:null});
 const result=await dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,503);
 assert.equal(result.body.error.code,"VIDEO_CUSTOMER_CREDIT_SETTLEMENT_NOT_CONFIGURED");
 assert.equal(result.body.providerRequestsSubmitted,false);
 assert.equal(calls.some(call=>call[0]==="register"),false);
 assert.equal(calls.some(call=>call[0]==="enqueue"),false);
});
