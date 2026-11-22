import test from "node:test";
import assert from "node:assert/strict";
import { readCloudWorkerConfig,createCloudWorkerSupervisor } from "../cloud-worker-process.mjs";

const env={CLOUD_WORKER_ENABLED:"true",CLOUD_MEDIA_WORKER_ENABLED:"true",CLOUD_TIMELINE_WORKER_ENABLED:"true",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"server-secret"};
test("cloud worker config remains disabled unless explicitly enabled",()=>{assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_WORKER_ENABLED:"false"}),/disabled/);});
test("cloud worker accepts the modern Supabase secret key without the legacy service-role variable",()=>{
 const modern={...env,SUPABASE_SECRET_KEY:"sb_secret_modern"};
 delete modern.SUPABASE_SERVICE_ROLE_KEY;
 const config=readCloudWorkerConfig(modern);
 assert.equal(config.media,true);
 assert.equal(config.timeline,true);
});

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
test("cloud worker supervisor rejects missing worker families",()=>{assert.throws(()=>createCloudWorkerSupervisor({workers:[]}),/at least one worker family or maintenance task/);});

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

test("direct Veo models require explicit Runway remote gates and linked-workspace per-generation usage",()=>{
 const base={...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.runwayml.com",
  RUNWAY_VIDEO_MODELS:"veo3.1,veo3.1_fast",RUNWAY_API_KEY:"server-only",
  RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_WORKSPACE_USAGE_ENABLED:"true"};
 const config=readCloudWorkerConfig(base);
 assert.equal(config.video,true);
 assert.throws(()=>readCloudWorkerConfig({...base,RUNWAY_WORKSPACE_USAGE_ENABLED:"false"}),/linked-workspace per-generation usage/);
 assert.throws(()=>readCloudWorkerConfig({...base,RUNWAY_VIDEO_ALLOW_REMOTE:"false"}),/linked-workspace per-generation usage/);
 assert.throws(()=>readCloudWorkerConfig({...base,RUNWAY_VIDEO_MODELS:"gen4.5"}),/other direct Runway profiles/);
});

test("Luma Ray 3.2 can be the only video provider with an explicit account settlement rate",()=>{
 const config=readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"api.lumalabs.ai",
  LUMA_VIDEO_ENABLED:"true",LUMA_VIDEO_ALLOW_REMOTE:"true",LUMA_AGENTS_API_KEY:"server-only",LUMA_USD_PER_CREDIT:"0.003"
 });
 assert.equal(config.video,true);assert.equal(config.luma,true);
});
test("Luma refuses partial remote gates, missing credentials and missing account billing rate",()=>{
 const base={...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"api.lumalabs.ai",
  LUMA_VIDEO_ENABLED:"true",LUMA_VIDEO_ALLOW_REMOTE:"true",LUMA_AGENTS_API_KEY:"server-only",LUMA_USD_PER_CREDIT:"0.003"};
 assert.throws(()=>readCloudWorkerConfig({...base,LUMA_VIDEO_ALLOW_REMOTE:"false"}),/both remote gates/);
 assert.throws(()=>readCloudWorkerConfig({...base,LUMA_AGENTS_API_KEY:""}),/LUMA_AGENTS_API_KEY/);
 assert.throws(()=>readCloudWorkerConfig({...base,LUMA_USD_PER_CREDIT:""}),/account\/contract rate/);
 assert.throws(()=>readCloudWorkerConfig({...base,LUMA_USD_PER_CREDIT:"0"}),/account\/contract rate/);
});
test("Google Omni can be the only video provider when every server-side execution and paid-tier gate is explicit",()=>{
 const config=readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"generativelanguage.googleapis.com",
  GOOGLE_OMNI_VIDEO_ENABLED:"true",GOOGLE_OMNI_VIDEO_ALLOW_REMOTE:"true",
  GEMINI_OMNI_ENABLED:"true",GEMINI_OMNI_ALLOW_REMOTE:"true",GEMINI_OMNI_PAID_TIER_CONFIRMED:"true",
  GEMINI_OMNI_WORKER_ENABLED:"true",GOOGLE_OMNI_CONNECTION_STATUS:"connected",GEMINI_API_KEY:"server-only"
 });
 assert.equal(config.video,true);assert.equal(config.googleOmni,true);
 assert.throws(()=>readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"generativelanguage.googleapis.com",
  GOOGLE_OMNI_VIDEO_ENABLED:"true",GOOGLE_OMNI_VIDEO_ALLOW_REMOTE:"true",
  GEMINI_OMNI_ENABLED:"true",GEMINI_OMNI_ALLOW_REMOTE:"true",GEMINI_OMNI_WORKER_ENABLED:"true",
  GOOGLE_OMNI_CONNECTION_STATUS:"connected",GEMINI_API_KEY:"server-only"
 }),/paid-tier/);
});

