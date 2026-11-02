import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableCloudJobError, runCloudWorkerCycle } from "../cloud-worker.mjs";

function queueFor({job={id:"job-1"},renew=true,finish=true,failFinish=false,retry={accepted:true,status:"queued",retryable:true,delaySeconds:2,attempt:1,maxAttempts:3}}={}) {
 const calls=[];
 return {
  calls,
  async claim(workerId,seconds){calls.push(["claim",workerId,seconds]);return job;},
  async renew(id,workerId,seconds){calls.push(["renew",id,workerId,seconds]);return typeof renew==="function"?renew():renew;},
  async retry(id,workerId,error){calls.push(["retry",id,workerId,error]);return retry;},\n  async finish(id,workerId,status,output,error){calls.push(["finish",id,workerId,status,output,error]);if(failFinish)throw new Error("finish unavailable");return finish;}
 };
}

test("idle cloud worker exits without executing",async()=>{
 const queue=queueFor({job:null});
 let ran=false;
 const result=await runCloudWorkerCycle({queue,workerId:"worker-1",execute:async()=>{ran=true;}});
 assert.deepEqual(result,{claimed:false});
 assert.equal(ran,false);
});

test("cloud worker executes and finishes success under its lease",async()=>{
 const queue=queueFor();
 const events=[],progress=[];
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-1",heartbeatIntervalMs:60000,
  execute:async({job,onProgress,signal})=>{assert.equal(job.id,"job-1");assert.equal(signal.aborted,false);onProgress(50);return{assetId:"asset-1"};},
  onEvent:event=>events.push(event),onProgress:event=>progress.push(event)
 });
 assert.equal(result.finished,true);
 assert.equal(result.status,"succeeded");
 assert.deepEqual(progress,[{jobId:"job-1",workerId:"worker-1",progress:50}]);
 assert.ok(queue.calls.some(call=>call[0]==="finish"&&call[3]==="succeeded"));
 assert.ok(events.some(event=>event.type==="job.succeeded"));
});

test("worker failure is persisted as a bounded failed-job result",async()=>{
 const queue=queueFor();
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-1",heartbeatIntervalMs:60000,
  execute:async()=>{throw Object.assign(new Error("render failed"),{code:"RENDER_FAILED"});}
 });
 assert.equal(result.status,"failed");
 const finish=queue.calls.find(call=>call[0]==="finish");
 assert.equal(finish[3],"failed");
 assert.deepEqual(finish[5],{code:"RENDER_FAILED",message:"render failed"});
});

test("worker stops and does not finish when lease renewal is lost",async()=>{
 const queue=queueFor({renew:false});
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-1",leaseSeconds:15,heartbeatIntervalMs:1000,
  execute:async({signal})=>new Promise(resolve=>{
   const poll=setInterval(()=>{if(signal.aborted){clearInterval(poll);resolve({lateOutput:true});}},10);
  })
 });
 assert.equal(result.finished,false);
 assert.equal(result.reason,"lease_lost");
 assert.equal(queue.calls.some(call=>call[0]==="finish"),false);
});

test("worker waits for an in-flight lease renewal before terminal success",async()=>{
 let releaseRenewal;
 let renewalStarted=false;
 const calls=[];
 const queue={
  async claim(){return{id:"job-race"};},
  async renew(){renewalStarted=true;return new Promise(resolve=>{releaseRenewal=resolve;});},
  async finish(id,worker,status){calls.push(status);return true;}
 };
 const cycle=runCloudWorkerCycle({
  queue,workerId:"worker-race",leaseSeconds:15,heartbeatIntervalMs:1000,
  execute:async()=>{await new Promise(resolve=>setTimeout(resolve,1100));return{assetId:"asset-race"};}
 });
 while(!renewalStarted)await new Promise(resolve=>setTimeout(resolve,10));
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.deepEqual(calls,[],"job must not finish while lease renewal is unresolved");
 releaseRenewal(true);
 const result=await cycle;
 assert.equal(result.status,"succeeded");
 assert.deepEqual(calls,["succeeded"]);
});
 
test("worker validates inputs and output before finishing",async()=>{
 const queue=queueFor();
 await assert.rejects(()=>runCloudWorkerCycle({queue,workerId:"",execute:async()=>({})}),/worker ID/i);
 await assert.rejects(()=>runCloudWorkerCycle({queue,workerId:"worker-1",execute:async()=>({}),leaseSeconds:15,heartbeatIntervalMs:15000}),/Heartbeat interval/);
 const invalid=await runCloudWorkerCycle({
  queue:queueFor(),workerId:"worker-1",heartbeatIntervalMs:60000,
  execute:async()=>[]
 });
 assert.equal(invalid.status,"failed");
});

test("transient infrastructure errors schedule bounded retries instead of terminal failure",async()=>{
 const queue=queueFor();
 const events=[];
 const result=await runCloudWorkerCycle({queue,workerId:"worker-1",heartbeatIntervalMs:60000,execute:async()=>{throw Object.assign(new Error("storage temporarily unavailable"),{code:"CLOUD_STORAGE_TIMEOUT"});},onEvent:event=>events.push(event)});
 assert.equal(result.status,"queued");
 assert.equal(result.retryScheduled,true);
 assert.equal(result.retryAfterSeconds,2);
 assert.equal(queue.calls.some(call=>call[0]==="finish"),false);
 assert.ok(queue.calls.some(call=>call[0]==="retry"&&call[3].retryable===true));
 assert.ok(events.some(event=>event.type==="job.retry_scheduled"));
});
test("permanent media validation errors remain terminal and are never retried",async()=>{
 const queue=queueFor();
 const result=await runCloudWorkerCycle({queue,workerId:"worker-1",heartbeatIntervalMs:60000,execute:async()=>{throw Object.assign(new Error("unsupported media type"),{code:"UNSUPPORTED_MEDIA_TYPE"});}});
 assert.equal(result.status,"failed");
 assert.equal(queue.calls.some(call=>call[0]==="retry"),false);
 assert.ok(queue.calls.some(call=>call[0]==="finish"&&call[3]==="failed"));
});
test("retry classification is explicit and does not retry arbitrary HTTP failures",()=>{
 assert.equal(isRetryableCloudJobError({code:"CLOUD_QUEUE_TIMEOUT"}),true);
 assert.equal(isRetryableCloudJobError({code:"CLOUD_STORAGE_HTTP_503"}),true);
 assert.equal(isRetryableCloudJobError({status:429}),true);
 assert.equal(isRetryableCloudJobError({code:"CLOUD_STORAGE_HTTP_403",status:403}),false);
 assert.equal(isRetryableCloudJobError({code:"UNSUPPORTED_MEDIA_TYPE"}),false);
 assert.equal(isRetryableCloudJobError({code:"MEDIA_PROCESS_FAILED"}),false);
});
