import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkloadTelemetry } from "../ai-workload-telemetry.mjs";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const project="22222222-2222-4222-8222-222222222222";
const job="33333333-3333-4333-8333-333333333333";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl,options={}){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 billingEnabled:true,resourceCostMeteringEnabled:true,financialSystemActorId:owner,fetchImpl,...options
});}
const event={occurredAt:"2026-11-10T10:00:00Z",provider:"openai",model:"video-model",operation:"video",
 source:"provider_response",operationId:"request-123",ownerId:owner,projectId:project,jobId:job,
 resolutionTier:"1080p",currency:"USD",providerCostMinor:125,
 dimensions:{inputAudioTokens:20,outputAudioTokens:40,cachedInputTokens:10,reasoningTokens:5,
  inputImageCount:2,outputImageCount:1,referenceImageCount:1,referenceVideoSeconds:3.5,
  generatedVideoSeconds:5,renderSeconds:2,upscaleImageCount:0,framesProcessed:150,
  acceptedOutputs:1,rejectedOutputs:1,retryCount:1,attemptCount:2,latencyMs:4200,
  cpuSeconds:3,gpuSeconds:1,storageGbSeconds:0.5,egressBytes:2048},
 idempotencyKey:"telemetry-key-0001"
};
test("normalizes multimodal workload dimensions without retaining prompt or media content",()=>{
 const normalized=normalizeWorkloadTelemetry(event);
 assert.equal(normalized.provider,"openai");
 assert.equal(normalized.dimensions.inputAudioTokens,20);
 assert.equal(normalized.dimensions.referenceVideoSeconds,3.5);
 assert.equal(normalized.dimensions.acceptedOutputs,1);
 assert.equal(normalized.resolutionTier,"1080p");
 assert.equal(Object.hasOwn(normalized,"prompt"),false);
 assert.equal(Object.hasOwn(normalized,"media"),false);
});
test("rejects negative, unknown, nonnumeric dimensions and malformed attribution",()=>{
 assert.throws(()=>normalizeWorkloadTelemetry({...event,dimensions:{gpuSeconds:-1}}),{code:"WORKLOAD_TELEMETRY_VALUE_INVALID"});
 assert.throws(()=>normalizeWorkloadTelemetry({...event,dimensions:{prompt:"secret"}}),{code:"WORKLOAD_TELEMETRY_DIMENSIONS_INVALID"});
 assert.throws(()=>normalizeWorkloadTelemetry({...event,dimensions:{framesProcessed:"many"}}),{code:"WORKLOAD_TELEMETRY_VALUE_INVALID"});
 assert.throws(()=>normalizeWorkloadTelemetry({...event,ownerId:"not-a-uuid"}),{code:"WORKLOAD_TELEMETRY_ATTRIBUTION_INVALID"});
 assert.throws(()=>normalizeWorkloadTelemetry({...event,source:"unknown"}),{code:"WORKLOAD_TELEMETRY_SOURCE_INVALID"});
});
test("admin workload telemetry API requires finance admin and persists normalized evidence",async()=>{
 let rpc;
 const denied=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("Unauthorized telemetry write reached persistence.");
 });
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/workload-telemetry",ownerId:owner,body:event});
 assert.equal(blocked.status,403);
 const allowed=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/record_ai_workload_telemetry_event")){rpc=JSON.parse(options.body);return json({id:"telemetry-id",idempotentReplay:false});}
  throw new Error("Unexpected request: "+target);
 });
 const result=await allowed.handle({method:"POST",path:"/api/admin/finance/workload-telemetry",ownerId:owner,body:event});
 assert.equal(result.status,201);
 assert.equal(rpc.p_actor_id,owner);
 assert.equal(rpc.p_dimensions.referenceVideoSeconds,3.5);
 assert.equal(rpc.p_provider_cost_minor,125);
});
test("worker instrumentation emits idempotent job-attributed measurements",async()=>{
 let rpc;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/rpc/record_ai_workload_telemetry_event")){rpc=JSON.parse(options.body);return json({id:"worker-event",idempotentReplay:false});}
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.recordWorkerWorkloadTelemetry({job:{id:job,owner_id:owner,project_id:project,job_type:"timeline.render",attempt_count:2},measurement:{
  measuredAt:"2026-11-10T10:00:00Z",measurementId:"measure-1",resourceType:"ffmpeg_second",quantity:3.5,unit:"second",
  dimensions:{renderSeconds:3.5,attemptCount:2,retryCount:1}
 }});
 assert.equal(result.recorded,true);
 assert.equal(rpc.p_actor_id,owner);
 assert.equal(rpc.p_owner_id,owner);
 assert.equal(rpc.p_job_id,job);
 assert.equal(rpc.p_evidence_source,"worker_measurement");
 assert.equal(rpc.p_resource_quantity,3.5);
 assert.equal(rpc.p_dimensions.renderSeconds,3.5);
});
test("admin workload telemetry overview validates month and limit filters",async()=>{
 let called=false;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.endsWith("/rpc/ai_workload_telemetry_overview")){called=true;return json({periodMonth:"2026-11-01",totals:{eventCount:4},byProviderModelOperation:[]});}
  throw new Error("Unexpected request: "+target);
 });
 const invalid=await service.handle({method:"GET",path:"/api/admin/finance/workload-telemetry",ownerId:owner,query:{periodMonth:"2026-11-02",limit:"900"}});
 assert.equal(invalid.status,400);
 const valid=await service.handle({method:"GET",path:"/api/admin/finance/workload-telemetry",ownerId:owner,query:{periodMonth:"2026-11-01",limit:"25"}});
 assert.equal(valid.status,200);
 assert.equal(called,true);
});
