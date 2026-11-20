import test from "node:test";
import assert from "node:assert/strict";
import {createNeonStagingApplicationDispatch} from "../neon-staging-application-dispatch.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="223e4567-e89b-42d3-a456-426614174000";
const approval="323e4567-e89b-42d3-a456-426614174000";
const job="423e4567-e89b-42d3-a456-426614174000";
const snapshot={shots:[
  {id:"shot-1",provider:"runway",model:"gen4.5",estimatedCostMicros:1250000},
  {id:"shot-2",provider:"runway",model:"gen4.5",estimatedCostMicros:750000}
],quote:{currency:"USD",amount:2}};
const local={
  id:approval,owner_id:owner,project_id:project,idempotency_key:"production-key-01",
  request_hash:"a".repeat(64),snapshot_json:JSON.stringify(snapshot),currency:"USD",
  quoted_amount_micros:2000000,budget_ceiling_micros:2500000,status:"approved_pending_submission"
};
function fixture({status=local.status,allowed=true,registerError=null,jobs=null,cancelReceipt={cancelled:true,status:"cancelled",balance:900,creditAdjustment:100,replayed:false,reason:"cancelled_before_submission"},jobStatus="queued"}={}){
  const calls=[];
  const row={...local,status};
  const db={prepare(sql){return{
    get(...values){calls.push(["get",sql,values]);return values[0]===approval&&values[1]===owner?row:null;},
    run(...values){calls.push(["run",sql,values]);if(sql.startsWith("UPDATE")){row.status="consumed";return{changes:status==="approved_pending_submission"?1:0};}return{changes:0};}
  };}};
  const receipts=jobs||[
    {jobId:job,shotIndex:0,status:"queued"},
    {jobId:"523e4567-e89b-42d3-a456-426614174000",shotIndex:1,status:"queued"}
  ];
  const runtime={backend:"neon-postgres",branch:"executive-visuals-staging",
   queue:{
    async getOwnedJob(id,ownerId){calls.push(["getOwnedJob",id,ownerId]);return id===job&&ownerId===owner?{id,ownerId,projectId:project,jobType:"video.generate",status:jobStatus}:null;},
    async cancelQueuedVideoJob(id,ownerId){calls.push(["cancelQueuedVideoJob",id,ownerId]);return cancelReceipt;}
   },
   videoApprovals:{approvals:{
    async register(input){calls.push(["register",input]);if(registerError)throw registerError;return{
      id:input.id,ownerId:input.ownerId,projectId:input.projectId,requestHash:input.requestHash,
      currency:input.currency,quotedAmountMicros:input.quotedAmountMicros,
      budgetCeilingMicros:input.budgetCeilingMicros,status:"approved_pending_submission"
    };},
    async enqueue(id,ownerId){calls.push(["enqueue",id,ownerId]);return receipts;},
    async enqueueWorkflowNode(input){calls.push(["enqueueWorkflowNode",input]);return{
      backend:"neon-postgres",approvalId:input.quoteId,jobId:job,status:"queued",idempotentReplay:false,providerRequestsSubmitted:false
    };}
  }}};
  const dispatch=createNeonStagingApplicationDispatch({db,runtime,canWriteProject:()=>allowed,audit:(...args)=>calls.push(["audit",...args])});
  return{dispatch,calls,row};
}

test("submits only a project-authorized immutable approval to Neon and marks it consumed after every shot is queued",async()=>{
 const f=fixture();const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,202);assert.equal(result.body.backend,"neon-postgres");
 assert.equal(result.body.jobs.length,2);assert.equal(result.body.providerRequestsSubmitted,false);
 assert.equal(f.row.status,"consumed");
 const registered=f.calls.find(x=>x[0]==="register")[1];
 assert.equal(registered.id,approval);assert.equal(registered.projectId,project);
 assert.equal(registered.quotedAmountMicros,2000000);
 assert.ok(f.calls.some(x=>x[0]==="audit"));
});

test("replays consumed approvals idempotently without reopening local approval state",async()=>{
 const f=fixture({status:"consumed"});const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,200);assert.equal(result.body.idempotentReplay,true);
 assert.equal(f.calls.some(x=>x[0]==="audit"),false);
 assert.equal(f.calls.filter(x=>x[0]==="enqueue").length,1);
 assert.equal(f.row.status,"consumed");
});

test("rejects missing project authorization without contacting Neon",async()=>{
 const f=fixture({allowed:false});const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,404);assert.equal(f.calls.some(x=>x[0]==="register"),false);
});

test("rejects owner mismatch and missing approvals",async()=>{
 const f=fixture();
 assert.equal((await f.dispatch.submit({approvalId:"not-a-uuid",ownerId:owner})).status,400);
 assert.equal((await f.dispatch.submit({approvalId:approval,ownerId:"523e4567-e89b-42d3-a456-426614174000"})).status,404);
 assert.equal(f.calls.some(x=>x[0]==="register"),false);
});

