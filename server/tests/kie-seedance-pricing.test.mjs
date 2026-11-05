import test from "node:test";
import assert from "node:assert/strict";
import { createKieActualCostResolver, estimateKieSeedanceCost } from "../kie-seedance-pricing.mjs";

test("estimates Seedance 2.0 using dated Kie resolution and reference-video rates",()=>{
 const fiveSeconds=estimateKieSeedanceCost({durationSeconds:5,resolution:"720p"});
 assert.equal(fiveSeconds.amount,1.025);
 assert.equal(fiveSeconds.credits,205);
 assert.equal(fiveSeconds.pricingDate,"2026-11-05");
 assert.equal(fiveSeconds.settlementEligible,false);
 const withReference=estimateKieSeedanceCost({durationSeconds:5,resolution:"720p",referenceVideoSeconds:5});
 assert.equal(withReference.amount,1.25);
 assert.equal(withReference.credits,250);
 assert.equal(withReference.basis,"provider_list_price_reference_video_seconds_plus_output");
});

test("uses explicit provider-default and 4K resolution pricing",()=>{
 assert.equal(estimateKieSeedanceCost({durationSeconds:5,resolution:"provider_default"}).amount,1.025);
 assert.equal(estimateKieSeedanceCost({durationSeconds:5,resolution:"2160p"}).amount,5.2);
});

test("rejects unpriced models, invalid duration and unsupported reference duration",()=>{
 assert.throws(()=>estimateKieSeedanceCost({model:"bytedance/seedance-2-5",durationSeconds:5}),error=>error.code==="VIDEO_PRICE_UNVERIFIED");
 assert.throws(()=>estimateKieSeedanceCost({durationSeconds:4}),error=>error.code==="VIDEO_PRICE_DURATION_INVALID");
 assert.throws(()=>estimateKieSeedanceCost({durationSeconds:5,referenceVideoSeconds:16}),error=>error.code==="VIDEO_PRICE_INPUT_INVALID");
});

test("settles only from positive task-reported credits and an explicit account credit value",async()=>{
 assert.throws(()=>createKieActualCostResolver({}),error=>error.code==="KIE_BILLING_RATE_REQUIRED");
 const resolve=createKieActualCostResolver({usdPerCredit:"0.005"});
 const result=await resolve({providerTaskId:"task_bytedance_1765186743319",creditsConsumed:205});
 assert.equal(result.amount,1.025);
 assert.equal(result.currency,"USD");
 assert.equal(result.creditsConsumed,205);
 await assert.rejects(resolve({providerTaskId:"task_bytedance_1765186743319",creditsConsumed:null}),error=>error.code==="KIE_BILLING_USAGE_UNAVAILABLE");
 await assert.rejects(resolve({providerTaskId:"invalid",creditsConsumed:205}),error=>error.code==="KIE_BILLING_USAGE_UNAVAILABLE");
});
