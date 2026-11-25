import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePlatformMarginFloor} from "../platform-margin-policy.mjs";

const now=Date.parse("2026-11-25T16:00:00.000Z");
const policy={enabled:true,minimumGrossMarginBps:3500,quoteMaxAgeSeconds:900,rateCardMaxAgeSeconds:86400,version:4};
const providerEstimate={available:true,estimated:true,currency:"USD",amount:3.4,
 pricing:{sourceUrl:"https://provider.example/pricing",observedAt:"2026-11-25T15:30:00.000Z",expiresAt:"2026-11-26T00:00:00.000Z"}};
const revenue={status:"verified",currency:"USD",recognizedRevenueMicros:6_000_000,
 evidenceReference:"subscription-allocation:job-01",evidenceSha256:"a".repeat(64)};
const input={policy,providerEstimate,customerRevenueEvidence:revenue,quoteObservedAt:"2026-11-25T15:55:00.000Z",now};

test("approves a quote above the configured platform gross-margin floor",()=>{
 const result=evaluatePlatformMarginFloor(input);
 assert.equal(result.readyForDispatch,true);
 assert.equal(result.grossProfitMicros,2_600_000);
 assert.equal(result.grossMarginBps,4333);
 assert.equal(result.minimumGrossMarginBps,3500);
 assert.equal(result.policyVersion,4);
});

test("blocks quotes below the owner-configured margin floor",()=>{
 const result=evaluatePlatformMarginFloor({...input,customerRevenueEvidence:{...revenue,recognizedRevenueMicros:5_000_000}});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_GROSS_MARGIN_BELOW_FLOOR");
 assert.equal(result.grossMarginBps,3200);
});

test("blocks break-even and loss-making generation",()=>{
 for(const recognizedRevenueMicros of [3_400_000,3_000_000]){
  const result=evaluatePlatformMarginFloor({...input,customerRevenueEvidence:{...revenue,recognizedRevenueMicros}});
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
 const result=evaluatePlatformMarginFloor({...input,customerRevenueEvidence:{status:"estimated",currency:"USD",recognizedRevenueMicros:6_000_000,evidenceReference:"credits:100",evidenceSha256:"a".repeat(64)}});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_REVENUE_UNVERIFIED");
});

test("rejects mixed currency and malformed revenue evidence",()=>{
 assert.equal(evaluatePlatformMarginFloor({...input,customerRevenueEvidence:{...revenue,currency:"UGX"}}).code,"PLATFORM_MARGIN_REVENUE_UNVERIFIED");
 assert.equal(evaluatePlatformMarginFloor({...input,customerRevenueEvidence:{...revenue,evidenceSha256:"bad"}}).readyForDispatch,false);
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
