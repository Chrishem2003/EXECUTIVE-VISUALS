import test from "node:test";
import assert from "node:assert/strict";
import { runCloudWorkerCycle } from "../cloud-worker.mjs";

function queueFor({job={id:"job-1"},renew=true,finish=true,failFinish=false}={}) {
 const calls=[];
 return {
  calls,
  async claim(workerId,seconds){calls.push(["claim",workerId,seconds]);return job;},
  async renew(id,workerId,seconds){calls.push(["renew",id,workerId,seconds]);return typeof renew==="function"?renew():renew;},
  async finish(id,workerId,status,output,error){calls.push(["finish",id,workerId,status,output,error]);if(failFinish)throw new Error("finish unavailable");return finish;}
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

test("worker drains an in-flight heartbeat before attempting terminal completion",async()=>{
 const calls=[];
 const queue={
  async claim(){return{id:"job-race"};},
  async renew(){calls.push("renew-start");await new Promise(resolve=>setTimeout(resolve,80));calls.push("renew-end");return false;},
  async finish(){calls.push("finish");return true;}
 };
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-race",leaseSeconds:15,heartbeatIntervalMs:1000,
  execute:async()=>{await new Promise(resolve=>setTimeout(resolve,1050));return{assetId:"asset-late"};}
 });
 assert.equal(result.finished,false);
 assert.equal(result.reason,"lease_lost");
 assert.deepEqual(calls,["renew-start","renew-end"]);
 assert.equal(calls.includes("finish"),false);
});

test("worker cancels before execution when the claimed job carries a cancellation request",async()=>{
 const queue=queueFor({job:{id:"job-pre-cancel",cancel_requested_at:"2026-11-02T10:00:00Z"}});
 let executed=false;
 const result=await runCloudWorkerCycle({queue,workerId:"worker-1",execute:async()=>{executed=true;return{};}});
 assert.equal(executed,false);
 assert.equal(result.status,"cancelled");
 assert.ok(queue.calls.some(call=>call[0]==="finish"&&call[3]==="cancelled"));
});

test("worker observes owner cancellation while executing and persists cancelled state",async()=>{
 const calls=[];
 const queue={
  async claim(){return{id:"job-cancel-live"};},
  async cancellationRequested(){calls.push("poll");return true;},
  async renew(){calls.push("renew");return true;},
  async finish(id,worker,status,output,error){calls.push(status);return true;}
 };
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-cancel",leaseSeconds:15,heartbeatIntervalMs:1000,
  execute:async({signal})=>new Promise(resolve=>{
   const poll=setInterval(()=>{if(signal.aborted){clearInterval(poll);resolve({lateOutput:true});}},10);
  })
 });
 assert.equal(result.status,"cancelled");
 assert.ok(calls.includes("poll"));
 assert.ok(calls.includes("cancelled"));
 assert.equal(calls.includes("renew"),false);
});
