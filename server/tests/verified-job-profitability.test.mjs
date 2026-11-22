import test from "node:test";
import assert from "node:assert/strict";
import { calculateVerifiedJobProfitability } from "../verified-job-profitability.mjs";
const hash="a".repeat(64);
const base={
 jobId:"job-001",currency:"USD",
 forecast:{estimateType:"forecast_not_actual",currency:"USD",baseCostMinor:400,rateCardVersion:"2026-11-v1"},
 acceptedOutputs:2,rejectedOutputs:1,creditsDebited:120,
 revenue:{status:"verified",currency:"USD",recognizedRevenueMinor:1000,evidenceReference:"allocation:job-001",evidenceSha256:hash},
 actualCostLines:[
  {sourceId:"invoice-line-1",sourceType:"provider_invoice",currency:"USD",amountMinor:350,evidenceReference:"invoice:INV-1/line-1",evidenceSha256:hash},
  {sourceId:"meter-1",sourceType:"usage_meter",currency:"USD",amountMinor:50,evidenceReference:"usage:job-001",evidenceSha256:hash}
 ]
};
test("calculates verified contribution, actual unit cost and forecast variance",()=>{
 const result=calculateVerifiedJobProfitability(base);
 assert.equal(result.actual.costMinor,400);
 assert.equal(result.actual.costPerAcceptedOutputMinor,200);
 assert.equal(result.profitability.contributionMinor,600);
 assert.equal(result.profitability.grossMarginPct,60);
 assert.equal(result.variance.direction,"on_forecast");
 assert.equal(result.customerUsage.acceptanceRatePct,66.67);
});
test("does not treat credit units as monetary revenue",()=>{
 const invalid={...base,revenue:{...base.revenue,status:"estimated"}};
 assert.throws(()=>calculateVerifiedJobProfitability(invalid),{code:"JOB_PROFITABILITY_REVENUE_UNVERIFIED"});
});
test("rejects mixed currencies and duplicate evidence sources",()=>{
 assert.throws(()=>calculateVerifiedJobProfitability({...base,actualCostLines:[...base.actualCostLines,{...base.actualCostLines[0],sourceId:"third",currency:"UGX"}]}),{code:"JOB_PROFITABILITY_CURRENCY_MISMATCH"});
 assert.throws(()=>calculateVerifiedJobProfitability({...base,actualCostLines:[base.actualCostLines[0],{...base.actualCostLines[1],sourceId:"invoice-line-1"}]}),{code:"JOB_PROFITABILITY_DUPLICATE_SOURCE"});
});
test("rejects unverified or malformed evidence",()=>{
 assert.throws(()=>calculateVerifiedJobProfitability({...base,actualCostLines:[{...base.actualCostLines[0],evidenceSha256:"bad"}]}),{code:"JOB_PROFITABILITY_EVIDENCE_INVALID"});
});
test("rejects an empty actual cost set",()=>{
 assert.throws(()=>calculateVerifiedJobProfitability({...base,actualCostLines:[]}),{code:"JOB_PROFITABILITY_ACTUALS_REQUIRED"});
});
