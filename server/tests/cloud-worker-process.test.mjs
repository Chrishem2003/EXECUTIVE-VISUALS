import test from "node:test";
import assert from "node:assert/strict";
import { readCloudWorkerConfig,createCloudWorkerSupervisor } from "../cloud-worker-process.mjs";

const env={CLOUD_WORKER_ENABLED:"true",CLOUD_MEDIA_WORKER_ENABLED:"true",CLOUD_TIMELINE_WORKER_ENABLED:"true",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"server-secret"};
test("cloud worker config remains disabled unless explicitly enabled",()=>{assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_WORKER_ENABLED:"false"}),/disabled/);});
test("cloud worker config requires a selected worker family and server credentials",()=>{
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false"}),/at least one/);
 assert.throws(()=>readCloudWorkerConfig({...env,SUPABASE_SERVICE_ROLE_KEY:""}),/server-side Supabase credentials/);
});
test("cloud worker config validates lease, heartbeat, polling and byte limits",()=>{
 const config=readCloudWorkerConfig(env);assert.equal(config.media,true);assert.equal(config.timeline,true);assert.equal(config.leaseSeconds,90);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_WORKER_HEARTBEAT_MS:"90000"}),/heartbeat/);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_WORKER_POLL_MS:"10"}),/poll interval/);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_WORKER_LEASE_SECONDS:"30",CLOUD_WORKER_HEARTBEAT_MS:"30000"}),/shorter than the lease/);
});
test("cloud worker supervisor recovers, runs enabled families and stops cleanly",async()=>{
 const events=[],calls=[];
 const workers=[{async recoverExpired(limit){calls.push(["recover",limit]);return 2;},async runCycle(options){calls.push(["media",options.leaseSeconds]);options.onEvent({type:"job.succeeded"});return{claimed:true,jobId:"job-1"};}},
 {async recoverExpired(limit){calls.push(["recover-timeline",limit]);return 0;},async runCycle(options){calls.push(["timeline",options.leaseSeconds]);return{claimed:false};}}];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event)});
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(calls.slice(0,4),[["recover",100],["recover-timeline",100],["media",60],["timeline",60]]);
 assert.ok(events.some(event=>event.kind==="started"));assert.ok(events.some(event=>event.kind==="stopped"));
});
test("cloud worker supervisor rejects missing worker families",()=>{assert.throws(()=>createCloudWorkerSupervisor({workers:[]}),/one or more/);});

test("cloud worker supervisor waits for all families and reports individual failures",async()=>{
 const errors=[],calls=[];
 const workers=[
  {async recoverExpired(){return 0;},async runCycle(){calls.push("failed");throw new Error("queue unavailable");}},
  {async recoverExpired(){return 0;},async runCycle(){await Promise.resolve();calls.push("completed");return{claimed:false};}}
 ];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onError:error=>errors.push(error.message)});
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(calls,["failed","completed"]);assert.deepEqual(errors,["queue unavailable"]);
});

test("cloud video worker may be configured with Runway Model Router without FAL credentials", () => {
 const config=readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.runwayml.com",
  RUNWAY_MODEL_ROUTER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ROUTER_CONFIG:"production-video",RUNWAY_API_KEY:"runway-secret"
 });
 assert.equal(config.video,true);
 assert.throws(()=>readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.runwayml.com",
  RUNWAY_MODEL_ROUTER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_API_KEY:"runway-secret"
 }),/saved config/);
});

test("cloud worker config validates the storage cleanup sweep interval",()=>{
 const config=readCloudWorkerConfig(env);assert.equal(config.cleanupIntervalMs,300000);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_STORAGE_CLEANUP_INTERVAL_MS:"1000"}),/cleanup interval/);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_STORAGE_CLEANUP_INTERVAL_MS:"7200000"}),/cleanup interval/);
});

test("cloud worker supervisor runs maintenance on startup and on its own cadence",async()=>{
 const calls=[],events=[],errors=[];
 const workers=[{async recoverExpired(){calls.push("recover");return 0;},async runCycle(){calls.push("cycle");return{claimed:false};}}];
 const maintenanceTasks=[async()=>{calls.push("cleanup");return{examined:3,removed:2};}];
 const supervisor=createCloudWorkerSupervisor({workers,maintenanceTasks,maintenanceIntervalMs:60000,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event),onError:error=>errors.push(error)});
 await supervisor.start();
 assert.deepEqual(calls,["recover","cleanup","cycle"]);
 assert.ok(events.some(event=>event.kind==="maintenance"&&event.result.removed===2));
 await supervisor.stop();
 assert.deepEqual(errors,[]);
});

test("cloud worker supervisor isolates failed maintenance tasks and still starts workers",async()=>{
 const calls=[],errors=[];
 const workers=[{async recoverExpired(){return 0;},async runCycle(){calls.push("cycle");return{claimed:false};}}];
 const supervisor=createCloudWorkerSupervisor({workers,maintenanceTasks:[async()=>{throw new Error("cleanup unavailable");}],leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onError:error=>errors.push(error.message)});
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(calls,["cycle"]);
 assert.deepEqual(errors,["cleanup unavailable"]);
});

test("cloud worker supervisor rejects invalid maintenance task configuration",()=>{
 const workers=[{async recoverExpired(){return 0;},async runCycle(){return{claimed:false};}}];
 assert.throws(()=>createCloudWorkerSupervisor({workers,maintenanceTasks:[null]}),/maintenance tasks/);
 assert.throws(()=>createCloudWorkerSupervisor({workers,maintenanceTasks:[async()=>{}],maintenanceIntervalMs:1000}),/maintenance interval/);
});
