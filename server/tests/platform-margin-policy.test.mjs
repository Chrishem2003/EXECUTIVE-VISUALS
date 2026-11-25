import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePlatformMarginFloor,evaluatePlatformMarginFloorForShots} from "../platform-margin-policy.mjs";

const now=Date.parse("2026-11-25T16:00:00.000Z");
const policy={enabled:true,minimumGrossMarginBps:3500,quoteMaxAgeSeconds:900,rateCardMaxAgeSeconds:86400,version:4};
const providerEstimate={available:true,estimated:true,currency:"USD",amount:3.4,
 pricing:{sourceUrl:"https://provider.example/pricing",observedAt:"2026-11-25T15:30:00.000Z",expiresAt:"2026-11-26T00:00:00.000Z"}};
const revenue={status:"verified_quote",currency:"USD",customerPriceMicros:6_000_000,
 evidenceReference:"subscription-allocation:job-01",evidenceSha256:"a".repeat(64)};
const additionalCostEvidence={status:"verified",currency:"USD",additionalCostMicros:200_000,
 evidenceReference:"variable-cost-model:job-01",evidenceSha256:"b".repeat(64),
 coveredCategories:["compute","storage","egress","payment_processing","moderation","retry_allowance","tax","refund_reserve","support"]};
const input={policy,providerEstimate,customerPriceEvidence:revenue,additionalCostEvidence,
 quoteObservedAt:"2026-11-25T15:55:00.000Z",now};

test("approves a quote above the configured platform gross-margin floor",()=>{
 const result=evaluatePlatformMarginFloor(input);
 assert.equal(result.readyForDispatch,true);
 assert.equal(result.grossProfitMicros,2_400_000);
 assert.equal(result.totalVariableCostMicros,3_600_000);
 assert.equal(result.grossMarginBps,4000);
 assert.equal(result.minimumGrossMarginBps,3500);
 assert.equal(result.policyVersion,4);
});

test("blocks quotes below the owner-configured margin floor",()=>{
 const result=evaluatePlatformMarginFloor({...input,customerPriceEvidence:{...revenue,customerPriceMicros:5_000_000}});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_GROSS_MARGIN_BELOW_FLOOR");
 assert.equal(result.grossMarginBps,2800);
});

test("blocks break-even and loss-making generation",()=>{
 for(const customerPriceMicros of [3_600_000,3_000_000]){
  const result=evaluatePlatformMarginFloor({...input,customerPriceEvidence:{...revenue,customerPriceMicros}});
  assert.equal(result.readyForDispatch,false);
  assert.equal(result.code,"PLATFORM_GROSS_MARGIN_BELOW_FLOOR");
 }
});

test("fails closed when policy is missing, disabled or malformed",()=>{
 assert.equal(evaluatePlatformMarginFloor({...input,policy:null}).code,"PLATFORM_MARGIN_POLICY_DISABLED");
 assert.equal(evaluatePlatformMarginFloor({...input,policy:{...policy,enabled:false}}).readyForDispatch,false);
 assert.equal(evaluatePlatformMarginFloor({...input,policy:{...policy,minimumGrossMarginBps:0}}).readyForDispatch,false);
});

test("does not convert customer credit units into monetary revenue",()=>{
 const result=evaluatePlatformMarginFloor({...input,customerPriceEvidence:{status:"estimated",currency:"USD",customerPriceMicros:6_000_000,evidenceReference:"credits:100",evidenceSha256:"a".repeat(64)}});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_CUSTOMER_PRICE_UNVERIFIED");
});

test("rejects mixed currency and malformed revenue evidence",()=>{
 assert.equal(evaluatePlatformMarginFloor({...input,customerPriceEvidence:{...revenue,currency:"UGX"}}).code,"PLATFORM_MARGIN_CUSTOMER_PRICE_UNVERIFIED");
 assert.equal(evaluatePlatformMarginFloor({...input,customerPriceEvidence:{...revenue,evidenceSha256:"bad"}}).readyForDispatch,false);
});

test("blocks stale quotes and stale or expired provider pricing",()=>{
 assert.equal(evaluatePlatformMarginFloor({...input,quoteObservedAt:"2026-11-25T15:40:00.000Z"}).code,"PLATFORM_MARGIN_QUOTE_STALE");
 assert.equal(evaluatePlatformMarginFloor({...input,providerEstimate:{...providerEstimate,pricing:{...providerEstimate.pricing,observedAt:"2026-11-20T00:00:00.000Z"}}}).code,"PLATFORM_MARGIN_RATE_CARD_STALE");
 assert.equal(evaluatePlatformMarginFloor({...input,providerEstimate:{...providerEstimate,pricing:{...providerEstimate.pricing,expiresAt:"2026-11-25T15:00:00.000Z"}}}).code,"PLATFORM_MARGIN_RATE_CARD_STALE");
});

