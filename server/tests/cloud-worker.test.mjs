import test from "node:test";
import assert from "node:assert/strict";
import { runCloudWorkerCycle } from "../cloud-worker.mjs";

function queueFor({job={id:"job-1",lease_token:"11111111-1111-4111-8111-111111111111"},renew=true,finish=true,failFinish=false}={}) {
 const calls=[];
 return {
  calls,
  async claim(workerId,seconds){calls.push(["claim",workerId,seconds]);return job;},
  async renew(id,workerId,seconds,leaseToken){calls.push(["renew",id,workerId,seconds,leaseToken]);return typeof renew==="function"?renew():renew;},
  async finish(id,workerId,status,output,error,leaseToken){calls.push(["finish",id,workerId,status,output,error,leaseToken]);if(failFinish)throw new Error("finish unavailable");return finish;},
  async assertLease(id,workerId,leaseToken){calls.push(["assertLease",id,workerId,leaseToken]);return true;}
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
 assert.equal(queue.calls.find(call=>call[0]==="finish")[6],"11111111-1111-4111-8111-111111111111");
 assert.deepEqual(progress,[{jobId:"job-1",workerId:"worker-1",progress:50}]);
 assert.ok(queue.calls.some(call=>call[0]==="finish"&&call[3]==="succeeded"));
 assert.ok(events.some(event=>event.type==="job.succeeded"));
 assert.ok(events.some(event=>event.type==="job.lease_verified"&&event.stage==="worker.finalize"));
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
 const events=[];
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-1",leaseSeconds:15,heartbeatIntervalMs:1000,
  execute:async({signal})=>new Promise(resolve=>{
   const poll=setInterval(()=>{if(signal.aborted){clearInterval(poll);resolve({lateOutput:true});}},10);
  }),
  onEvent:event=>events.push(event)
 });
 assert.equal(result.finished,false);
 assert.equal(result.reason,"lease_lost");
 assert.equal(queue.calls.some(call=>call[0]==="finish"),false);
 assert.ok(events.some(event=>event.type==="job.lease_renewal_rejected"));
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

test("worker refuses to execute a claimed job without a valid fencing token",async()=>{
 const queue=queueFor({job:{id:"job-stale"}});
 let executed=false;
 await assert.rejects(()=>runCloudWorkerCycle({queue,workerId:"worker-1",execute:async()=>{executed=true;return{};}}),/fencing token/);
 assert.equal(executed,false);
});

test("worker drains an in-flight heartbeat before attempting terminal completion",async()=>{
 let heartbeatStarted;
 let releaseHeartbeat;
 const started=new Promise(resolve=>{heartbeatStarted=resolve;});
 const gate=new Promise(resolve=>{releaseHeartbeat=resolve;});
 const queue=queueFor({renew:()=>{heartbeatStarted();return gate;}});
 const events=[];
 const keepAlive=setTimeout(()=>{},5000);
 const running=runCloudWorkerCycle({
  queue,workerId:"worker-1",leaseSeconds:15,heartbeatIntervalMs:1000,
  execute:async()=>{await started;return{assetId:"asset-after-heartbeat"};},
  onEvent:event=>events.push(event)
 });
 await started;
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(queue.calls.some(call=>call[0]==="finish"),false,"finish must wait for the pending lease renewal");
 releaseHeartbeat(true);
 const result=await running;
 clearTimeout(keepAlive);
 assert.equal(result.status,"succeeded");
 assert.equal(queue.calls.some(call=>call[0]==="finish"),true);
 assert.ok(events.some(event=>event.type==="job.lease_renewed"&&event.leaseSeconds===15));
});

test("worker blocks terminal writes when the database rejects the attempt fence",async()=>{
 const queue=queueFor();
 queue.assertLease=async()=>false;
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-1",heartbeatIntervalMs:60000,
  execute:async({assertLease})=>{await assertLease();return{assetId:"must-not-publish"};}
 });
 assert.equal(result.reason,"lease_lost");
 assert.equal(queue.calls.some(call=>call[0]==="finish"),false);
});
