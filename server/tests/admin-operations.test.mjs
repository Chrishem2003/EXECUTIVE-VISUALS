import test from "node:test";
import assert from "node:assert/strict";
import {isPlatformAdministrator,getAdminOperationsOverview,listAdminOperationUsers,listAdminOperationJobs,listAdminOperationAudit,buildAdminProviderReadiness,buildAdminProviderReadinessSummary,buildVideoDispatchReadiness} from "../admin-operations.mjs";
function fakeDb(){
 const calls=[];
 return {calls,prepare(sql){return {get(...args){calls.push({sql,args});if(sql.includes("SELECT (SELECT COUNT(*)"))return {users:3,projects:4,assets:5,jobs:6};if(sql.includes("SUM(estimated_cost_micros)"))return {operations:7,estimatedCostMicros:890000};throw new Error("Unexpected get query");},all(...args){calls.push({sql,args});if(sql.includes("GROUP BY status"))return [{status:"queued",count:2},{status:"failed",count:1}];if(sql.includes("FROM users u"))return [{id:"u1",email:"a@example.com",auth_source:"supabase",created_at:"2026-11-01",projects:2,jobs:3,usage30d:4}];if(sql.includes("FROM jobs j"))return [{id:"j1",email:"a@example.com",job_type:"video.generate",status:"queued",progress:0,attempt_count:1,created_at:"2026-11-01",updated_at:"2026-11-01",completed_at:null}];if(sql.includes("FROM audit_events a"))return [{id:1,owner_id:"u1",email:"a@example.com",event_type:"project.created",subject_type:"project",subject_id:"p1",created_at:"2026-11-01"}];throw new Error("Unexpected all query");}};}};
}
test("platform administrator access requires an explicit case-insensitive allowlist",()=>{
 assert.equal(isPlatformAdministrator({email:"ADMIN@example.com"},{ADMIN_EMAILS:"admin@example.com"}),true);
 assert.equal(isPlatformAdministrator({email:"admin@example.com"},{ADMIN_EMAILS:""}),false);
 assert.equal(isPlatformAdministrator({email:"other@example.com"},{ADMIN_EMAILS:"admin@example.com"}),false);
});
test("overview exposes aggregate operating metrics and configured runtime boundaries",()=>{
 const result=getAdminOperationsOverview(fakeDb(),{authMode:"supabase",dataPersistence:"unverified",persistentDataRequired:true,now:Date.parse("2026-11-11T00:00:00Z")});
 assert.equal(result.users,3);assert.equal(result.jobsByStatus.queued,2);assert.equal(result.usage30d.estimatedCostMicros,890000);assert.equal(result.runtime.persistentDataRequired,true);
});
test("admin account search treats SQL LIKE wildcard characters as literal text",()=>{
 const db=fakeDb();listAdminOperationUsers(db,{query:"100%_\\",limit:50});
 assert.equal(db.calls[0].args[1],"100\\%\\_\\\\");
 assert.match(db.calls[0].sql,/ESCAPE/);
 assert.equal(db.calls[0].args[4],50);
});
test("admin directory and execution feeds return bounded, redacted operational fields",()=>{
 const db=fakeDb();const users=listAdminOperationUsers(db,{query:"a@",limit:500});const jobs=listAdminOperationJobs(db,{limit:10});const audit=listAdminOperationAudit(db,{limit:10});listAdminOperationJobs(db,{limit:null});
 assert.equal(users[0].email,"a@example.com");assert.equal(users[0].usage30d,4);assert.equal(jobs[0].jobType,"video.generate");assert.equal(audit[0].eventType,"project.created");
 assert.equal(db.calls[0].args[0].length>0,true);assert.equal(db.calls[0].args[1],"a@");assert.equal(db.calls[0].args[2],"a@");assert.equal(db.calls[0].args[3],"a@");assert.equal(db.calls[0].args[4],200);assert.equal(db.calls[3].args[0],100);
});

