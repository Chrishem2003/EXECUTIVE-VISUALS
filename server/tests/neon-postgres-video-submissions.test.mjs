import test from "node:test";
import assert from "node:assert/strict";
import { createNeonVideoSubmissionLedger } from "../neon-postgres-video-submissions.mjs";
const id="123e4567-e89b-42d3-a456-426614174000",token="223e4567-e89b-42d3-a456-426614174000",hash="a".repeat(64);
test("prepare is lease fenced and validates returned identity",async()=>{let call;const row={job_id:id,owner_id:id,request_hash:hash};const l=createNeonVideoSubmissionLedger({pool:{query:async(text,values)=>{call={text,values};return {rows:[row]};}}});assert.deepEqual(await l.prepare({jobId:id,ownerId:id,workerId:"worker",leaseToken:token,provider:"runway",model:"gen4",requestHash:hash}),row);assert.match(call.text,/prepare_video_generation_submission_v2/);assert.equal(call.values[3],token);});
test("begin, record, unknown and finish use parameterized lease-fenced RPCs",async()=>{const calls=[];const l=createNeonVideoSubmissionLedger({pool:{query:async(text,values)=>{calls.push({text,values});return {rows:[{result:true}]};}}});assert.equal(await l.begin(id,"worker",token),true);assert.equal(await l.record(id,"worker","task-1",{attempt:1},token),true);assert.equal(await l.markUnknown(id,"worker","AMBIGUOUS",token),true);assert.equal(await l.finish(id,"worker","failed",{reason:"test"},token),true);assert.equal(calls.length,4);assert.ok(calls.every(x=>x.text.includes("_v2")));assert.equal(calls[1].values[3],"task-1");});
test("unknown reconciliation requires auditable evidence and supports idempotent confirmation",async()=>{let values;const l=createNeonVideoSubmissionLedger({pool:{query:async(_t,v)=>{values=v;return {rows:[{result:true}]};}}});assert.equal(await l.reconcileUnknown(id,"task-1","ticket-123",{verified:true}),true);assert.equal(values[2],"ticket-123");await assert.rejects(()=>l.reconcileUnknown(id,"task-1","",{}),/Evidence reference/);});
test("get validates identity and returns null when absent",async()=>{const l=createNeonVideoSubmissionLedger({pool:{query:async()=>({rows:[]})}});assert.equal(await l.get(id),null);await assert.rejects(()=>l.get("bad"),/UUID/);});
test("rejects missing or malformed fencing tokens and oversized metadata",async()=>{const l=createNeonVideoSubmissionLedger({pool:{query:async()=>({rows:[{result:true}]})}});await assert.rejects(()=>l.begin(id,"worker","bad"),/lease token/);await assert.rejects(()=>l.record(id,"worker","task",{payload:"x".repeat(9000)},token),/8000-byte/);await assert.rejects(()=>l.finish(id,"worker","unknown",{},token),/terminal state/);});

test("retry resets only through the dedicated lease-fenced Neon RPC",async()=>{
 let call;
 const l=createNeonVideoSubmissionLedger({pool:{query:async(text,values)=>{call={text,values};return{rows:[{result:true}]};}}});
 assert.equal(await l.retry(id,"worker",token,"RUNWAY_SERVER_ERROR"),true);
 assert.match(call.text,/retry_video_generation_submission_v1/);
 assert.deepEqual(call.values,[id,"worker",token,"RUNWAY_SERVER_ERROR"]);
 await assert.rejects(()=>l.retry(id,"worker","bad","RUNWAY_SERVER_ERROR"),/lease token/);
 await assert.rejects(()=>l.retry(id,"worker",token,"bad code"),/Error code/);
});
