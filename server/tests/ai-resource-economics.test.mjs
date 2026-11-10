import test from "node:test";
import assert from "node:assert/strict";
import {
 normalizeResourceUsage,normalizeModelPerformance,normalizeShadowRoutingRequest,
 rankShadowModelCandidates
} from "../ai-resource-economics.mjs";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const jobId="22222222-2222-4222-8222-222222222222";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl,options={}){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 billingEnabled:true,fetchImpl,...options
});}

test("resource normalization requires measured quantities and exact resource units",()=>{
 const event=normalizeResourceUsage({
  provider:"executive-visuals-worker",model:"timeline.render",operationId:jobId,
  resourceType:"ffmpeg_second",quantity:12.75,unit:"second",currency:"USD",
  ownerId:owner,jobId,idempotencyKey:"worker-resource-0001"
 });
 assert.equal(event.quantity,12.75);
 assert.equal(event.resourceType,"ffmpeg_second");
 assert.equal(event.currency,"USD");
 assert.throws(()=>normalizeResourceUsage({
  provider:"worker",model:"render",operationId:jobId,resourceType:"ffmpeg_second",
  quantity:1,unit:"gb",idempotencyKey:"worker-resource-0002"
 }),{code:"RESOURCE_UNIT_INVALID"});
 assert.throws(()=>normalizeResourceUsage({
  provider:"worker",model:"render",operationId:jobId,resourceType:"gpu_second",
  quantity:-1,unit:"second",idempotencyKey:"worker-resource-0003"
 }),{code:"RESOURCE_VALUE_INVALID"});
});

test("model performance normalization enforces bounded latency, score and provenance",()=>{
 const event=normalizeModelPerformance({
  provider:"openai",model:"model-v2",operation:"text",usageEventId:jobId,
  latencyMs:820,qualityScore:0.93,qualitySource:"approved_evaluator",
  evaluationVersion:"judge-v4",idempotencyKey:"model-performance-001"
 });
 assert.equal(event.qualityScore,0.93);
 assert.equal(event.qualitySource,"approved_evaluator");
 assert.throws(()=>normalizeModelPerformance({
  provider:"openai",model:"model-v2",operation:"text",usageEventId:jobId,
  latencyMs:0,qualityScore:1.2,qualitySource:"unverified",evaluationVersion:"v1",
  idempotencyKey:"model-performance-002"
 }),{code:"RESOURCE_VALUE_INVALID"});
});

test("shadow candidate ranking excludes weak evidence and applies cost, latency and quality constraints",()=>{
 const ranked=rankShadowModelCandidates([
  {provider:"p1",model:"too-few",samples:19,avgCostMinor:1,p95LatencyMs:1,avgQualityScore:1},
  {provider:"p2",model:"too-slow",samples:30,avgCostMinor:50,p95LatencyMs:900,avgQualityScore:0.95},
  {provider:"p3",model:"best",samples:30,avgCostMinor:70,p95LatencyMs:300,avgQualityScore:0.96}
 ],{maxCostMinor:100,maxLatencyMs:500,minQualityScore:0.9});
 assert.equal(ranked[0].model,"best");
 assert.equal(ranked[0].eligible,true);
 assert.equal(ranked.find(x=>x.model==="too-few").eligible,false);
 assert.equal(ranked.find(x=>x.model==="too-slow").eligible,false);
});

test("shadow routing API records recommendation but explicitly never changes execution",async()=>{
 let rpcPayload;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/recommend_ai_model_route_shadow")){
   rpcPayload=JSON.parse(options.body);
   return json({decisionId:jobId,decisionStatus:"recommended",recommendedProvider:"p3",
    recommendedModel:"best",decisionMode:"shadow_only",executionChanged:false,candidates:[]});
  }
  throw new Error("Unexpected request "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/model-routing/shadow",ownerId:owner,body:{
  operation:"text",currency:"USD",maxCostMinor:100,maxLatencyMs:500,minQualityScore:0.9,
  idempotencyKey:"shadow-route-0001"
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.recommendation.executionChanged,false);
 assert.equal(result.body.recommendation.decisionMode,"shadow_only");
 assert.equal(rpcPayload.p_actor_id,owner);
 assert.equal(rpcPayload.p_max_latency_ms,500);
});

test("worker FFmpeg measurements persist only when the server-side system actor is configured",async()=>{
 let rpcPayload;
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/rpc/record_ai_resource_usage_event")){
   rpcPayload=JSON.parse(options.body);
   return json({id:jobId,costBasis:"unpriced",costMinor:null,currency:null,idempotentReplay:false});
  }
  throw new Error("Unexpected request "+target);
 },{financialSystemActorId:owner,resourceCostMeteringEnabled:true,resourceCostCurrency:null});
 const result=await service.recordWorkerResourceUsage({
  job:{id:jobId,owner_id:owner,project_id:null,job_type:"timeline.render",attempt_count:2},
  measurement:{measurementId:"measurement-001",resourceType:"ffmpeg_second",quantity:4.25,unit:"second",measuredAt:"2026-11-10T10:00:00.000Z"}
 });
 assert.equal(result.recorded,true);
 assert.equal(rpcPayload.p_actor_id,owner);
 assert.equal(rpcPayload.p_resource_type,"ffmpeg_second");
 assert.equal(rpcPayload.p_quantity,4.25);
 assert.equal(rpcPayload.p_evidence.measurement,"ffmpeg_process_wall_clock");
});
