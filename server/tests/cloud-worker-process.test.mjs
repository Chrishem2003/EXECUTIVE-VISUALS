import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readCloudWorkerConfig,createCloudWorkerSupervisor,registerCloudWorkerShutdownHandlers } from "../cloud-worker-process.mjs";

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


test("shutdown handlers are installed before worker startup can await recovery",async()=>{
 const signals=new EventEmitter(),calls=[];
 let releaseStop;
 const stopGate=new Promise(resolve=>{releaseStop=resolve;});
 const supervisor={async stop(){calls.push("stop-started");await stopGate;calls.push("stop-finished");}};
 const exits=[];
 const unregister=registerCloudWorkerShutdownHandlers(supervisor,signals,code=>exits.push(code));
 const handlerCount=signals.listenerCount("SIGTERM");
 assert.equal(handlerCount,1);
 signals.emit("SIGTERM");
 await Promise.resolve();
 assert.deepEqual(calls,["stop-started"]);
 assert.deepEqual(exits,[]);
 releaseStop();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,["stop-started","stop-finished"]);
 assert.deepEqual(exits,[0]);
 unregister();
 assert.equal(signals.listenerCount("SIGTERM"),0);
 assert.equal(signals.listenerCount("SIGINT"),0);
});

test("cooperative cancellation migration keeps accepted requests cancelled through lease recovery",async()=>{
 const sql=await readFile(new URL("../../supabase/migrations/20261103190000_cooperative_cloud_media_cancellation.sql",import.meta.url),"utf8");
 const recovery=sql.slice(sql.lastIndexOf("create or replace function executive_visuals.recover_expired_jobs_by_type"));
 assert.match(recovery,/expired\.cancel_requested_at is not null/);
 assert.match(recovery,/next_status := 'cancelled'/);
 assert.match(recovery,/when next_status = 'cancelled' then 'job\.cancelled'/);
 assert.match(recovery,/grant execute on function executive_visuals\.recover_expired_jobs_by_type\(integer, text\[\]\) to service_role/);
});

test("cloud worker supervisor exposes sanitized health counters for recovery and job cycles",async()=>{
 const events=[];
 const workers=[
  {async recoverExpired(){return 2;},async runCycle(){return{claimed:true,finished:true,jobId:"job-a"};}},
  {async recoverExpired(){return 3;},async runCycle(){return{claimed:false};}}
 ];
 const supervisor=createCloudWorkerSupervisor({workers,leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,onLog:event=>events.push(event)});
 await supervisor.start();
 const running=supervisor.snapshot();
 assert.equal(running.status,"running");
 assert.equal(running.workerFamilies,2);
 assert.equal(running.cycles,1);
 assert.equal(running.jobsClaimed,1);
 assert.equal(running.recoveredJobs,5);
 assert.ok(running.startedAt);
 assert.ok(running.lastCycleAt);
 assert.ok(running.lastRecoveryAt);
 assert.equal("serviceRoleKey" in running,false);
 await supervisor.stop();
 assert.equal(supervisor.snapshot().status,"stopped");
 assert.ok(events.some(event=>event.kind==="started"&&event.snapshot?.status==="running"));
 assert.ok(events.some(event=>event.kind==="stopped"&&event.snapshot?.status==="stopped"));
});
test("cloud worker supervisor validates health reporting interval",()=>{
 assert.throws(()=>createCloudWorkerSupervisor({workers:[{runCycle:async()=>({claimed:false}),recoverExpired:async()=>0}],healthIntervalMs:1000}),/health interval/);
});

test("supervisor persists running, stopping and stopped heartbeats for each worker family",async()=>{
 const heartbeats=[];
 const worker={workerId:"media-worker-1",workerFamily:"media",async reportHeartbeat(value){heartbeats.push(value);return{accepted:true,lastSeenAt:"2026-11-03T12:00:00Z"};},async recoverExpired(){return 0;},async runCycle(){return{claimed:false};}};
 const supervisor=createCloudWorkerSupervisor({workers:[worker],instanceId:"instance-test",pollMs:1000,healthIntervalMs:60000});
 await supervisor.start();
 assert.equal(heartbeats[0].status,"running");
 assert.equal(heartbeats[0].instanceId,"instance-test");
 await supervisor.stop();
 assert.deepEqual(heartbeats.map(item=>item.status),["running","stopping","stopped"]);
 assert.equal(supervisor.snapshot().lastHeartbeatAt,"2026-11-03T12:00:00Z");
});

test("durable heartbeat migration restricts metadata and service-role execution",async()=>{
 const sql=await readFile(new URL("../../supabase/migrations/20261103200000_durable_cloud_worker_heartbeats.sql",import.meta.url),"utf8");
 assert.match(sql,/create table if not exists executive_visuals\.worker_heartbeats/);
 assert.match(sql,/enable row level security/);
 assert.match(sql,/revoke all on table executive_visuals\.worker_heartbeats from public, anon, authenticated/);
 assert.match(sql,/grant execute on function executive_visuals\.heartbeat_worker\(text,text,text,text,jsonb\) to service_role/);
 assert.match(sql,/worker heartbeat contains unsupported metrics/);
 assert.match(sql,/last_seen_at=clock_timestamp\(\)/);
});

test("worker health snapshot migration computes stale state and restricts access",async()=>{
 const sql=await readFile(new URL("../../supabase/migrations/20261103210000_cloud_worker_health_snapshot.sql",import.meta.url),"utf8");
 assert.match(sql,/create or replace function executive_visuals\.list_worker_health/);
 assert.match(sql,/last_seen_at < clock_timestamp\(\) - make_interval\(secs => p_stale_after_seconds\)/);
 assert.match(sql,/then 'stale'/);
 assert.match(sql,/revoke all on function executive_visuals\.list_worker_health\(integer,integer\) from public, anon, authenticated/);
 assert.match(sql,/grant execute on function executive_visuals\.list_worker_health\(integer,integer\) to service_role/);
 assert.match(sql,/p_stale_after_seconds not between 30 and 3600/);
});
