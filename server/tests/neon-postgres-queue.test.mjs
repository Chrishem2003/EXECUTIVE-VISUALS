import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNeonPostgresQueue } from "../neon-postgres-queue.mjs";
import { assertNeonPooledDatabaseUrl, assertNeonDirectDatabaseUrl, createNeonPostgresPool } from "../neon-postgres-pool.mjs";

const id="123e4567-e89b-42d3-a456-426614174000";
const token="223e4567-e89b-42d3-a456-426614174000";
const row={id,owner_id:id,job_type:"video.generate",status:"processing",lease_owner:"worker-a",lease_token:token,lease_expires_at:"2026-11-19T12:00:00Z",input:{}};

test("requires pooled application URL and rejects direct URL for app traffic",()=>{
 const pooled="postgresql://ev:secret@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
 const direct="postgresql://ev:secret@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require";
 assert.equal(new URL(assertNeonPooledDatabaseUrl(pooled)).hostname,"ep-example-pooler.us-east-2.aws.neon.tech");
 assert.throws(()=>assertNeonPooledDatabaseUrl(direct),/pooled endpoint/);
 assert.equal(new URL(assertNeonDirectDatabaseUrl(direct)).hostname,"ep-example.us-east-2.aws.neon.tech");
 assert.throws(()=>assertNeonDirectDatabaseUrl(pooled),/direct Neon endpoint/);
 assert.throws(()=>assertNeonPooledDatabaseUrl("https://example.com"),/PostgreSQL URL/);
});

test("creates a bounded pg pool with TLS verification and pooled endpoint only",async()=>{
 let options;
 class FakePool { constructor(value){options=value;} query(){} }
 const pool=await createNeonPostgresPool({connectionString:"postgres://ev:secret@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",Pool:FakePool,max:2});
 assert.ok(pool instanceof FakePool);
 assert.equal(options.max,2);
 assert.deepEqual(options.ssl,{rejectUnauthorized:true});
 assert.equal(options.keepAlive,true);
 await assert.rejects(()=>createNeonPostgresPool({connectionString:"postgres://ev:secret@ep-example.us-east-2.aws.neon.tech/neondb",Pool:FakePool}),/pooled endpoint/);
});

test("enqueue is idempotent, bounded and parameterized", async () => {
 const calls=[];
 const pool={query:async(text,values)=>{calls.push({text,values});return {rows:[{job_id:id,status:"queued",replayed:true}]};}};
 const queue=createNeonPostgresQueue({pool});
 const result=await queue.enqueue({ownerId:id,projectId:id,jobType:"video.generate",input:{provider:"runway"},idempotencyKey:"request-1",maxAttempts:3});
 assert.deepEqual(result,{jobId:id,status:"queued",replayed:true});
 assert.match(calls[0].text,/enqueue_job_v1/);
 assert.deepEqual(calls[0].values,[id,id,"video.generate",JSON.stringify({provider:"runway"}),"request-1",3]);
 await assert.rejects(()=>queue.enqueue({ownerId:"bad",jobType:"video.generate",input:{}}),/UUIDs/);
 await assert.rejects(()=>queue.enqueue({ownerId:id,jobType:"video.generate",input:[]}),/object/);
 await assert.rejects(()=>queue.enqueue({ownerId:id,jobType:"video.generate",input:{},maxAttempts:0}),/attempts/);
});

test("defer and quarantine release only the current fenced lease", async () => {
 const calls=[];
 const queue=createNeonPostgresQueue({pool:{query:async(text,values)=>{calls.push({text,values});return {rows:[{deferred:text.includes("defer_job_v1"),quarantined:text.includes("quarantine_job_v1")}]};}}});
 assert.equal(await queue.defer(id,"worker-a",token,30,{code:"RATE_LIMITED"}),true);
 assert.equal(await queue.quarantine(id,"worker-a",token,{code:"INVALID_PAYLOAD"}),true);
 assert.match(calls[0].text,/defer_job_v1/);
 assert.deepEqual(calls[0].values,[id,"worker-a",token,30,JSON.stringify({code:"RATE_LIMITED"})]);
 assert.match(calls[1].text,/quarantine_job_v1/);
 assert.deepEqual(calls[1].values,[id,"worker-a",token,JSON.stringify({code:"INVALID_PAYLOAD"})]);
 await assert.rejects(()=>queue.defer(id,"worker-a","bad",30),/UUIDs/);
 await assert.rejects(()=>queue.quarantine(id,"worker-a",token,null),/structured error/);
});

