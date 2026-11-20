import test from "node:test";
import assert from "node:assert/strict";
import {createNeonVideoEnqueue} from "../neon-postgres-video-enqueue.mjs";
const owner="123e4567-e89b-42d3-a456-426614174000";
const approval="223e4567-e89b-42d3-a456-426614174000";
const job="323e4567-e89b-42d3-a456-426614174000";
const budget="423e4567-e89b-42d3-a456-426614174000";
const credit="523e4567-e89b-42d3-a456-426614174000";
const input={provider:"runway",model:"gen4.5",requestHash:"a".repeat(64),prompt:"A cinematic test"};
function receipt(overrides={}){return{job_id:job,job_status:"queued",idempotent_replay:false,budget_reservation_id:budget,credit_reservation_id:credit,available_credits:"850",...overrides};}
test("atomic video enqueue binds owner, project, idempotency, approval and both reservations in one RPC",async()=>{
 let call;const adapter=createNeonVideoEnqueue({pool:{query:async(sql,values)=>{call={sql,values};return{rows:[receipt()]};}}});
 const result=await adapter.enqueueVideoGenerationJob({ownerId:owner,projectId:null,idempotencyKey:"request-1",input,approvalId:approval,reservedAmount:4.5,reservedCredits:150});
 assert.deepEqual(result,{jobId:job,status:"queued",idempotentReplay:false,budgetReservationId:budget,creditReservationId:credit,availableCredits:850});
 assert.match(call.sql,/enqueue_video_generation_job_v1/);
 assert.deepEqual(call.values.slice(0,3),[owner,null,"request-1"]);
 assert.equal(JSON.parse(call.values[3]).requestHash,input.requestHash);
 assert.deepEqual(call.values.slice(4),[approval,4.5,150,2]);
});
test("atomic enqueue accepts an exact idempotent replay receipt",async()=>{
 const adapter=createNeonVideoEnqueue({pool:{query:async()=>({rows:[receipt({idempotent_replay:true,job_status:"processing"})]})}});
 const result=await adapter.enqueueVideoGenerationJob({ownerId:owner,idempotencyKey:"request-1",input,approvalId:approval,reservedAmount:4.5,reservedCredits:150});
 assert.equal(result.idempotentReplay,true);assert.equal(result.status,"processing");
});
test("atomic enqueue validates all financial and identity inputs before database access",async()=>{
 const adapter=createNeonVideoEnqueue({pool:{query:async()=>{throw new Error("database must not be called");}}});
 const args={ownerId:owner,idempotencyKey:"request-1",input,approvalId:approval,reservedAmount:4.5,reservedCredits:150};
 await assert.rejects(()=>adapter.enqueueVideoGenerationJob({...args,ownerId:"bad"}),/owner/);
 await assert.rejects(()=>adapter.enqueueVideoGenerationJob({...args,input:{...input,requestHash:"bad"}}),/SHA-256/);
 await assert.rejects(()=>adapter.enqueueVideoGenerationJob({...args,approvalId:"bad"}),/approval/);
 await assert.rejects(()=>adapter.enqueueVideoGenerationJob({...args,reservedCredits:0}),/credits/);
 await assert.rejects(()=>adapter.enqueueVideoGenerationJob({...args,reservedAmount:0}),/amount/);
});
test("atomic enqueue rejects malformed receipts and exposes a fail-closed readiness probe",async()=>{
 let calls=0;const adapter=createNeonVideoEnqueue({pool:{query:async(sql)=>{calls++;return sql.includes("to_regprocedure")?{rows:[{atomic_video_enqueue_ready:false}]}:{rows:[{job_id:job}]};}}});
 await assert.rejects(()=>adapter.enqueueVideoGenerationJob({ownerId:owner,idempotencyKey:"request-1",input,approvalId:approval,reservedAmount:4.5,reservedCredits:150}),/invalid receipt/);
 assert.deepEqual(await adapter.checkReadiness(),{configured:true,ready:false,atomicVideoEnqueueReady:false});
 assert.equal(calls,2);
});
test("atomic enqueue migration keeps the job and financial reservation in one transaction",async()=>{
 const {readFile}=await import("node:fs/promises");
 const sql=await readFile(new URL("../../database/neon/migrations/0006_atomic_video_enqueue.sql",import.meta.url),"utf8");
 assert.match(sql,/begin;/i);assert.match(sql,/enqueue_job_v1/);assert.match(sql,/reserve_video_generation_financials_v1/);assert.match(sql,/revoke all on function/);assert.match(sql,/commit;/i);
 assert.doesNotMatch(sql,/drop table|truncate|delete from/i);
});