test("B2 multipart cleanup requires both the B2 provider and the explicitly enabled upload API",()=>{
 const base={...env,B2_MULTIPART_CLEANUP_WORKER_ENABLED:"true"};
 assert.throws(()=>readCloudWorkerConfig(base),/upload API and B2 storage provider/);
 assert.throws(()=>readCloudWorkerConfig({...base,B2_MULTIPART_UPLOAD_API_ENABLED:"true"}),/upload API and B2 storage provider/);
 const config=readCloudWorkerConfig({...base,B2_MULTIPART_UPLOAD_API_ENABLED:"true",CLOUD_MEDIA_STORAGE_PROVIDER:"b2"});
 assert.equal(config.b2MultipartCleanup,true);
 assert.equal(config.b2MultipartCleanupLimit,25);
 assert.equal(config.b2MultipartCleanupLeaseMs,300000);
 assert.throws(()=>readCloudWorkerConfig({...base,B2_MULTIPART_UPLOAD_API_ENABLED:"true",CLOUD_MEDIA_STORAGE_PROVIDER:"b2",B2_MULTIPART_CLEANUP_BATCH_LIMIT:"101"}),/batch limit/);
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

test("publication cleanup worker can run independently and remains dry-run by default",()=>{
 const config=readCloudWorkerConfig({...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"false",CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED:"true"});
 assert.equal(config.publicationCleanup,true);
 assert.equal(config.media,false);
 assert.equal(config.timeline,false);
 assert.equal(config.video,false);
 assert.equal(config.cleanupDryRun,true);
 assert.equal(config.cleanupConfirmDelete,false);
 assert.equal(config.cleanupOlderThanMs,24*60*60*1000);
});
test("publication cleanup destructive mode requires explicit independent flags",()=>{
 const config=readCloudWorkerConfig({...env,CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED:"true",CLOUD_PUBLICATION_CLEANUP_DELETE_ENABLED:"true",CLOUD_PUBLICATION_CLEANUP_CONFIRM_DELETE:"true"});
 assert.equal(config.cleanupDryRun,false);
 assert.equal(config.cleanupConfirmDelete,true);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED:"true",CLOUD_PUBLICATION_CLEANUP_POLL_MS:"100"}),/poll interval/);
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED:"true",CLOUD_PUBLICATION_CLEANUP_OLDER_THAN_DAYS:"31"}),/age in days/);
});

test("Gemini file cleanup and recovery can run as a maintenance-only worker family",()=>{
 const config=readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",
  CLOUD_VIDEO_WORKER_ENABLED:"false",CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED:"false",
  GOOGLE_GEMINI_FILES_CLEANUP_ENABLED:"true"
 });
 assert.equal(config.geminiFilesCleanup,true);
 assert.equal(config.geminiFilesRecovery,false);
});
test("cloud worker supervisor supports maintenance-only operation",async()=>{
 const calls=[],events=[];
 const supervisor=createCloudWorkerSupervisor({
  workers:[],maintenanceTasks:[async()=>{calls.push("gemini-cleanup");return{scanned:2,deleted:2};}],
  leaseSeconds:60,heartbeatIntervalMs:10000,pollMs:1000,
  onLog:event=>events.push(event)
 });
 await supervisor.start();
 assert.deepEqual(calls,["gemini-cleanup"]);
 assert.ok(events.some(event=>event.kind==="maintenance"&&event.result.deleted===2));
 await supervisor.stop();
});


test("cloud video subscription enforcement requires the dedicated video worker family",()=>{
 assert.throws(()=>readCloudWorkerConfig({...env,CLOUD_VIDEO_SUBSCRIPTION_ENTITLEMENTS_REQUIRED:"true"}),/requires CLOUD_VIDEO_WORKER_ENABLED=true/);
 const enabled=readCloudWorkerConfig({
  ...env,CLOUD_MEDIA_WORKER_ENABLED:"false",CLOUD_TIMELINE_WORKER_ENABLED:"false",CLOUD_VIDEO_WORKER_ENABLED:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"fal.media",
  FAL_VIDEO_MODEL:"fal-ai/wan/v2.7/text-to-video",FAL_KEY:"worker-key",FAL_BILLING_KEY:"billing-key",
  CLOUD_VIDEO_SUBSCRIPTION_ENTITLEMENTS_REQUIRED:"true"
 });
 assert.equal(enabled.video,true);
});