test("claim uses atomic SQL function and validates the fencing token",async()=>{
 const calls=[];
 const pool={query:async(text,values)=>{calls.push({text,values});return {rows:[row]};}};
 const queue=createNeonPostgresQueue({pool});
 assert.deepEqual(await queue.claim("worker-a",90,["video.generate"]),row);
 assert.match(calls[0].text,/claim_next_job_v2/);
 assert.deepEqual(calls[0].values,["worker-a",90,["video.generate"]]);
 const bad=createNeonPostgresQueue({pool:{query:async()=>({rows:[{...row,lease_token:"bad"}]})}});
 await assert.rejects(()=>bad.claim("worker-a"),/fenced lease/);
});

test("lease operations are parameterized and fail closed on lost ownership",async()=>{
 const calls=[];
 const pool={query:async(text,values)=>{calls.push({text,values});return {rows:[{renewed:true,valid:false}]};}};
 const queue=createNeonPostgresQueue({pool});
 assert.equal(await queue.renew(id,"worker-a",90,token),true);
 assert.equal(await queue.assertLease(id,"worker-a",token),false);
 assert.match(calls[0].text,/renew_job_lease_v2/);
 assert.deepEqual(calls[0].values,[id,"worker-a",token,90]);
});

test("cancellation lookup is fenced to current attempt",async()=>{
 let values;
 const queue=createNeonPostgresQueue({pool:{query:async(_text,v)=>{values=v;return {rows:[{cancel_requested_at:"2026-11-19T12:00:00Z"}]};}}});
 assert.equal(await queue.cancellationRequested(id,"worker-a",token),true);
 assert.deepEqual(values,[id,"worker-a",token]);
});

test("recovery and finish validate result and require the fencing token",async()=>{
 const calls=[];
 const queue=createNeonPostgresQueue({pool:{query:async(text,values)=>{calls.push({text,values});return {rows:[text.includes("recover_expired_jobs")?{recovered:3}:{finished:true}]};}}});
 assert.equal(await queue.recover(25),3);
 assert.equal(await queue.finish(id,"worker-a","succeeded",{assetIds:[]},null,token),true);
 assert.match(calls[1].text,/finish_job_v2/);
 assert.deepEqual(calls[1].values,[id,"worker-a",token,"succeeded",JSON.stringify({assetIds:[]}),null]);
 await assert.rejects(()=>queue.finish(id,"worker-a","succeeded",{},null,"bad"),/UUIDs/);
});

test("readiness is read-only and reports missing schema as not ready",async()=>{
 const queue=createNeonPostgresQueue({pool:{query:async()=>({rows:[{database_name:"neondb",jobs_ready:false,events_ready:false}]})}});
 assert.deepEqual(await queue.checkReadiness(),{backend:"neon-postgres",configured:true,ready:false,durableAcrossDeploys:true,database:"neondb"});
});

test("migration contains atomic claim, skip-locked, lease fencing and no data-copy or auth changes",async()=>{
 const sql=await readFile(new URL("../../database/neon/migrations/0001_worker_queue.sql",import.meta.url),"utf8");
 assert.match(sql,/for update skip locked/i);
 assert.match(sql,/gen_random_uuid\(\)/i);
 assert.match(sql,/lease_token=p_lease_token/i);
 assert.match(sql,/begin;[\s\S]*commit;/i);
 assert.doesNotMatch(sql,/auth\.users|drop table|truncate|delete from/i);
});

test("queue lifecycle migration uses atomic idempotency and fenced state transitions", async () => {
 const sql=await readFile(new URL("../../database/neon/migrations/0004_queue_admission_and_recovery.sql",import.meta.url),"utf8");
 assert.match(sql,/pg_advisory_xact_lock/i);
 assert.match(sql,/QUEUE_IDEMPOTENCY_CONFLICT/);
 assert.match(sql,/lease_owner=p_worker_id and lease_token=p_lease_token/i);
 assert.match(sql,/status='blocked'/i);
 assert.match(sql,/revoke all on function[\s\S]*from public/i);
 assert.match(sql,/begin;[\s\S]*commit;/i);
 assert.doesNotMatch(sql,/auth\.users|drop table|truncate|delete from/i);
});
