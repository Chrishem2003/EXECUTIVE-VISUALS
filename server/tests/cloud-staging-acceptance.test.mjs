import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCloudStagingAcceptance } from "../cloud-staging-acceptance.mjs";

const baseUrl="https://executive-visuals-cloud-staging.onrender.com";
const healthy={
 status:"ok",authMode:"supabase",authSession:{configurationReady:true},database:"postgres",storage:"object-storage",
 cloudMedia:{enabled:true,ready:true,storage:"private",provider:"supabase"},
 cloudMediaJobsApi:{enabled:true},
 cloudVideoWorker:{enabled:true,outputHostAllowlistConfigured:true,supabaseCredentialsConfigured:true,remoteExecutionGates:false}
};
const ready={ready:true,status:"ready",checks:[]};

test("accepts only a ready isolated staging runtime with paid execution still disabled",()=>{
 const result=evaluateCloudStagingAcceptance({baseUrl,health:healthy,readiness:ready});
 assert.equal(result.passed,true);
 assert.equal(result.status,"ready");
 assert.ok(result.checks.every(item=>item.status==="passed"));
});

test("refuses production, arbitrary hosts, HTTP and URL credentials",()=>{
 for(const value of [
  "https://executive-visuals.onrender.com",
  "https://example.com",
  "http://executive-visuals-cloud-staging.onrender.com",
  "https://user:secret@executive-visuals-cloud-staging.onrender.com",
  "https://executive-visuals-cloud-staging.onrender.com/?token=secret",
  "https://executive-visuals-cloud-staging.onrender.com:8443"
 ]){
  const result=evaluateCloudStagingAcceptance({baseUrl:value,health:healthy,readiness:ready});
  assert.equal(result.passed,false,value);
  assert.equal(result.checks.find(item=>item.id==="staging-target").status,"blocked");
 }
});

test("accepts SQLite/local media only when an operator-confirmed persistent volume is configured",()=>{
 const durable={...healthy,database:"sqlite",storage:"local-disk",persistence:{persistentVolumeRequired:true,dataDirectory:"operator-confirmed-volume"}};
 assert.equal(evaluateCloudStagingAcceptance({baseUrl,health:durable,readiness:ready}).checks.find(item=>item.id==="durable-application-state").status,"passed");
 const ephemeral={...durable,persistence:{persistentVolumeRequired:false,dataDirectory:"ephemeral"}};
 const result=evaluateCloudStagingAcceptance({baseUrl,health:ephemeral,readiness:ready});
 assert.equal(result.passed,false);
 assert.equal(result.checks.find(item=>item.id==="durable-application-state").status,"blocked");
});

test("fails closed when database and storage durability are not explicitly reported",()=>{
 const result=evaluateCloudStagingAcceptance({baseUrl,health:{...healthy,database:undefined,storage:undefined},readiness:ready});
 assert.equal(result.passed,false);
 assert.equal(result.checks.find(item=>item.id==="durable-application-state").status,"blocked");
});

test("blocks when private storage or server-managed auth is not ready",()=>{
 const result=evaluateCloudStagingAcceptance({
  baseUrl,health:{...healthy,authSession:{configurationReady:false},cloudMedia:{...healthy.cloudMedia,storage:"unverified",ready:false}},readiness:ready
 });
 assert.equal(result.passed,false);
 assert.equal(result.checks.find(item=>item.id==="supabase-auth").status,"blocked");
 assert.equal(result.checks.find(item=>item.id==="private-cloud-media").status,"blocked");
});

test("blocks when cloud worker configuration is incomplete",()=>{
 const result=evaluateCloudStagingAcceptance({
  baseUrl,health:{...healthy,cloudVideoWorker:{...healthy.cloudVideoWorker,enabled:false,outputHostAllowlistConfigured:false}},readiness:ready
 });
 assert.equal(result.passed,false);
 assert.equal(result.checks.find(item=>item.id==="cloud-worker-configured").status,"blocked");
});

test("requires an explicit false remote-execution gate during no-cost staging acceptance",()=>{
 const result=evaluateCloudStagingAcceptance({
  baseUrl,health:{...healthy,cloudVideoWorker:{...healthy.cloudVideoWorker,remoteExecutionGates:true}},readiness:ready
 });
 assert.equal(result.passed,false);
 assert.equal(result.checks.find(item=>item.id==="paid-provider-execution-disabled").status,"blocked");
 const missing=evaluateCloudStagingAcceptance({baseUrl,health:{...healthy,cloudVideoWorker:{...healthy.cloudVideoWorker,remoteExecutionGates:undefined}},readiness:ready});
 assert.equal(missing.passed,false);
 assert.equal(missing.checks.find(item=>item.id==="paid-provider-execution-disabled").status,"blocked");
});

test("requires the deployment readiness endpoint to pass",()=>{
 const result=evaluateCloudStagingAcceptance({baseUrl,health:healthy,readiness:{ready:false,status:"not_ready",checks:[{id:"persistent-volume",status:"blocked"}]}});
 assert.equal(result.passed,false);
 assert.equal(result.checks.find(item=>item.id==="application-readiness").status,"blocked");
});

test("does not echo secrets from health payloads into its result",()=>{
 const result=evaluateCloudStagingAcceptance({
  baseUrl,health:{...healthy,cloudVideoWorker:{...healthy.cloudVideoWorker,serviceRoleKey:"super-secret-value"}},readiness:ready
 });
 assert.equal(JSON.stringify(result).includes("super-secret-value"),false);
});
