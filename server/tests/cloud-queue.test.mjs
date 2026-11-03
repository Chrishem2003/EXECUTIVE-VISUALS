import test from "node:test";
import assert from "node:assert/strict";
import { createCloudQueue } from "../cloud-queue.mjs";

const base = { url:"https://example.supabase.co", serviceRoleKey:"server-only-test-secret" };
function response(body, status=200) {
  return { ok:status>=200&&status<300, status, async text(){return JSON.stringify(body);} };
}

test("cloud queue uses server credentials and pins PostgREST to the private schema", async()=>{
  const requests=[];
  const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,options});return response([{id:"job-1",status:"processing",lease_owner:"worker-1",lease_expires_at:"2026-11-01T12:01:30Z"}]);}});
  const job=await queue.claim("worker-1",90,["media.color"]);
  assert.equal(job.id,"job-1");
  assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/claim_next_job");
  assert.equal(requests[0].options.headers["accept-profile"],"executive_visuals");
  assert.equal(requests[0].options.headers["content-profile"],"executive_visuals");
  assert.equal(requests[0].options.headers.apikey,base.serviceRoleKey);
  assert.equal(requests[0].options.headers.authorization,"Bearer "+base.serviceRoleKey);
  assert.deepEqual(JSON.parse(requests[0].options.body),{p_worker_id:"worker-1",p_lease_seconds:90,p_job_types:["media.color"]});
});

test("claim accepts an empty queue and rejects malformed or foreign leases",async()=>{
  const empty=createCloudQueue({...base,fetchImpl:async()=>response([])});
  assert.equal(await empty.claim("worker-1"),null);
  const foreign=createCloudQueue({...base,fetchImpl:async()=>response([{id:"job-2",status:"processing",lease_owner:"worker-2",lease_expires_at:"2026-11-01T12:01:30Z"}])});
  await assert.rejects(()=>foreign.claim("worker-1"),/valid worker lease/);
  const malformed=createCloudQueue({...base,fetchImpl:async()=>response({id:"job"})});
  await assert.rejects(()=>malformed.claim("worker-1"),/invalid result/);
});

test("renew, recovery and finish map to the committed RPC contracts",async()=>{
  const requests=[];
  const results=[true,3,true,false];
  const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(results.shift());}});
  assert.equal(await queue.renew("job-1","worker-1"),true);
  assert.equal(await queue.recover(25),3);
  assert.equal(await queue.finish("job-1","worker-1","succeeded",{assetId:"asset-1"}),true);
  assert.equal(await queue.finish("job-1","worker-1","failed",null,{code:"FAILED"}),false);
  assert.deepEqual(requests.map(x=>x.url.split("/").pop()),["renew_job_lease","recover_expired_jobs","finish_job","finish_job"]);
  assert.deepEqual(requests[0].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_lease_seconds:90});
  assert.deepEqual(requests[1].body,{p_limit:25});
  assert.deepEqual(requests[2].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_status:"succeeded",p_output:{assetId:"asset-1"},p_error:null});
});

test("expired job recovery can be scoped to an explicit worker pool",async()=>{
 const requests=[];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(2);}});
 assert.equal(await queue.recover(20,["timeline.render"]),2);
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/recover_expired_jobs_by_type");
 assert.deepEqual(requests[0].body,{p_limit:20,p_job_types:["timeline.render"]});
 await assert.rejects(()=>queue.recover(20,[]),/Recovery job type filters/);
 await assert.rejects(()=>queue.recover(20,["timeline.render","timeline.render"]),/Recovery job type filters/);
});
 
