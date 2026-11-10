import test from "node:test";
import assert from "node:assert/strict";
import {analyzeWorkloadCostVariance} from "../workload-cost-variance.mjs";
const digest="a".repeat(64);
const estimate={estimateType:"forecast_not_actual",estimateVersion:"1.0",rateCardVersion:"r1",provider:"provider-a",model:"video-model",operation:"video",currency:"UGX",costRange:{lowMinor:900,baseMinor:1000,highMinor:1100}};
const actuals=(amountMinor=1050)=>[{sourceId:"invoice-1",sourceType:"provider_invoice",amountMinor,currency:"UGX",evidenceReference:"private://invoice/1",evidenceSha256:digest,observedAt:"2026-11-10T10:00:00Z"}];
test("reconciles verified actuals against forecast and computes accepted-output economics",()=>{
 const result=analyzeWorkloadCostVariance({estimate,actuals:actuals(1050),acceptedOutputs:3,rejectedOutputs:1});
 assert.equal(result.analysisType,"verified_actual_vs_forecast");
 assert.equal(result.variance.amountMinor,50);
 assert.equal(result.variance.basisPoints,500);
 assert.equal(result.variance.classification,"within_forecast_range");
 assert.equal(result.outputs.actualUnitCostMinor,350);
 assert.equal(result.outputs.acceptanceRateBps,7500);
});
test("classifies favourable and adverse variances outside the forecast interval",()=>{
 const favourable=analyzeWorkloadCostVariance({estimate,actuals:actuals(800),acceptedOutputs:2});
 const adverse=analyzeWorkloadCostVariance({estimate,actuals:actuals(1250),acceptedOutputs:2});
 assert.equal(favourable.variance.classification,"below_forecast_range");
 assert.equal(favourable.variance.direction,"favourable");
 assert.equal(adverse.variance.classification,"above_forecast_range");
 assert.equal(adverse.variance.direction,"unfavourable");
});
test("rejects unverified, duplicated, mismatched-currency or evidence-deficient actuals",()=>{
 assert.throws(()=>analyzeWorkloadCostVariance({estimate:{...estimate,estimateType:"actual"},actuals:actuals(),acceptedOutputs:1}),{code:"WORKLOAD_VARIANCE_ESTIMATE_INVALID"});
 assert.throws(()=>analyzeWorkloadCostVariance({estimate,actuals:[...actuals(),...actuals()],acceptedOutputs:1}),{code:"WORKLOAD_VARIANCE_DUPLICATE_SOURCE"});
 assert.throws(()=>analyzeWorkloadCostVariance({estimate,actuals:[{...actuals()[0],currency:"USD"}],acceptedOutputs:1}),{code:"WORKLOAD_VARIANCE_CURRENCY_MISMATCH"});
 assert.throws(()=>analyzeWorkloadCostVariance({estimate,actuals:[{...actuals()[0],evidenceSha256:"bad"}],acceptedOutputs:1}),{code:"WORKLOAD_VARIANCE_EVIDENCE_INVALID"});
});
test("rejects zero accepted outputs and unordered forecast ranges",()=>{
 assert.throws(()=>analyzeWorkloadCostVariance({estimate,actuals:actuals(),acceptedOutputs:0}),{code:"WORKLOAD_VARIANCE_INPUT_INVALID"});
 assert.throws(()=>analyzeWorkloadCostVariance({estimate:{...estimate,costRange:{lowMinor:1200,baseMinor:1000,highMinor:1300}},actuals:actuals(),acceptedOutputs:1}),{code:"WORKLOAD_VARIANCE_RANGE_INVALID"});
});
