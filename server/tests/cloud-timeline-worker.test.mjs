import test from "node:test";
import assert from "node:assert/strict";
import { createCloudTimelineWorker } from "../cloud-timeline-worker.mjs";

test("timeline worker recovery is scoped to timeline render jobs",async()=>{
 let recoveryArgs=null;
 const queue={async claim(){return null;},async renew(){return true;},async finish(){return true;},async recover(...args){recoveryArgs=args;return 1;}};
 const worker=createCloudTimelineWorker({
  workerId:"timeline-worker-recovery",queue,
  timelineService:{timelines:{get(){}},assets:{}},
  mediaIO:{materialize(){},publish(){}},
  async renderTimeline(){}
 });
 assert.equal(await worker.recoverExpired(12),1);
 assert.deepEqual(recoveryArgs,[12,["timeline.render"]]);
});

test("cloud timeline worker only claims timeline render jobs",async()=>{
 let filters=null;
 const queue={async claim(id,leaseSeconds,jobTypes){filters=jobTypes;return null;},async renew(){return true;},async finish(){return true;},async recover(){return 0;}};
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
  workerId:"timeline-worker-2",queue:{claim(){},renew(){},finish(){},recover(){}},
  timelineService:{timelines:{get(){}},assets:{}},
  mediaIO:{materialize(){},publish(){}}
 }));
});