test("admin provider diagnostics expose model capability and pricing metadata without credentials or raw evidence",()=>{
 const providers=buildAdminProviderReadiness({providers:[{
  id:"video",provider:"runway",status:"ready",enabled:true,configured:true,remote:true,model:"seedance2_5",reason:"Configured",
  capabilities:["video.generate"],apiKey:"super-secret",authorization:"Bearer secret",
  availableModels:[{id:"seedance2_5",label:"Seedance 2.5",readiness:"adapter-supported",resolutions:["480p","720p"],aspectRatios:["16:9"],inputModes:["text-to-video"],qualityEvidence:{fixtureId:"private-fixture"}}],
  modelCapabilities:{startFrame:true,endFrame:false,referenceImages:true,audioModes:["generate"],resolutions:["720p"],aspectRatios:["16:9"],minDurationSeconds:4,maxDurationSeconds:30,secret:"never-return"},
  pricing:{configured:true,rejectedCount:1,apiKey:"secret",models:[{provider:"runway",model:"seedance2_5",currency:"USD",sourceUrl:"https://example.test/pricing",observedAt:"2026-11-11",expiresAt:"2026-12-01",token:"secret"}]}
 }]});
 assert.equal(providers.length,1);
 assert.equal(providers[0].availableModels[0].label,"Seedance 2.5");
 assert.deepEqual(providers[0].modelCapabilities.resolutions,["720p"]);
 assert.equal(providers[0].pricing.models[0].model,"seedance2_5");
 assert.equal(providers[0].apiKey,undefined);
 assert.equal(JSON.stringify(providers).includes("super-secret"),false);
 assert.equal(JSON.stringify(providers).includes("private-fixture"),false);
 assert.equal(JSON.stringify(providers).includes("never-return"),false);
 assert.equal(JSON.stringify(providers).includes('"token"'),false);
});

test("provider readiness summary counts status buckets and model verification from safe diagnostics",()=>{
 const summary=buildAdminProviderReadinessSummary([
  {status:"ready",availableModels:[{qualityVerified:true},{qualityVerified:false}]},
  {status:"remote_opt_in_required",availableModels:[{qualityVerified:true}]},
  {status:"needs_configuration",availableModels:[]},
  {status:"unavailable",availableModels:[]},
  {status:"disabled",availableModels:[]},
  {status:"unverified",availableModels:[]}
 ]);
 assert.deepEqual(summary,{total:6,ready:1,disabled:1,unverified:1,needsConfiguration:1,remoteOptInRequired:1,unavailable:1,models:3,qualityVerifiedModels:2});
 assert.deepEqual(buildAdminProviderReadinessSummary(null),{total:0,ready:0,disabled:0,unverified:0,needsConfiguration:0,remoteOptInRequired:0,unavailable:0,models:0,qualityVerifiedModels:0});
});