test("configuration, arguments and HTTP errors fail closed",async()=>{
  assert.throws(()=>createCloudQueue({url:"http://remote.example",serviceRoleKey:"secret"}),/HTTPS/);
  assert.throws(()=>createCloudQueue({url:base.url}),/SUPABASE_SERVICE_ROLE_KEY/);
  const queue=createCloudQueue({...base,fetchImpl:async()=>response({message:"permission denied: "+base.serviceRoleKey},403)});
  await assert.rejects(()=>queue.claim("worker-1"),error=>error.code==="CLOUD_QUEUE_HTTP_403"&&!error.message.includes(base.serviceRoleKey));
  await assert.rejects(()=>queue.claim(""),/Worker ID/);
  await assert.rejects(()=>queue.claim("worker-1",10),/Lease duration/);
  await assert.rejects(()=>queue.claim("worker-1",90,[]),/Job type filters/);
  await assert.rejects(()=>queue.claim("worker-1",90,["media.color","media.color"]),/Job type filters/);
  await assert.rejects(()=>queue.recover(1001),/Recovery limit/);
  await assert.rejects(()=>queue.finish("job-1","worker-1","processing"),/terminal job status/);
  await assert.rejects(()=>queue.finish("job-1","worker-1","failed",[]),/must be an object/);
});

test("transient retry RPC is validated and uses the current worker identity",async()=>{
 const requests=[];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response({accepted:true,status:"queued",retryable:true,delaySeconds:2,attempt:2,maxAttempts:4});}});
 const result=await queue.retry("job-1","worker-1",{code:"CLOUD_QUEUE_TIMEOUT",message:"temporary timeout",retryable:true});
 assert.deepEqual(result,{accepted:true,status:"queued",retryable:true,delaySeconds:2,attempt:2,maxAttempts:4});
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/retry_job");
 assert.deepEqual(requests[0].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_error:{code:"CLOUD_QUEUE_TIMEOUT",message:"temporary timeout",retryable:true}});
});
test("retry RPC rejects malformed arguments and response contracts",async()=>{
 const invalid=createCloudQueue({...base,fetchImpl:async()=>response({accepted:true,status:"queued",retryable:true,delaySeconds:-1,attempt:1,maxAttempts:2})});
 await assert.rejects(()=>invalid.retry("job-1","worker-1",{retryable:true}),/invalid result/);
 const contradictory=createCloudQueue({...base,fetchImpl:async()=>response({accepted:true,status:"queued",retryable:false,delaySeconds:0,attempt:1,maxAttempts:3})});
 await assert.rejects(()=>contradictory.retry("job-1","worker-1",{retryable:true}),/invalid result/);
 const exhaustedQueued=createCloudQueue({...base,fetchImpl:async()=>response({accepted:true,status:"queued",retryable:true,delaySeconds:1,attempt:3,maxAttempts:3})});
 await assert.rejects(()=>exhaustedQueued.retry("job-1","worker-1",{retryable:true}),/invalid result/);
 const lostLease=createCloudQueue({...base,fetchImpl:async()=>response({accepted:false,status:"lease_lost",retryable:false,delaySeconds:0,attempt:0,maxAttempts:1})});
 assert.deepEqual(await lostLease.retry("job-1","worker-1",{retryable:true}),{accepted:false,status:"lease_lost",retryable:false,delaySeconds:0,attempt:0,maxAttempts:1});
 await assert.rejects(()=>invalid.retry("","worker-1",{retryable:true}),/Job ID and worker ID/);
 await assert.rejects(()=>invalid.retry("job-1","worker-1",[]),/must be an object/);
});

test("progress reporting uses the lease-fenced RPC and validates its boolean result",async()=>{
 const requests=[];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(true);}});
 assert.equal(await queue.reportProgress("job-1","worker-1",42.5),true);
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/report_job_progress");
 assert.deepEqual(requests[0].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_progress:42.5});
 await assert.rejects(()=>queue.reportProgress("job-1","worker-1",101),/between 0 and 100/);
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response("yes")});
 await assert.rejects(()=>malformed.reportProgress("job-1","worker-1",20),/invalid result/);
});

