import test from "node:test";
import assert from "node:assert/strict";
import { createCloudTimelineWorker } from "../cloud-timeline-worker.mjs";

test("cloud timeline worker only claims timeline render jobs",async()=>{
 let filters=null;
 const queue={async claim(id,leaseSeconds,jobTypes){filters=jobTypes;return null;},async renew(){return true;},async assertLease(){return true;},async finish(){return true;},async recover(){return 0;}};
 const worker=createCloudTimelineWorker({
  workerId:"timeline-worker-1",queue,
  timelineService:{timelines:{get(){}},assets:{}},
  mediaIO:{materialize(){},publish(){}},
  async renderTimeline(){}
 });
 assert.deepEqual(await worker.runCycle(),{claimed:false});
 assert.deepEqual(filters,["timeline.render"]);
});

test("cloud timeline worker defaults to the cloud FFmpeg renderer",()=>{
 assert.doesNotThrow(()=>createCloudTimelineWorker({
  workerId:"timeline-worker-2",queue:{claim(){},renew(){},assertLease(){return true;},finish(){},recover(){}},
  timelineService:{timelines:{get(){}},assets:{}},
  mediaIO:{materialize(){},publish(){}}
 }));
});

test("cloud timeline worker forwards owner cancellation to the generic worker",async()=>{
 const calls=[];const queue={
  async claim(){return{id:"timeline-job",lease_token:"11111111-1111-4111-8111-111111111111"};},
  async cancellationRequested(){calls.push("cancel-check");return true;},
  async renew(){return true;},async assertLease(){return true;},
  async finish(id,worker,status,output,error){calls.push(status);return true;},async recover(){return 0;}
 };
 const worker=createCloudTimelineWorker({workerId:"timeline-worker-cancel",queue,timelineService:{timelines:{get(){}},assets:{}},mediaIO:{materialize(){},publish(){}},async renderTimeline(){}});
 const result=await worker.runCycle();
 assert.equal(result.status,"cancelled");assert.deepEqual(calls,["cancel-check","cancelled"]);
});
