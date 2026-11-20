import test from "node:test";
import assert from "node:assert/strict";
import {createNeonVideoGenerationRepositories} from "../neon-postgres-video-approvals.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="223e4567-e89b-42d3-a456-426614174000";
const approval="323e4567-e89b-42d3-a456-426614174000";
const budget="423e4567-e89b-42d3-a456-426614174000";
const job="523e4567-e89b-42d3-a456-426614174000";
const credit="623e4567-e89b-42d3-a456-426614174000";
const snapshot={shots:[{id:"shot-1",provider:"runway",model:"gen4.5",prompt:"Sunrise",estimatedCostMicros:1250000}]};
const base={id:approval,ownerId:owner,projectId:project,idempotencyKey:"approval-key-001",requestHash:"a".repeat(64),snapshotJson:snapshot,currency:"USD",quotedAmountMicros:1250000,budgetCeilingMicros:2000000};
function fixture({failAt=null,quoteCustomerCredits=()=>150}={}){
 const calls=[];let released=false;let storedApproval=null;let storedShots=[];
 const client={
  async query(sql,values=[]){
   calls.push({sql,values});
   if(sql==="begin"||sql==="commit"||sql==="rollback")return{rows:[]};
   if(sql.includes("insert into executive_visuals.video_generation_approvals")){
    storedApproval={id:values[0],owner_id:values[1],project_id:values[2],idempotency_key:values[3],request_hash:values[4],snapshot_json:JSON.parse(values[5]),currency:values[6],quoted_amount_micros:String(values[7]),budget_ceiling_micros:String(values[8]),status:"approved_pending_submission"};
    return{rows:[]};
   }
   if(sql.includes("select * from executive_visuals.video_generation_approvals where id="))return{rows:[storedApproval||{...base,id:approval,owner_id:owner,project_id:project,idempotency_key:base.idempotencyKey,request_hash:base.requestHash,snapshot_json:snapshot,currency:"USD",quoted_amount_micros:"1250000",budget_ceiling_micros:"2000000",status:"approved_pending_submission"}]};
   if(sql.includes("insert into executive_visuals.video_generation_approval_shots")){
    storedShots.push({approval_id:values[0],shot_index:values[1],owner_id:values[2],project_id:values[3],provider:values[4],model:values[5],request_hash:values[6],estimated_cost_micros:String(values[7]),reserved_credits:null,budget_approval_id:null});
    return{rows:[]};
   }
   if(sql.includes("select * from executive_visuals.video_generation_approval_shots"))return{rows:storedShots.length?storedShots:[{approval_id:approval,shot_index:0,owner_id:owner,project_id:project,provider:"runway",model:"gen4.5",request_hash:"b".repeat(64),estimated_cost_micros:"1250000",reserved_credits:null,budget_approval_id:null}]};
   if(sql.includes("insert into executive_visuals.video_generation_budget_approvals"))return{rows:[]};
   if(sql.includes("update executive_visuals.video_generation_approval_shots set reserved_credits"))return{rows:[]};
   if(sql.includes("enqueue_video_generation_job_v1")){if(failAt==="enqueue")throw new Error("insufficient credits");return{rows:[{job_id:job,job_status:"queued",idempotent_replay:false,budget_reservation_id:budget,credit_reservation_id:credit,available_credits:"850"}]};}
   if(sql.includes("update executive_visuals.video_generation_approval_shots set job_id"))return{rows:[]};
   if(sql.includes("update executive_visuals.video_generation_approvals set status"))return{rows:[]};
   throw new Error("Unexpected SQL: "+sql);
  },
  release(){released=true;}
 };
 const pool={async connect(){return client;},async query(){return{rows:[]};}};
 const videoEnqueue={async enqueueVideoGenerationJob(){throw new Error("bridge must use the transaction client");}};
 const repos=createNeonVideoGenerationRepositories({pool,videoEnqueue,quoteCustomerCredits});
 return{repos,calls,get released(){return released;}};
}

test("register mirrors the immutable owner/project-scoped approval and every priced shot",async()=>{
 const f=fixture();const row=await f.repos.approvals.register(base);
 assert.equal(row.id,approval);assert.equal(row.ownerId,owner);assert.equal(row.projectId,project);
 assert.ok(f.calls.some(x=>x.sql.includes("insert into executive_visuals.video_generation_approvals")));
 assert.ok(f.calls.some(x=>x.sql.includes("insert into executive_visuals.video_generation_approval_shots")));
 assert.equal(f.calls.at(-1).sql,"commit");assert.equal(f.released,true);
});

test("enqueue quotes credits server-side and atomically admits the approved shot",async()=>{
 const f=fixture();const jobs=await f.repos.approvals.enqueue(approval,owner);
 assert.deepEqual(jobs,[{jobId:job,shotIndex:0,status:"queued",idempotentReplay:false}]);
 const insert=f.calls.find(x=>x.sql.includes("insert into executive_visuals.video_generation_budget_approvals"));
 assert.ok(insert);assert.equal(insert.values[1],owner);assert.equal(insert.values[2],project);
 const enqueue=f.calls.find(x=>x.sql.includes("enqueue_video_generation_job_v1"));
 assert.equal(enqueue.values[0],owner);assert.equal(enqueue.values[1],project);
 assert.equal(enqueue.values[6],150);assert.equal(JSON.parse(enqueue.values[3]).provider,"runway");
 assert.equal(f.calls.at(-1).sql,"commit");
});

