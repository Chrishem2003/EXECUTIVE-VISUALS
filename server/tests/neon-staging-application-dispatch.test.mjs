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
function fixture({status=local.status,allowed=true,registerError=null,jobs=null}={}){
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
  const runtime={backend:"neon-postgres",branch:"executive-visuals-staging",videoApprovals:{approvals:{
    async register(input){calls.push(["register",input]);if(registerError)throw registerError;return{
      id:input.id,ownerId:input.ownerId,projectId:input.projectId,requestHash:input.requestHash,
      currency:input.currency,quotedAmountMicros:input.quotedAmountMicros,
      budgetCeilingMicros:input.budgetCeilingMicros,status:"approved_pending_submission"
    };},
    async enqueue(id,ownerId){calls.push(["enqueue",id,ownerId]);return receipts;}
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
 assert.equal(f.calls.some(x=>x[0]==="run"),false);
 assert.equal(f.calls.filter(x=>x[0]==="enqueue").length,1);
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
