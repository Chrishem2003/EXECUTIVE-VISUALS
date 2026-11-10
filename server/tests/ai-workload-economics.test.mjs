import test from "node:test";
import assert from "node:assert/strict";
import {estimateWorkloadEconomics,compareWorkloadCandidates} from "../ai-workload-economics.mjs";
const rateCard=(provider,model,inputRate,outputRate)=>({
 provider,model,currency:"UGX",version:"2026-11-v1",
 inputMinorPerMillionTokens:inputRate,outputMinorPerMillionTokens:outputRate,
 imageMinorPerImage:1200,videoMinorPerSecond:400,renderMinorPerSecond:90,
 gpuMinorPerSecond:150,cpuMinorPerSecond:25,storageMinorPerGbDay:4,egressMinorPerGb:18
});
test("estimates token and resource costs with explicit versioned rates and price floor",()=>{
 const result=estimateWorkloadEconomics({
  rateCard:rateCard("provider-a","model-a",1000000,2000000),
  workload:{operation:"video",currency:"UGX",inputTokens:1000,outputTokens:500,videoSeconds:12,renderSeconds:20,successfulOutputs:2},
  uncertaintyBps:1000,pricing:{targetMarginBps:6000,paymentFeeBps:300,fixedPaymentFeeMinor:50,supportReserveBps:500}
 });
 assert.equal(result.estimateType,"forecast_not_actual");
 assert.equal(result.costRange.baseMinor,1000+1000+4800+1800);
 assert.equal(result.unitCostMinor,3800);
 assert.ok(result.costRange.lowMinor<result.costRange.baseMinor);
 assert.ok(result.costRange.highMinor>result.costRange.baseMinor);
 assert.ok(result.pricing.highCostMinimumPriceMinor>result.pricing.minimumPriceMinor);
 assert.equal(result.rateCardVersion,"2026-11-v1");
 assert.match(result.limitations[0],/Forecast only/);
});
test("requires every used workload driver to have a priced rate",()=>{
 assert.throws(()=>estimateWorkloadEconomics({
  rateCard:{provider:"provider-a",model:"model-a",currency:"UGX",version:"v1",inputMinorPerMillionTokens:10},
  workload:{operation:"image",imageCount:2}
 }),{code:"WORKLOAD_RATE_MISSING"});
});
test("rejects invalid currency, unsafe quantity and impossible margin assumptions",()=>{
 const card=rateCard("provider-a","model-a",10,20);
 assert.throws(()=>estimateWorkloadEconomics({rateCard:card,workload:{operation:"image",currency:"USD",imageCount:1}}),{code:"WORKLOAD_CURRENCY_MISMATCH"});
 assert.throws(()=>estimateWorkloadEconomics({rateCard:card,workload:{operation:"image",imageCount:1e20}}),{code:"WORKLOAD_ECONOMICS_VALUE_INVALID"});
 assert.throws(()=>estimateWorkloadEconomics({rateCard:card,workload:{operation:"image",imageCount:1},pricing:{targetMarginBps:9000,paymentFeeBps:2000}}),{code:"WORKLOAD_PRICING_ASSUMPTIONS_INVALID"});
});
test("shadow candidate selection requires evaluation evidence and all guardrails",()=>{
 const workload={operation:"image",currency:"UGX",imageCount:2};
 const candidates=compareWorkloadCandidates({
  workload,rateCards:[
   {rateCard:rateCard("provider-a","cheap-unproven",1,1),samples:4,qualityScore:.99,p95LatencyMs:100,evaluationVersion:"eval-1"},
   {rateCard:rateCard("provider-b","qualified",100,100),samples:50,qualityScore:.96,p95LatencyMs:400,evaluationVersion:"eval-2"},
   {rateCard:rateCard("provider-c","fast-low-quality",10,10),samples:100,qualityScore:.70,p95LatencyMs:80,evaluationVersion:"eval-3"}
  ],
  limits:{maxCostMinor:10000,maxLatencyMs:1000,minQualityScore:.9}
 });
 assert.equal(candidates.mode,"shadow_only");
 assert.equal(candidates.automaticRouting,false);
 assert.equal(candidates.recommended.provider,"provider-b");
 assert.equal(candidates.candidates[1].evidenceReady,false);
});
test("no route is recommended when all candidates fail measured quality or cost gates",()=>{
 const result=compareWorkloadCandidates({
  workload:{operation:"image",imageCount:1},
  rateCards:[
   {rateCard:rateCard("provider-a","a",1,1),samples:25,qualityScore:.8,p95LatencyMs:100,evaluationVersion:"eval"},
   {rateCard:rateCard("provider-b","b",1,1),samples:25,qualityScore:.95,p95LatencyMs:100,evaluationVersion:"eval"}
  ],
  limits:{maxCostMinor:100,maxLatencyMs:1000,minQualityScore:.9},uncertaintyBps:0
 });
 assert.equal(result.recommended,null);
});
