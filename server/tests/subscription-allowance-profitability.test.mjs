import test from "node:test";
import assert from "node:assert/strict";
import {simulateSubscriptionAllowances,PROPOSED_SUBSCRIPTION_PLANS} from "../subscription-allowance-profitability.mjs";

const base={
 targetGrossMarginBps:7000,paymentFeeBps:350,fixedPaymentFeeMinor:30,
 refundReserveBps:200,supportReserveMinor:20,infrastructureReserveMinor:30
};
const evidence={
 status:"verified_measured",approved:false,source:"reconciled provider usage ledger",
 rateCardVersion:"runway-2026-11-v1",sampleJobs:100,
 periodStart:"2026-10-01T00:00:00.000Z",periodEnd:"2026-11-01T00:00:00.000Z"
};

test("uses the four fixed-price tiers but leaves allowances unset without approved measured cost evidence",()=>{
 const result=simulateSubscriptionAllowances(base);
 assert.deepEqual(PROPOSED_SUBSCRIPTION_PLANS.map(p=>p.monthlyPriceMinor),[900,2900,7900,19900]);
 assert.equal(result.estimateType,"scenario_forecast_not_actual");
 assert.equal(result.creditAllowanceCalculated,false);
 assert.deepEqual(result.plans.map(p=>p.estimatedIncludedCredits),[null,null,null,null]);
 assert.ok(result.plans.every(p=>p.publishable===false&&p.allowanceStatus==="awaiting_approved_cost_evidence"));
});

test("calculates conservative credit scenarios from verified evidence while keeping plans unpublished",()=>{
 const result=simulateSubscriptionAllowances({...base,providerCostPerCustomerCreditMinor:2,costEvidence:evidence});
 assert.equal(result.creditAllowanceCalculated,true);
 assert.deepEqual(result.plans.map(p=>p.estimatedIncludedCredits),[98,381,1090,2791]);
 assert.deepEqual(result.plans.map(p=>p.providerCostBudgetMinor),[196,763,2180,5582]);
 assert.ok(result.plans.every(p=>p.publishable===false));
 assert.equal(result.costEvidence.status,"verified_measured");
 assert.equal(result.costEvidence.approved,false);
 assert.equal(result.costEvidence.rateCardVersion,"runway-2026-11-v1");
});

test("rejects approval-marked, incomplete or time-inverted cost evidence",()=>{
 for(const costEvidence of [
  {...evidence,approved:true},
  {...evidence,status:"forecast"},
  {...evidence,source:""},
  {...evidence,rateCardVersion:""},
  {...evidence,sampleJobs:0},
  {...evidence,periodEnd:evidence.periodStart}
 ]){
  assert.throws(()=>simulateSubscriptionAllowances({...base,providerCostPerCustomerCreditMinor:2,costEvidence}),
   {code:"SUBSCRIPTION_ECONOMICS_EVIDENCE_INVALID"});
 }
});

test("rejects missing or impossible financial assumptions and malformed plan definitions",()=>{
 assert.throws(()=>simulateSubscriptionAllowances({paymentFeeBps:350}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 assert.throws(()=>simulateSubscriptionAllowances({...base,targetGrossMarginBps:10000}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 assert.throws(()=>simulateSubscriptionAllowances({...base,paymentFeeBps:9000,refundReserveBps:2000}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 assert.throws(()=>simulateSubscriptionAllowances({...base,plans:[{...PROPOSED_SUBSCRIPTION_PLANS[0],currency:"UGX"}]}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 assert.throws(()=>simulateSubscriptionAllowances({...base,plans:[PROPOSED_SUBSCRIPTION_PLANS[0],PROPOSED_SUBSCRIPTION_PLANS[0]]}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 assert.throws(()=>simulateSubscriptionAllowances({...base,providerCostPerCustomerCreditMinor:0,costEvidence:evidence}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
});

test("ceil-rounds payment and refund reserves and never returns a negative provider budget",()=>{
 const result=simulateSubscriptionAllowances({
  plans:[{planCode:"starter_creator",name:"Starter",monthlyPriceMinor:900,currency:"USD"}],
  targetGrossMarginBps:9000,paymentFeeBps:1000,fixedPaymentFeeMinor:100,
  refundReserveBps:1000,supportReserveMinor:1000,infrastructureReserveMinor:1000
 });
 const [plan]=result.plans;
 assert.equal(plan.paymentFeeMinor,190);
 assert.equal(plan.refundReserveMinor,90);
 assert.equal(plan.providerCostBudgetMinor,0);
 assert.equal(plan.estimatedIncludedCredits,null);
});
