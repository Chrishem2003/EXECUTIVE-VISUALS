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
 const workers=[{async recoverExpired(limit){calls.push(["recover-media",limit]);return 2;},async runCycle(options){calls.push(["media",options.leaseSeconds]);options.onEvent({type:"job.succeeded"});return{claimed:true,jobId:"job-1"};}},
 {async recoverExpired(limit){calls.push(["recover-timeline",limit]);return 3;},async runCycle(options){calls.push(["timeline",options.leaseSeconds]);return{claimed:false};}}];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event)});
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(calls.slice(0,4),[["recover-media",100],["recover-timeline",100],["media",60],["timeline",60]]);
 assert.ok(events.some(event=>event.kind==="recovery"&&event.workerIndex===0&&event.count===2));
 assert.ok(events.some(event=>event.kind==="recovery"&&event.workerIndex===1&&event.count===3));
 assert.ok(events.some(event=>event.kind==="started"));assert.ok(events.some(event=>event.kind==="stopped"));
});
test("cloud worker supervisor aborts active worker cycles before waiting for shutdown",async()=>{
 let calls=0,signalSeen=null,announceActive;
 const active=new Promise(resolve=>{announceActive=resolve;});
 const worker={
  async recoverExpired(){return 0;},
  async runCycle({signal}){
   calls++;
   if(calls===1)return{claimed:false};
   signalSeen=signal;announceActive();
   return new Promise(resolve=>signal.addEventListener("abort",()=>resolve({claimed:true,finished:false,reason:"worker_stopping"}),{once:true}));
  }
 };
 const supervisor=createCloudWorkerSupervisor({workers:[worker],leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000});
 await supervisor.start();
 const running=supervisor.runOnce();
 await active;
 const stopping=supervisor.stop();
 const [cycle]=await Promise.all([running,stopping]);
 assert.equal(signalSeen.aborted,true);
 assert.equal(cycle[0].reason,"worker_stopping");
 assert.equal(calls,2);
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

test("cloud worker supervisor recovers every pool independently when one recovery fails",async()=>{
 const errors=[],events=[];
 const workers=[
  {async recoverExpired(){throw new Error("media recovery unavailable");},async runCycle(){return{claimed:false};}},
  {async recoverExpired(){return 4;},async runCycle(){return{claimed:false};}}
 ];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event),onError:error=>errors.push(error.message)});
 await supervisor.start();await supervisor.stop();
 assert.deepEqual(errors,["media recovery unavailable"]);
 assert.ok(events.some(event=>event.kind==="recovery"&&event.workerIndex===1&&event.count===4));
 assert.ok(events.some(event=>event.kind==="started"));
});

test("cloud worker supervisor shutdown waits for startup recovery and does not restart timers",async()=>{
 let releaseRecovery,stopFinished=false,cycles=0;
 const recoveryGate=new Promise(resolve=>{releaseRecovery=resolve;});
 const workers=[{
  async recoverExpired(){await recoveryGate;return 0;},
  async runCycle(){cycles++;return{claimed:false};}
 }];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000});
 const starting=supervisor.start();
 await Promise.resolve();
 const stopping=supervisor.stop().then(()=>{stopFinished=true;});
 await Promise.resolve();
 assert.equal(stopFinished,false);
 releaseRecovery();
 await Promise.all([starting,stopping]);
 assert.equal(stopFinished,true);
 assert.equal(cycles,0);
});
