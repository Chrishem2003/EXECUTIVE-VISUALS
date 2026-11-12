import test from "node:test";
import assert from "node:assert/strict";
import { createCloudQueue } from "../cloud-queue.mjs";

const base = { url:"https://example.supabase.co", serviceRoleKey:"server-only-test-secret" };
function response(body, status=200) {
  return { ok:status>=200&&status<300, status, async text(){return JSON.stringify(body);} };
}

test("cloud queue uses server credentials and pins PostgREST to the private schema", async()=>{
  const requests=[];
  const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,options});return response([{id:"job-1",status:"processing",lease_owner:"worker-1",lease_expires_at:"2026-11-01T12:01:30Z",lease_token:"11111111-1111-4111-8111-111111111111"}]);}});
  const job=await queue.claim("worker-1",90,["media.color"]);
  assert.equal(job.id,"job-1");
  assert.equal(requests[0].url,"https://example.supabase.co/rest/v1/rpc/claim_next_job_v2");
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
  const results=[true,true,3,true,false];
  const queue=createCloudQueue({...base,fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return response(results.shift());}});
  assert.equal(await queue.renew("job-1","worker-1",90,"11111111-1111-4111-8111-111111111111"),true);
  assert.equal(await queue.assertLease("job-1","worker-1","11111111-1111-4111-8111-111111111111"),true);
  assert.equal(await queue.recover(25),3);
  assert.equal(await queue.finish("job-1","worker-1","succeeded",{assetId:"asset-1"},null,"11111111-1111-4111-8111-111111111111"),true);
  assert.equal(await queue.finish("job-1","worker-1","failed",null,{code:"FAILED"},"11111111-1111-4111-8111-111111111111"),false);
  assert.deepEqual(requests.map(x=>x.url.split("/").pop()),["renew_job_lease_v2","assert_job_lease_v2","recover_expired_jobs","finish_job_v2","finish_job_v2"]);
  assert.deepEqual(requests[0].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_lease_token:"11111111-1111-4111-8111-111111111111",p_lease_seconds:90});
  assert.deepEqual(requests[1].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_lease_token:"11111111-1111-4111-8111-111111111111"});
  assert.deepEqual(requests[2].body,{p_limit:25});
  assert.deepEqual(requests[3].body,{p_job_id:"job-1",p_worker_id:"worker-1",p_lease_token:"11111111-1111-4111-8111-111111111111",p_status:"succeeded",p_output:{assetId:"asset-1"},p_error:null});
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
  await assert.rejects(()=>queue.finish("job-1","worker-1","processing",null,null,"11111111-1111-4111-8111-111111111111"),/terminal job status/);
  await assert.rejects(()=>queue.finish("job-1","worker-1","failed",[]),/lease token/);
  await assert.rejects(()=>queue.renew("job-1","worker-1"),/lease token/);
});