test("video dispatch readiness reports missing prerequisites without exposing secrets or submitting work",()=>{
 const blocked=buildVideoDispatchReadiness({
  env:{AUTH_MODE:"supabase",CLOUD_TIMELINE_API_ENABLED:"true",CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED:"false",SUPABASE_URL:"https://project.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"super-secret"},
  providerCatalog:{providers:[{id:"video",provider:"fal",model:"seedance",status:"ready",remote:true,capabilities:["video.generate"]}]},
  dataPersistence:"unverified"
 });
 assert.equal(blocked.status,"blocked");
 assert.equal(blocked.canSubmit,false);
 assert.equal(blocked.checks.supabaseAuth,true);
 assert.equal(blocked.checks.cloudTimelineApi,true);
 assert.equal(blocked.checks.cloudDispatch,false);
 assert.equal(blocked.checks.supabaseServiceCredentials,true);
 assert.equal(blocked.checks.videoProviderReady,true);
 assert.equal(blocked.blockers.length,1);
 assert.equal(blocked.appDataPersistenceWarning!==null,true);
 assert.equal(JSON.stringify(blocked).includes("super-secret"),false);
 assert.equal(blocked.policy.requestsSubmitted,false);
 assert.equal(blocked.policy.chargesInitiated,false);
});
test("video dispatch readiness is ready only when authentication, cloud storage, dispatch and provider gates pass",()=>{
 const result=buildVideoDispatchReadiness({
  env:{AUTH_MODE:"supabase",CLOUD_TIMELINE_API_ENABLED:"true",CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED:"true",SUPABASE_URL:"https://project.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"server-only"},
  providerCatalog:{providers:[{id:"video",provider:"runway",model:"gen4.5",status:"ready",remote:true,capabilities:["video.generate"]}]},
  dataPersistence:"operator-confirmed-volume"
 });
 assert.equal(result.status,"ready");
 assert.equal(result.canSubmit,true);
 assert.deepEqual(result.blockers,[]);
 assert.equal(result.videoProvider.provider,"runway");
 assert.equal(result.videoProvider.remote,true);
 assert.equal(result.appDataPersistenceWarning,null);
});
test("video dispatch readiness blocks unconfigured or non-ready video providers",()=>{
 for(const provider of [null,{id:"video",status:"remote_opt_in_required",reason:"Remote execution needs approval."}]){
  const result=buildVideoDispatchReadiness({
   env:{AUTH_MODE:"supabase",CLOUD_TIMELINE_API_ENABLED:"true",CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED:"true",SUPABASE_URL:"https://project.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"server-only"},
   providerCatalog:{providers:provider?[provider]:[]}
  });
  assert.equal(result.canSubmit,false);
  assert.equal(result.checks.videoProviderReady,false);
  assert.equal(result.blockers.some(item=>item.check==="videoProviderReady"),true);
 }
});


test("admin execution monitor classifies worker leases as active, expired, missing or not running",()=>{
 let sql="";
 const rows=[
  {id:"active",email:"a@example.com",job_type:"video.generate",status:"running",progress:20,attempt_count:1,created_at:"2026-11-11T11:00:00Z",updated_at:"2026-11-11T12:04:00Z",lease_expires_at:"2026-11-11T12:06:00Z",lease_heartbeat_at:"2026-11-11T12:04:00Z"},
  {id:"expired",email:"b@example.com",job_type:"video.generate",status:"running",progress:20,attempt_count:2,created_at:"2026-11-11T11:00:00Z",updated_at:"2026-11-11T11:50:00Z",lease_expires_at:"2026-11-11T12:00:00Z",lease_heartbeat_at:"2026-11-11T11:50:00Z"},
  {id:"missing",email:"c@example.com",job_type:"video.generate",status:"running",progress:5,attempt_count:1,created_at:"2026-11-11T11:00:00Z",updated_at:"2026-11-11T11:00:00Z",lease_expires_at:null,lease_heartbeat_at:null},
  {id:"queued",email:"d@example.com",job_type:"video.generate",status:"queued",progress:0,attempt_count:0,created_at:"2026-11-11T11:00:00Z",updated_at:"2026-11-11T11:00:00Z",lease_expires_at:null,lease_heartbeat_at:null}
 ];
 const db={prepare(query){sql=query;return{all(){return rows;}};}};
 const result=listAdminOperationJobs(db,{now:Date.parse("2026-11-11T12:05:00Z")});
 assert.match(sql,/lease_expires_at/);
 assert.match(sql,/lease_heartbeat_at/);
 assert.deepEqual(result.map(row=>row.leaseState),["active","expired","missing","not_running"]);
 assert.equal(result[0].leaseHeartbeatAt,"2026-11-11T12:04:00Z");
 assert.equal(result[1].leaseExpiresAt,"2026-11-11T12:00:00Z");
});


test("administrator readiness blocks providers without a durable cloud worker adapter",()=>{
 const env={AUTH_MODE:"supabase",CLOUD_TIMELINE_API_ENABLED:"true",CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED:"true",SUPABASE_URL:"https://project.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"server-only"};
 for(const provider of ["fal","runway"]){
  const result=buildVideoDispatchReadiness({env,providerCatalog:{providers:[{id:"video",provider,model:"model-1",status:"ready",remote:true}]}});
  assert.equal(result.checks.videoProviderReady,true);
  assert.equal(result.checks.durableWorkerAdapterReady,provider==="runway");
  assert.equal(result.canSubmit,provider==="runway");
  if(provider==="fal")assert.equal(result.blockers.some(item=>item.check==="durableWorkerAdapterReady"),true);
 }
});