test("worker cancellation polling is lease-aware and validates its RPC response",async()=>{
 const requests=[];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{
  requests.push({url,body:JSON.parse(options.body)});
  return response({leaseValid:true,cancelRequested:true});
 }});
 assert.deepEqual(await queue.checkCancellation("job-1","worker-1"),{leaseValid:true,cancelRequested:true});
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/check_job_cancellation");
 assert.deepEqual(requests[0].body,{p_job_id:"job-1",p_worker_id:"worker-1"});
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response({leaseValid:false,cancelRequested:true})});
 await assert.rejects(()=>malformed.checkCancellation("job-1","worker-1"),/invalid result/);
 await assert.rejects(()=>queue.checkCancellation("","worker-1"),/required/);
});

test("durable worker heartbeat RPC validates identity, status, metrics and response",async()=>{
 const requests=[];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response({accepted:true,lastSeenAt:"2026-11-03T12:00:00Z"});}});
 const result=await queue.heartbeatWorker({workerId:"media-worker-1",workerFamily:"media",instanceId:"instance-1",status:"running",metrics:{jobsClaimed:4,activeCycle:false}});
 assert.deepEqual(result,{accepted:true,lastSeenAt:"2026-11-03T12:00:00Z"});
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/heartbeat_worker");
 assert.deepEqual(requests[0].body,{p_worker_id:"media-worker-1",p_worker_family:"media",p_instance_id:"instance-1",p_status:"running",p_metrics:{jobsClaimed:4,activeCycle:false}});
 await assert.rejects(()=>queue.heartbeatWorker({workerId:"",workerFamily:"media",instanceId:"i"}),/worker ID/);
 await assert.rejects(()=>queue.heartbeatWorker({workerId:"w",workerFamily:"media",instanceId:"i",status:"unknown"}),/status/);
 await assert.rejects(()=>queue.heartbeatWorker({workerId:"w",workerFamily:"media",instanceId:"i",metrics:[]}),/object/);
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response({accepted:true})});
 await assert.rejects(()=>malformed.heartbeatWorker({workerId:"w",workerFamily:"media",instanceId:"i"}),/invalid result/);
});

test("worker fleet health snapshot is bounded, read-only and validates sanitized rows",async()=>{
 const requests=[];
 const rows=[{worker_id:"media-1",worker_family:"media",instance_id:"instance-a",status:"stale",metrics:{jobsClaimed:3},started_at:"2026-11-03T10:00:00Z",last_seen_at:"2026-11-03T10:01:00Z",stopped_at:null,age_seconds:240}];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(rows);}});
 assert.deepEqual(await queue.listWorkerHealth({staleAfterSeconds:180,limit:20}),rows);
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/list_worker_health");
 assert.deepEqual(requests[0].body,{p_stale_after_seconds:180,p_limit:20});
 await assert.rejects(()=>queue.listWorkerHealth({staleAfterSeconds:10}),/stale threshold/);
 await assert.rejects(()=>queue.listWorkerHealth({limit:201}),/result limit/);
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response([{...rows[0],status:"unknown"}])});
 await assert.rejects(()=>malformed.listWorkerHealth(),/malformed worker record/);
 const oversized=createCloudQueue({...base,fetchImpl:async()=>response(Array(2).fill(rows[0]))});
 await assert.rejects(()=>oversized.listWorkerHealth({limit:1}),/invalid result/);
});

test("worker heartbeat retention cleanup is bounded and validates returned count",async()=>{
 const requests=[];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(12);}});
 assert.equal(await queue.pruneWorkerHeartbeats({retentionDays:45,limit:50}),12);
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/prune_worker_heartbeats");
 assert.deepEqual(requests[0].body,{p_retention_days:45,p_limit:50});
 await assert.rejects(()=>queue.pruneWorkerHeartbeats({retentionDays:1}),/retention/);
 await assert.rejects(()=>queue.pruneWorkerHeartbeats({limit:1001}),/cleanup limit/);
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response(8)});
 await assert.rejects(()=>malformed.pruneWorkerHeartbeats({limit:5}),/invalid count/);
});


