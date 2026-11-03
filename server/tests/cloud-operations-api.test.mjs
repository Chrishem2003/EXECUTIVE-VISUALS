import test from "node:test";
import assert from "node:assert/strict";
import {createCloudOperationsApi} from "../cloud-operations-api.mjs";

function fakeQueue(){
 const calls=[];
 return {
  calls,
  async listJobDiagnostics(args){calls.push(["jobs",args]);return [{id:"job-1",status:"queued",diagnostic_flags:{queued_too_long:false}}];},
  async listWorkerHealth(args){calls.push(["workers",args]);return [{worker_id:"worker-1",status:"running",age_seconds:12}];},
  async listAssetCleanupDiagnostics(){calls.push(["assetCleanup"]);return {pending_count:2,pending_over_24_hours:1,pending_over_7_days:0,oldest_pending_at:"2026-11-02T10:00:00Z",oldest_pending_age_seconds:90000};}
 };
}

test("cloud operations requires a queue and an explicit valid administrator allowlist",()=>{
 assert.throws(()=>createCloudOperationsApi({adminEmails:["ops@example.com"]}),/trusted cloud queue/);
 assert.throws(()=>createCloudOperationsApi({queue:fakeQueue(),adminEmails:[]}),/at least one valid/);
 assert.throws(()=>createCloudOperationsApi({queue:fakeQueue(),adminEmails:["not-an-email"]}),/at least one valid/);
});

test("cloud operations is read-only and requires verified allowlisted user identity",async()=>{
 const queue=fakeQueue(),api=createCloudOperationsApi({queue,adminEmails:["Ops@Example.com"]});
 assert.equal(await api.handle({method:"POST",path:"/api/admin/cloud/operations",user:{id:"user-1",email:"ops@example.com",emailVerified:true}}),null);
 assert.deepEqual(await api.handle({method:"GET",path:"/api/admin/cloud/operations",user:null}),{status:401,body:{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}}});
 const unverified=await api.handle({method:"GET",path:"/api/admin/cloud/operations",user:{id:"user-1",email:"ops@example.com",emailVerified:false}});
 assert.equal(unverified.status,403);assert.equal(unverified.body.error.code,"CLOUD_OPERATIONS_VERIFIED_EMAIL_REQUIRED");
 const denied=await api.handle({method:"GET",path:"/api/admin/cloud/operations",user:{id:"user-2",email:"other@example.com",emailVerified:true}});
 assert.equal(denied.status,403);
 assert.equal(queue.calls.length,0);
});

test("cloud operations validates bounds and returns sanitized queue and fleet diagnostics",async()=>{
 const queue=fakeQueue(),api=createCloudOperationsApi({queue,adminEmails:["ops@example.com"]});
 const invalid=await api.handle({method:"GET",path:"/api/admin/cloud/operations",user:{id:"user-1",email:"ops@example.com",emailVerified:true},query:{limit:"201"}});
 assert.equal(invalid.status,400);
 assert.equal(queue.calls.length,0);
 const result=await api.handle({method:"GET",path:"/api/admin/cloud/operations",user:{id:"user-1",email:"ops@example.com",emailVerified:true},query:{limit:"25",queueStaleAfterSeconds:"600",leaseStaleAfterSeconds:"120",workerStaleAfterSeconds:"90"}});
 assert.equal(result.status,200);
 assert.equal(Number.isFinite(Date.parse(result.body.generatedAt)),true);
 assert.deepEqual(result.body.jobs,[{id:"job-1",status:"queued",diagnostic_flags:{queued_too_long:false}}]);
 assert.deepEqual(result.body.workers,[{worker_id:"worker-1",status:"running",age_seconds:12}]);
 assert.deepEqual(result.body.assetCleanup,{pending_count:2,pending_over_24_hours:1,pending_over_7_days:0,oldest_pending_at:"2026-11-02T10:00:00Z",oldest_pending_age_seconds:90000});
 assert.deepEqual(queue.calls,[["jobs",{limit:25,queueStaleAfterSeconds:600,leaseStaleAfterSeconds:120}],["workers",{limit:25,staleAfterSeconds:90}],["assetCleanup"]]);
});

test("cloud operations fails closed when either trusted diagnostics source fails",async()=>{
 const queue=fakeQueue();
 queue.listWorkerHealth=async()=>{throw new Error("sensitive backend detail");};
 const api=createCloudOperationsApi({queue,adminEmails:["ops@example.com"]});
 const result=await api.handle({method:"GET",path:"/api/admin/cloud/operations",user:{id:"user-1",email:"ops@example.com",emailVerified:true}});
 assert.equal(result.status,503);
 assert.equal(JSON.stringify(result).includes("sensitive backend detail"),false);
});
