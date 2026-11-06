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


test("worker persists bounded delivery certification evidence when a profile fails",async()=>{
 const queue=queueFor(),certification={schemaVersion:1,profileId:"vertical-1080p",status:"failed",generatedAt:"2026-11-06T00:00:00.000Z",summary:{passed:5,failed:2,total:7},checks:[{id:"width",expected:1080,actual:1920,passed:false},{id:"height",expected:1920,actual:1080,passed:false}]};
 const result=await runCloudWorkerCycle({
  queue,workerId:"worker-1",heartbeatIntervalMs:60000,
  execute:async()=>{throw Object.assign(new Error("Delivery certification failed: width, height"),{code:"DELIVERY_CERTIFICATION_FAILED",certification});}
 });
 assert.equal(result.status,"failed");
 const finish=queue.calls.find(call=>call[0]==="finish");
 assert.equal(finish[5].code,"DELIVERY_CERTIFICATION_FAILED");
 assert.deepEqual(finish[5].deliveryCertification,certification);
});