test("cloud job diagnostics are bounded, payload-free and validated",async()=>{
 const requests=[];
 const rows=[{
  id:"job-1",job_type:"media.upscale",status:"processing",progress:42,
  attempt_count:1,max_attempts:3,created_at:"2026-11-03T10:00:00Z",
  updated_at:"2026-11-03T11:00:00Z",available_at:null,started_at:"2026-11-03T10:30:00Z",
  lease_expires_at:"2026-11-03T11:01:00Z",lease_heartbeat_at:"2026-11-03T11:00:00Z",
  queue_age_seconds:3600,lease_age_seconds:60,
  diagnostic_flags:{queued_too_long:false,lease_expired:false,heartbeat_stale:false,attempts_exhausted:false}
 }];
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(rows);}});
 assert.deepEqual(await queue.listJobDiagnostics({limit:25,queueStaleAfterSeconds:600,leaseStaleAfterSeconds:120}),rows);
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/list_job_diagnostics");
 assert.deepEqual(requests[0].body,{p_limit:25,p_queue_stale_after_seconds:600,p_lease_stale_after_seconds:120});
 await assert.rejects(()=>queue.listJobDiagnostics({limit:201}),/diagnostics limit/);
 await assert.rejects(()=>queue.listJobDiagnostics({queueStaleAfterSeconds:30}),/Queued-job stale threshold/);
 await assert.rejects(()=>queue.listJobDiagnostics({leaseStaleAfterSeconds:10}),/Worker lease stale threshold/);
 const unsafe=createCloudQueue({...base,fetchImpl:async()=>response([{...rows[0],input:{private:"payload"}}])});
 await assert.rejects(()=>unsafe.listJobDiagnostics(),/malformed or unsafe/);
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response([{...rows[0],diagnostic_flags:{}}])});
 await assert.rejects(()=>malformed.listJobDiagnostics(),/malformed or unsafe/);
 const oversized=createCloudQueue({...base,fetchImpl:async()=>response([rows[0],rows[0]])});
 await assert.rejects(()=>oversized.listJobDiagnostics({limit:1}),/invalid result/);
 const extraField=createCloudQueue({...base,fetchImpl:async()=>response([{...rows[0],owner_email:"private@example.test"}])});
 await assert.rejects(()=>extraField.listJobDiagnostics(),/malformed or unsafe/);
 const invalidTimestamp=createCloudQueue({...base,fetchImpl:async()=>response([{...rows[0],created_at:"not-a-date"}])});
 await assert.rejects(()=>invalidTimestamp.listJobDiagnostics(),/malformed or unsafe/);
 const blankIdentity=createCloudQueue({...base,fetchImpl:async()=>response([{...rows[0],job_type:" "}])});
 await assert.rejects(()=>blankIdentity.listJobDiagnostics(),/malformed or unsafe/);
});

test("asset cleanup diagnostics use an aggregate-only service-role RPC and validate privacy",async()=>{
 const requests=[];
 const snapshot={pending_count:4,pending_over_24_hours:2,pending_over_7_days:1,oldest_pending_at:"2026-11-01T10:00:00Z",oldest_pending_age_seconds:172800};
 const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(snapshot);}});
 assert.deepEqual(await queue.listAssetCleanupDiagnostics(),snapshot);
 assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/list_asset_cleanup_diagnostics");
 assert.deepEqual(requests[0].body,{});
 const malformed=createCloudQueue({...base,fetchImpl:async()=>response({...snapshot,owner_id:"private"})});
 await assert.rejects(()=>malformed.listAssetCleanupDiagnostics(),/malformed or unsafe/);
 const contradictory=createCloudQueue({...base,fetchImpl:async()=>response({...snapshot,pending_over_7_days:3})});
 await assert.rejects(()=>contradictory.listAssetCleanupDiagnostics(),/malformed or unsafe/);
 const empty=createCloudQueue({...base,fetchImpl:async()=>response({pending_count:0,pending_over_24_hours:0,pending_over_7_days:0,oldest_pending_at:null,oldest_pending_age_seconds:0})});
 assert.equal((await empty.listAssetCleanupDiagnostics()).pending_count,0);
});
