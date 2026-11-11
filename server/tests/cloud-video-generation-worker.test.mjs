import test from "node:test";
import assert from "node:assert/strict";
import {createCloudVideoGenerationWorker} from "../cloud-video-generation-worker.mjs";

function fixture({job=null,execute=async()=>({ok:true})}={}){
 const calls=[];
 const queue={
  async claim(workerId,leaseSeconds,types){calls.push(["claim",workerId,leaseSeconds,types]);return job;},
  async renew(...args){calls.push(["renew",...args]);return true;},
  async assertLease(){return true;},
  async finish(...args){calls.push(["finish",...args]);return true;},
  async recover(limit){calls.push(["recover",limit]);return 0;}
 };
 const worker=createCloudVideoGenerationWorker({
  workerId:"video-worker-1",queue,assetService:{assets:{async reconcilePendingStorageCleanup(){return{examined:0,removed:0,results:[]};}}},
  mediaIO:{},repositories:{approvals:{},tasks:{}},execute
 });
 return{worker,calls};
}
test("video worker only claims video.generate.shot jobs",async()=>{
 const f=fixture();const result=await f.worker.runCycle();
 assert.deepEqual(result,{claimed:false});
 assert.deepEqual(f.calls[0],["claim","video-worker-1",90,["video.generate.shot"]]);
});
test("video worker executes the claimed shot and completes the shared queue job",async()=>{
 const job={id:"job-1",owner_id:"owner-1",project_id:"project-1",status:"processing",lease_owner:"video-worker-1",lease_token:"923e4567-e89b-42d3-a456-426614174000",lease_expires_at:"2099-01-01T00:00:00Z",input:{approvalId:"approval-1",shotIndex:0}};
 const f=fixture({job,execute:async({job:claimed,onProgress})=>{assert.equal(claimed.id,"job-1");onProgress(100);return{outputAsset:{id:"asset-1"}};}});
 const result=await f.worker.runCycle({heartbeatIntervalMs:1000});
 assert.equal(result.finished,true);assert.equal(result.status,"succeeded");
 const finish=f.calls.find(call=>call[0]==="finish");assert.equal(finish[3],"succeeded");assert.equal(finish[4].outputAsset.id,"asset-1");
});
test("video worker exposes queue lease recovery and private storage cleanup",async()=>{
 const f=fixture();await f.worker.recoverExpired(20);await f.worker.reconcileStorageCleanup(10);
 assert.deepEqual(f.calls,[["recover",20]]);
});
test("video worker rejects invalid worker identity",()=>{
 assert.throws(()=>createCloudVideoGenerationWorker({workerId:"",queue:{},assetService:{assets:{}},mediaIO:{},repositories:{},execute:async()=>({})}),/worker ID/);
});

test("video worker reconciles pending provider cancellations after restart",async()=>{
 const calls=[],pending=[
  {id:"task-1",provider:"fal",providerTaskId:"123e4567-e89b-42d3-a456-426614174000",model:"fal-ai/example"},
  {id:"task-2",provider:"runway",providerTaskId:"223e4567-e89b-42d3-a456-426614174000",model:"seedance2_5"},
  {id:"task-3",provider:"fal",providerTaskId:null,model:"fal-ai/example",state:"reserved"},
  {id:"task-4",provider:"runway",providerTaskId:null,model:"seedance2_5",state:"submission_unknown"}
 ];
 const tasks={
  async claimCancellationPending(workerId,limit){calls.push(["claim",workerId,limit]);return pending;},
  async markCancellationRequested(id,value){calls.push(["requested",id,value]);},
  async markCancelled(id,value){calls.push(["cancelled",id,value]);}
 };
 const worker=createCloudVideoGenerationWorker({
  workerId:"video-worker-1",queue:{async claim(){return null;},async renew(){return true;},async assertLease(){return true;},async finish(){return true;},async recover(){return 0;}},
  assetService:{assets:{}},mediaIO:{},repositories:{approvals:{},tasks},execute:async()=>({}),
  cancellationAdapters:{
   fal:{poll:async({taskId})=>{calls.push(["fal-poll",taskId]);return{status:"RUNNING"};},cancel:async({taskId})=>{calls.push(["fal-cancel",taskId]);return{status:"CANCELLATION_REQUESTED"};}},
   runway:{poll:async({taskId})=>{calls.push(["runway-poll",taskId]);return{status:"CANCELLED"};},cancel:async()=>{throw new Error("must not cancel a terminal task");}}
  }
 });
 const result=await worker.reconcilePendingCancellations(10);
 assert.equal(result.examined,4);assert.equal(result.pending,1);assert.equal(result.confirmed,2);assert.equal(result.errors.length,1);
 assert.ok(calls.some(x=>x[0]==="claim"&&x[1]==="video-worker-1"&&x[2]===10));
 assert.ok(!calls.some(x=>x[0]==="requested"&&x[1]==="task-1"),"pending provider cancellation retains its lease until expiry");
 assert.ok(calls.some(x=>x[0]==="cancelled"&&x[1]==="task-2"&&x[2].providerStatus==="CANCELLED"));
 assert.ok(calls.some(x=>x[0]==="cancelled"&&x[1]==="task-3"&&x[2].providerStatus==="NOT_SUBMITTED"));
 assert.ok(!calls.some(x=>x[0]==="cancelled"&&x[1]==="task-4"));
});