test("failed shot reservation rolls back the entire multi-shot transaction",async()=>{
 const f=fixture({failAt:"enqueue"});
 await assert.rejects(()=>f.repos.approvals.enqueue(approval,owner),/insufficient credits/);
 assert.ok(f.calls.some(x=>x.sql==="rollback"));assert.equal(f.calls.at(-1).sql,"rollback");
});

test("credit quote must be server-side, deterministic and bounded",async()=>{
 const f=fixture({quoteCustomerCredits:()=>0});
 await assert.rejects(()=>f.repos.approvals.enqueue(approval,owner),e=>e.code==="VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
 const asyncQuote=fixture({quoteCustomerCredits:()=>Promise.resolve(10)});
 await assert.rejects(()=>asyncQuote.repos.approvals.enqueue(approval,owner),/must be synchronous and deterministic/);
 assert.ok(f.released);
});

test("registration rejects a quote whose shot amounts do not sum to the approval total",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.repos.approvals.register({...base,quotedAmountMicros:1250001}),/do not sum/);
 assert.equal(f.calls.length,0);
});


test("workflow-node enqueue binds the exact request to one Neon job and reserves the user-approved ceiling",async()=>{
 const quotes=[];
 const f=fixture({quoteCustomerCredits:input=>{quotes.push(input);return 300;}});
 const result=await f.repos.approvals.enqueueWorkflowNode({
  quoteId:approval,ownerId:owner,projectId:project,requestId:"workflow-approval-001",
  requestHash:"c".repeat(64),provider:"runway",model:"model-router",operation:"text-to-video",
  input:{prompt:"A cinematic sunrise",durationSeconds:5,resolution:"1080p"},
  estimatedAmount:1.25,approvedMaxAmount:2.5,expiresAt:new Date(Date.now()+60000).toISOString(),
  estimatedCredits:125,routedProvider:"runway",routedModel:"seedance2_5"
 });
 assert.equal(result.backend,"neon-postgres");
 assert.equal(result.jobId,job);
 const approvalInsert=f.calls.find(x=>x.sql.includes("insert into executive_visuals.video_generation_approvals"));
 assert.equal(approvalInsert.values[3],"workflow-approval-001:"+approval,"a fresh quote gets its own idempotency key while retries reuse that quote");
 assert.equal(result.queuedForWorker,true);assert.equal(result.providerCallMadeByApi,false);
 assert.equal(quotes.length,1);
 assert.equal(quotes[0].amountMicros,2500000,"customer credits must reserve against the approved ceiling, not the estimate");
 const budget=f.calls.find(x=>x.sql.includes("insert into executive_visuals.video_generation_budget_approvals"));
 assert.equal(budget.values[7],2.5);
 const enqueue=f.calls.find(x=>x.sql.includes("enqueue_video_generation_job_v1"));
 assert.equal(enqueue.values[6],300);
 assert.equal(enqueue.values[5],2.5);
 const queuedInput=JSON.parse(enqueue.values[3]);
 assert.equal(queuedInput.workflowRequestHash,"c".repeat(64));
 assert.equal(queuedInput.approvedMaxAmountMicros,2500000);
});

test("workflow-node enqueue rejects expired quotes, changed model families and ceilings below the quote before database writes",async()=>{
 const f=fixture();
 const baseQuote={quoteId:approval,ownerId:owner,projectId:project,requestId:"workflow-approval-002",
  requestHash:"d".repeat(64),provider:"runway",model:"model-router",operation:"text-to-video",
  input:{prompt:"A cinematic sunrise"},estimatedAmount:1.25,approvedMaxAmount:1.5,
  expiresAt:new Date(Date.now()+60000).toISOString()};
 await assert.rejects(()=>f.repos.approvals.enqueueWorkflowNode({...baseQuote,expiresAt:new Date(Date.now()-1000).toISOString()}),e=>e.code==="VIDEO_WORKFLOW_QUOTE_EXPIRED");
 await assert.rejects(()=>f.repos.approvals.enqueueWorkflowNode({...baseQuote,model:"kling_4"}),e=>e.code==="VIDEO_WORKFLOW_MODEL_UNSUPPORTED");
 await assert.rejects(()=>f.repos.approvals.enqueueWorkflowNode({...baseQuote,approvedMaxAmount:1.2}),e=>e.code==="VIDEO_WORKFLOW_APPROVED_AMOUNT_INVALID");
 await assert.rejects(()=>f.repos.approvals.enqueueWorkflowNode({...baseQuote,quoteState:"consumed"}),e=>e.code==="VIDEO_WORKFLOW_APPROVAL_RECEIPT_INVALID");
 assert.equal(f.calls.length,0);
});

test("per-shot spending ceilings cannot exceed the immutable production ceiling",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.repos.approvals.register({...base,snapshotJson:{shots:[{...snapshot.shots[0],approvedMaxAmountMicros:2000001}]}}),/exceed the production budget ceiling/);
 assert.equal(f.calls.length,0);
});
