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
function fixture({failAt=null}={}){
 const calls=[];let released=false;
 const client={
  async query(sql,values=[]){
   calls.push({sql,values});
   if(sql==="begin"||sql==="commit"||sql==="rollback")return{rows:[]};
   if(sql.includes("insert into executive_visuals.video_generation_approvals"))return{rows:[]};
   if(sql.includes("select * from executive_visuals.video_generation_approvals where id="))return{rows:[{...base,id:approval,owner_id:owner,project_id:project,idempotency_key:base.idempotencyKey,request_hash:base.requestHash,snapshot_json:snapshot,currency:"USD",quoted_amount_micros:"1250000",budget_ceiling_micros:"2000000",status:"approved_pending_submission"}]};
   if(sql.includes("insert into executive_visuals.video_generation_approval_shots"))return{rows:[]};
   if(sql.includes("select * from executive_visuals.video_generation_approval_shots"))return{rows:[{approval_id:approval,shot_index:0,owner_id:owner,project_id:project,provider:"runway",model:"gen4.5",request_hash:"b".repeat(64),estimated_cost_micros:"1250000",reserved_credits:null,budget_approval_id:null}]};
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
 const repos=createNeonVideoGenerationRepositories({pool,videoEnqueue,quoteCustomerCredits:()=>150});
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
 const f=fixture();
 const noQuote=createNeonVideoGenerationRepositories({pool:{connect:async()=>({query:async(sql)=>sql==="begin"||sql==="rollback"||sql==="commit"?{rows:[]}:sql.includes("select * from executive_visuals.video_generation_approvals")?{rows:[{id:approval,owner_id:owner,project_id:project,snapshot_json:snapshot}]}:sql.includes("select * from executive_visuals.video_generation_approval_shots")?{rows:[{approval_id:approval,shot_index:0,owner_id:owner,project_id:project,provider:"runway",model:"gen4.5",request_hash:"b".repeat(64),estimated_cost_micros:"1250000",reserved_credits:null,budget_approval_id:null}]}:{rows:[]},release(){}})},videoEnqueue:{enqueueVideoGenerationJob(){}},quoteCustomerCredits:()=>0});
 await assert.rejects(()=>noQuote.approvals.enqueue(approval,owner),e=>e.code==="VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
 assert.throws(()=>createNeonVideoGenerationRepositories({pool:{connect(){}},videoEnqueue:{enqueueVideoGenerationJob(){}},quoteCustomerCredits:()=>Promise.resolve(10)}),/server-side customer-credit quote policy/);
 assert.ok(f.released);
});

test("registration rejects a quote whose shot amounts do not sum to the approval total",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.repos.approvals.register({...base,quotedAmountMicros:1250001}),/do not sum/);
 assert.equal(f.calls.length,0);
});
