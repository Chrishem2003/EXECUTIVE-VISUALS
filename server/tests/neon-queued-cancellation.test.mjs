import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNeonPostgresQueue } from "../neon-postgres-queue.mjs";

const jobId="423e4567-e89b-42d3-a456-426614174000";
const ownerId="123e4567-e89b-42d3-a456-426614174000";

test("queued cancellation calls the owner-scoped atomic SQL boundary",async()=>{
 let call;
 const queue=createNeonPostgresQueue({pool:{query:async(sql,values)=>{call={sql,values};return{rows:[{
  cancelled:true,job_status:"cancelled",balance:"900",credit_adjustment:100,replayed:false,reason:"cancelled_before_submission"
 }]};}}});
 assert.deepEqual(await queue.cancelQueuedVideoJob(jobId,ownerId),{
  cancelled:true,status:"cancelled",balance:900,creditAdjustment:100,replayed:false,reason:"cancelled_before_submission"
 });
 assert.match(call.sql,/cancel_queued_video_generation_job_v1/);
 assert.deepEqual(call.values,[jobId,ownerId]);
});

test("queued cancellation returns explicit fail-closed reasons without claiming success",async()=>{
 for(const reason of ["provider_submission_possible","submission_record_exists","financial_reservation_not_active","terminal_job"]){
  const queue=createNeonPostgresQueue({pool:{query:async()=>({rows:[{
   cancelled:false,job_status:"processing",balance:"0",credit_adjustment:"0",replayed:false,reason
  }]})}});
  const receipt=await queue.cancelQueuedVideoJob(jobId,ownerId);
  assert.equal(receipt.cancelled,false);
  assert.equal(receipt.reason,reason);
 }
});

test("queued cancellation validates IDs and rejects malformed SQL receipts",async()=>{
 const queue=createNeonPostgresQueue({pool:{query:async()=>({rows:[{cancelled:"true",reason:"cancelled_before_submission"}]})}});
 await assert.rejects(()=>queue.cancelQueuedVideoJob("bad",ownerId),/UUIDs/);
 await assert.rejects(()=>queue.cancelQueuedVideoJob(jobId,"bad"),/UUIDs/);
 await assert.rejects(()=>queue.cancelQueuedVideoJob(jobId,ownerId),/invalid receipt/);
});

test("migration proves queued state and absence of any provider submission before releasing reservations",async()=>{
 const sql=await readFile(new URL("../../database/neon/migrations/0009_safe_queued_video_cancellation.sql",import.meta.url),"utf8");
 assert.match(sql,/status<>'queued'/i);
 assert.match(sql,/video_generation_submissions/i);
 assert.match(sql,/verified_no_submission/i);
 assert.match(sql,/finalize_video_generation_financials_v1/i);
 assert.match(sql,/for update/i);
 assert.match(sql,/job\.cancelled_before_submission/i);
 assert.match(sql,/revoke all on function[\s\S]*from public/i);
 assert.doesNotMatch(sql,/auth\.users|drop table|truncate|delete from/i);
});