test("keeps the local approval pending when Neon registration fails",async()=>{
 const f=fixture({registerError:Object.assign(new Error("collision"),{code:"VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT"})});
 const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,409);assert.equal(f.row.status,"approved_pending_submission");
 assert.equal(result.body.providerRequestsSubmitted,false);
 assert.equal(f.calls.some(x=>x[0]==="run"),false);
});

test("does not consume a local approval unless every approved shot has a durable job receipt",async()=>{
 const f=fixture({jobs:[{jobId:job,shotIndex:0,status:"queued"}]});
 const result=await f.dispatch.submit({approvalId:approval,ownerId:owner});
 assert.equal(result.status,502);assert.equal(f.row.status,"approved_pending_submission");
});

test("fails closed on invalid Neon runtime composition",()=>{
 assert.throws(()=>createNeonStagingApplicationDispatch({db:{prepare(){}},runtime:{backend:"supabase"}}),/Neon staging dispatch requires/);
});

test("cancels only an owned project-authorized Neon job after the database proves no provider submission",async()=>{
 const f=fixture();
 const result=await f.dispatch.cancelJob({jobId:job,ownerId:owner});
 assert.equal(result.status,200);
 assert.deepEqual(result.body.job,{id:job,status:"cancelled"});
 assert.deepEqual(result.body.cancellation,{creditAdjustment:100,balance:900,replayed:false});
 assert.equal(result.body.providerCancellation,"not_required_no_submission");
 assert.ok(f.calls.some(x=>x[0]==="getOwnedJob"));
 assert.ok(f.calls.some(x=>x[0]==="cancelQueuedVideoJob"));
 assert.ok(f.calls.some(x=>x[0]==="audit"));
});

test("does not contact Neon cancellation when project write authorization is denied",async()=>{
 const f=fixture({allowed:false});
 const result=await f.dispatch.cancelJob({jobId:job,ownerId:owner});
 assert.equal(result.status,404);
 assert.equal(f.calls.some(x=>x[0]==="cancelQueuedVideoJob"),false);
});

test("refuses processing jobs and never claims provider termination or a refund",async()=>{
 const f=fixture({jobStatus:"processing",cancelReceipt:{cancelled:false,status:"processing",balance:0,creditAdjustment:0,replayed:false,reason:"provider_submission_possible"}});
 const result=await f.dispatch.cancelJob({jobId:job,ownerId:owner});
 assert.equal(result.status,409);
 assert.equal(result.body.job.status,"processing");
 assert.match(result.body.error.message,/may have started/);
 assert.equal(f.calls.some(x=>x[0]==="audit"),false);
});

test("rejects malformed and unowned cancellation requests",async()=>{
 const f=fixture();
 assert.equal((await f.dispatch.cancelJob({jobId:"bad",ownerId:owner})).status,400);
 assert.equal((await f.dispatch.cancelJob({jobId:"523e4567-e89b-42d3-a456-426614174000",ownerId:owner})).status,404);
 assert.equal(f.calls.some(x=>x[0]==="cancelQueuedVideoJob"),false);
});

test("returns a conflict when a submission record exists even without a provider task ID",async()=>{
 const f=fixture({cancelReceipt:{cancelled:false,status:"queued",balance:0,creditAdjustment:0,replayed:false,reason:"submission_record_exists"}});
 const result=await f.dispatch.cancelJob({jobId:job,ownerId:owner});
 assert.equal(result.status,409);
 assert.match(result.body.error.message,/provider reconciliation/);
 assert.equal(f.calls.some(x=>x[0]==="audit"),false);
});


test("submits one quote-bound workflow node through the Neon ledger after project authorization",async()=>{
 const f=fixture();
 const quote={quoteId:approval,ownerId:owner,projectId:project,requestId:"workflow-request-001",
  requestHash:"f".repeat(64),provider:"runway",model:"model-router",operation:"text-to-video",
  input:{prompt:"A cinematic sunrise"},estimatedAmount:1.25,approvedMaxAmount:2.5,
  expiresAt:new Date(Date.now()+60000).toISOString()};
 const result=await f.dispatch.submitWorkflowNode(quote);
 assert.equal(result.status,202);
 assert.equal(result.body.backend,"neon-postgres");
 assert.equal(result.body.job.id,job);
 assert.equal(result.body.providerRequestsSubmitted,false);
 assert.ok(f.calls.some(x=>x[0]==="enqueueWorkflowNode"&&x[1].requestHash===quote.requestHash));
 assert.ok(f.calls.some(x=>x[0]==="audit"&&x[1]==="workflow.video_generation.neon_job_enqueued"));
});

test("workflow-node dispatch rejects unauthorized projects before contacting the Neon queue",async()=>{
 const f=fixture({allowed:false});
 const result=await f.dispatch.submitWorkflowNode({quoteId:approval,ownerId:owner,projectId:project});
 assert.equal(result.status,404);
 assert.equal(f.calls.some(x=>x[0]==="enqueueWorkflowNode"),false);
});
