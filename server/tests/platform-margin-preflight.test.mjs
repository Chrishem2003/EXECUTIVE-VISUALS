import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePlatformMarginPreflight } from "../platform-margin-preflight.mjs";

const policy={enabled:true,minimumGrossMarginBps:3500,quoteMaxAgeSeconds:900,rateCardMaxAgeSeconds:86400,version:2};
const pricing={sourceUrl:"https://provider.example/pricing",observedAt:"2026-11-25T16:00:00.000Z",expiresAt:"2026-11-26T16:00:00.000Z"};
const pricedShots=[{shotId:"shot-1",provider:"runway",model:"seedance-2.5",currency:"USD",amount:3.4,pricing}];
const customerPriceEvidencePerShot=[{shotId:"shot-1",status:"verified_quote",currency:"USD",customerPriceMicros:6_000_000,
 evidenceReference:"customer-price-quote:shot-1",policyFingerprint:"c".repeat(64),evidenceSha256:"a".repeat(64)}];
const quoteObservedAt="2026-11-25T16:05:00.000Z";
const additional={status:"verified",currency:"USD",additionalCostMicros:200_000,evidenceReference:"variable-cost-model:shot-1",
 evidenceSha256:"b".repeat(64),coveredCategories:["compute","storage","egress","payment_processing","moderation","retry_allowance","tax","refund_reserve","support"]};

test("does not mistake missing owner policy for an approved margin result",()=>{
 const result=evaluatePlatformMarginPreflight({pricedShots,customerPriceEvidencePerShot,quoteObservedAt,now:Date.parse("2026-11-25T16:06:00Z")});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_POLICY_DISABLED");
});

test("loads enabled policy but keeps dispatch blocked while fully-loaded costs are absent",()=>{
 const result=evaluatePlatformMarginPreflight({policy,pricedShots,customerPriceEvidencePerShot,quoteObservedAt,now:Date.parse("2026-11-25T16:06:00Z")});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_VARIABLE_COSTS_UNVERIFIED");
 assert.equal(result.blockedShotId,"shot-1");
});

test("approves only when every shot has verified same-currency cost evidence",()=>{
 const result=evaluatePlatformMarginPreflight({policy,pricedShots,customerPriceEvidencePerShot,quoteObservedAt,
  additionalCostEvidenceByShot:[additional],now:Date.parse("2026-11-25T16:06:00Z")});
 assert.equal(result.readyForDispatch,true);
 assert.equal(result.shotCount,1);
 assert.equal(result.grossMarginBps,4000);
});

test("rejects missing, reordered or mismatched customer-price shot evidence",()=>{
 const result=evaluatePlatformMarginPreflight({policy,pricedShots,
  customerPriceEvidencePerShot:[{...customerPriceEvidencePerShot[0],shotId:"another-shot"}],
  quoteObservedAt,additionalCostEvidenceByShot:[additional],now:Date.parse("2026-11-25T16:06:00Z")});
 assert.equal(result.readyForDispatch,false);
 assert.equal(result.code,"PLATFORM_MARGIN_SHOT_IDENTITY_MISMATCH");
});

test("does not accept stale quote timestamps or incomplete cost categories",()=>{
 const stale=evaluatePlatformMarginPreflight({policy,pricedShots,customerPriceEvidencePerShot,
  quoteObservedAt:"2026-11-25T15:40:00.000Z",additionalCostEvidenceByShot:[additional],now:Date.parse("2026-11-25T16:06:00Z")});
 assert.equal(stale.readyForDispatch,false);
 assert.equal(stale.code,"PLATFORM_MARGIN_QUOTE_STALE");
 const incomplete=evaluatePlatformMarginPreflight({policy,pricedShots,customerPriceEvidencePerShot,quoteObservedAt,
  additionalCostEvidenceByShot:[{...additional,coveredCategories:["compute"]}],now:Date.parse("2026-11-25T16:06:00Z")});
 assert.equal(incomplete.readyForDispatch,false);
 assert.equal(incomplete.code,"PLATFORM_MARGIN_VARIABLE_COSTS_UNVERIFIED");
});
