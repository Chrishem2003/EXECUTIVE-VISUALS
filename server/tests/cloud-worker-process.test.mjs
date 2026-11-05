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

test("cloud video worker requires an explicit bounded output-host allowlist",()=>{
 const videoEnv={...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true"};
 assert.throws(()=>readCloudWorkerConfig(videoEnv),/output-host allowlist/);
 assert.throws(()=>readCloudWorkerConfig({...videoEnv,CLOUD_VIDEO_OUTPUT_ALLOWED_HOSTS:"*.runwayml.com,not a host"}),/output-host allowlist/);
 assert.throws(()=>readCloudWorkerConfig({...videoEnv,CLOUD_VIDEO_OUTPUT_ALLOWED_HOSTS:"*.runwayml.com,cdn..runwayml.com"}),/output-host allowlist/);
 assert.throws(()=>readCloudWorkerConfig({...videoEnv,CLOUD_VIDEO_OUTPUT_ALLOWED_HOSTS:"*.runwayml.com,-bad.runwayml.com"}),/output-host allowlist/);
 const config=readCloudWorkerConfig({...videoEnv,CLOUD_VIDEO_OUTPUT_ALLOWED_HOSTS:"*.runwayml.com,cdn.runwayml.com"});
 assert.equal(config.video,true);
 assert.deepEqual(config.videoAllowedOutputHosts,["*.runwayml.com","cdn.runwayml.com"]);
 assert.equal(config.media,false);
 assert.equal(config.timeline,false);
});
test("video worker remains an explicit opt-in and cannot replace the existing media families",()=>{
 const config=readCloudWorkerConfig(env);
 assert.equal(config.video,false);
 assert.equal(config.media,true);
 assert.equal(config.timeline,true);
});

test("cloud worker supervisor runs optional maintenance tasks and waits for them on shutdown",async()=>{
 const events=[],calls=[];
 const workers=[{async recoverExpired(){return 0;},async runCycle(){return{claimed:false};}}];
 const maintenanceWorkers=[{async run(){calls.push("retention");return{scanned:3,reconciled:1,quarantined:1,deleted:2,retryPending:1};}}];
 const supervisor=createCloudWorkerSupervisor({
  workers,maintenanceWorkers,maintenanceIntervalMs:10000,leaseSeconds:60,
  heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event)
 });
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(calls,["retention"]);
 assert.ok(events.some(event=>event.kind==="maintenance"&&event.result.deleted===2&&event.result.reconciled===1&&event.result.quarantined===1));
 assert.ok(events.some(event=>event.kind==="started"&&event.maintenanceWorkers===1));
});

test("cloud worker supervisor validates optional maintenance worker contracts",()=>{
 const workers=[{async recoverExpired(){return 0;},async runCycle(){return{claimed:false};}}];
 assert.throws(()=>createCloudWorkerSupervisor({workers,maintenanceWorkers:[{}]}),/maintenance workers/);
 assert.throws(()=>createCloudWorkerSupervisor({workers,maintenanceWorkers:[],maintenanceIntervalMs:1000}),/maintenance interval/);
});

test("cloud maintenance workers honor independent intervals",async()=>{
 let clock=1_000_000;
 const calls=[],events=[];
 const workers=[{async recoverExpired(){return 0;},async runCycle(){return{claimed:false};}}];
 const maintenanceWorkers=[
  {intervalMs:10_000,async run(){calls.push("cleanup");return{deleted:1};}},
  {intervalMs:60_000,async run(){calls.push("recovery");return{reconciled:1};}}
 ];
 const supervisor=createCloudWorkerSupervisor({
  workers,maintenanceWorkers,maintenanceIntervalMs:10_000,now:()=>clock,
  leaseSeconds:60,heartbeatIntervalMs:10_000,pollMs:1000,onLog:event=>events.push(event)
 });
 await supervisor.start();
 assert.deepEqual(calls,["cleanup","recovery"]);
 clock+=10_000;
 await supervisor.runMaintenanceOnce();
 assert.deepEqual(calls,["cleanup","recovery","cleanup"]);
 clock+=50_000;
 await supervisor.runMaintenanceOnce();
 assert.deepEqual(calls,["cleanup","recovery","cleanup","cleanup","recovery"]);
 assert.ok(events.some(event=>event.kind==="maintenance"&&event.workerIndex===0));
 assert.ok(events.some(event=>event.kind==="maintenance"&&event.workerIndex===1));
 await supervisor.stop();
});

test("cloud maintenance worker intervals are individually bounded",()=>{
 const workers=[{async recoverExpired(){return 0;},async runCycle(){return{claimed:false};}}];
 assert.throws(()=>createCloudWorkerSupervisor({
  workers,maintenanceWorkers:[{intervalMs:9999,async run(){}}]
 }),/maintenance worker interval/);
 assert.throws(()=>createCloudWorkerSupervisor({
  workers,maintenanceWorkers:[{intervalMs:86400001,async run(){}}]
 }),/maintenance worker interval/);
});