test("rejects estimates that cannot be represented safely in currency micro-units",()=>{
 const result=evaluatePlatformMarginFloor({...input,providerEstimate:{...providerEstimate,amount:Number.MAX_VALUE}});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_PROVIDER_COST_INVALID");
});

test("production margin gate requires every shot to clear the floor independently",()=>{
 const shots=[
  {shotId:"shot-1",providerEstimate,customerPriceEvidence:revenue,additionalCostEvidence,quoteObservedAt:input.quoteObservedAt},
  {shotId:"shot-2",providerEstimate:{...providerEstimate,amount:2},customerPriceEvidence:{...revenue,customerPriceMicros:4_000_000,evidenceReference:"subscription-allocation:job-02"},additionalCostEvidence:{...additionalCostEvidence,additionalCostMicros:100_000,evidenceReference:"variable-cost-model:job-02"},quoteObservedAt:input.quoteObservedAt}
 ];
 const approved=evaluatePlatformMarginFloorForShots({policy,shots,now});
 assert.equal(approved.readyForDispatch,true);
 assert.equal(approved.shotCount,2);
 assert.equal(approved.providerCostMicros,5_400_000);
 assert.equal(approved.additionalVariableCostMicros,300_000);
 assert.equal(approved.totalVariableCostMicros,5_700_000);
 assert.equal(approved.customerPriceMicros,10_000_000);
 assert.equal(approved.grossMarginBps,4300);
 const blocked=evaluatePlatformMarginFloorForShots({policy,shots:[shots[0],{...shots[1],customerPriceEvidence:{...revenue,customerPriceMicros:2_200_000,evidenceReference:"subscription-allocation:job-02"}}],now});
 assert.equal(blocked.readyForDispatch,false);
 assert.equal(blocked.blockedShotId,"shot-2");
 assert.equal(blocked.code,"PLATFORM_GROSS_MARGIN_BELOW_FLOOR");
});

test("production margin gate rejects mixed currencies and invalid shot sets",()=>{
 assert.equal(evaluatePlatformMarginFloorForShots({policy,shots:[],now}).code,"PLATFORM_MARGIN_SHOT_SET_INVALID");
 const mixed=evaluatePlatformMarginFloorForShots({policy,shots:[
  {shotId:"one",providerEstimate,customerPriceEvidence:revenue,additionalCostEvidence,quoteObservedAt:input.quoteObservedAt},
  {shotId:"two",providerEstimate:{...providerEstimate,currency:"EUR"},customerPriceEvidence:{...revenue,currency:"EUR",customerPriceMicros:6_000_000},additionalCostEvidence:{...additionalCostEvidence,currency:"EUR"},quoteObservedAt:input.quoteObservedAt}
 ],now});
 assert.equal(mixed.readyForDispatch,false);
 assert.equal(mixed.code,"PLATFORM_MARGIN_CURRENCY_MISMATCH");
});

test("requires a verified fully-loaded variable-cost model covering all operating cost categories",()=>{
 assert.equal(evaluatePlatformMarginFloor({...input,additionalCostEvidence:null}).code,"PLATFORM_MARGIN_VARIABLE_COSTS_UNVERIFIED");
 assert.equal(evaluatePlatformMarginFloor({...input,additionalCostEvidence:{...additionalCostEvidence,coveredCategories:["compute"]}}).code,"PLATFORM_MARGIN_VARIABLE_COSTS_UNVERIFIED");
 assert.equal(evaluatePlatformMarginFloor({...input,additionalCostEvidence:{...additionalCostEvidence,status:"estimated"}}).readyForDispatch,false);
});

test("does not reuse one recognized-revenue allocation across multiple shots",()=>{
 const shot={shotId:"one",providerEstimate,customerPriceEvidence:revenue,additionalCostEvidence,quoteObservedAt:input.quoteObservedAt};
 const result=evaluatePlatformMarginFloorForShots({policy,shots:[shot,{...shot,shotId:"two"}],now});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_PRICE_EVIDENCE_REUSED");
});
