import test from "node:test";
import assert from "node:assert/strict";
import {createCloudVideoGenerationWorker} from "../cloud-video-generation-worker.mjs";

function fixture({job=null,execute=async()=>({ok:true})}={}){
 const calls=[];
 const queue={
  async claim(workerId,leaseSeconds,types){calls.push(["claim",workerId,leaseSeconds,types]);return job;},
  async renew(...args){calls.push(["renew",...args]);return true;},
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
 const job={id:"job-1",owner_id:"owner-1",project_id:"project-1",status:"processing",lease_owner:"video-worker-1",lease_expires_at:"2099-01-01T00:00:00Z",input:{approvalId:"approval-1",shotIndex:0}};
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
