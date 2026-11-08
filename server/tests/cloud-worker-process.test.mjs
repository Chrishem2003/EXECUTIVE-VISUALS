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
 const workers=[{async recoverExpired(limit){calls.push(["recover",limit]);return 2;},async reconcileStorageCleanup(limit){calls.push(["cleanup",limit]);return{examined:1,removed:1,results:[]};},async runCycle(options){calls.push(["media",options.leaseSeconds]);options.onEvent({type:"job.succeeded"});return{claimed:true,jobId:"job-1"};}},
 {async recoverExpired(){return 0;},async runCycle(options){calls.push(["timeline",options.leaseSeconds]);return{claimed:false};}}];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event)});
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(calls.slice(0,4),[["recover",100],["cleanup",20],["media",60],["timeline",60]]);
 assert.ok(events.some(event=>event.kind==="storage_cleanup"&&event.removed===1));
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

test("cloud worker supervisor starts without waiting for the first long-running job and drains it on stop",async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});let executionStarted=false,stopped=false;
 const workers=[{async recoverExpired(){return 0;},async runCycle(){executionStarted=true;await gate;return{claimed:true,jobId:"long-render"};}}];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:10000,recoveryIntervalMs:300000});
 await supervisor.start();
 assert.equal(executionStarted,true,"the first worker cycle should start immediately");
 const stopping=supervisor.stop().then(()=>{stopped=true;});
 await Promise.resolve();
 assert.equal(stopped,false,"shutdown should wait for the active leased job to settle");
 release();await stopping;
 assert.equal(stopped,true);
});
test("cloud worker supervisor does not start timers or claim work if stopped during startup recovery",async()=>{
 let releaseRecovery,recoveryStarted;const started=new Promise(resolve=>{recoveryStarted=resolve;});
 const recovery=new Promise(resolve=>{releaseRecovery=resolve;});let ran=false;
 const workers=[{async recoverExpired(){recoveryStarted();await recovery;return 0;},async runCycle(){ran=true;return{claimed:false};}}];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:10000,recoveryIntervalMs:300000});
 const starting=supervisor.start();await started;await supervisor.stop();releaseRecovery();await starting;
 assert.equal(ran,false,"a stopped supervisor must not claim jobs after startup recovery finishes");
});
