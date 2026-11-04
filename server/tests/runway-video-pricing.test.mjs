import test from "node:test";
import assert from "node:assert/strict";
import { estimateRunwayVideoCredits } from "../runway-video-pricing.mjs";

const date="2026-11-04";

test("prices straightforward models from the dated published rate card",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,pricingDate:date}).estimatedCredits,60);
  assert.equal(estimateRunwayVideoCredits({model:"gen4_turbo",durationSeconds:5,pricingDate:date}).estimatedCredits,25);
  assert.equal(estimateRunwayVideoCredits({model:"act_two",durationSeconds:4,pricingDate:date}).estimatedUsd,0.2);
});

test("requires audio choice for models whose rates differ by audio",()=>{
  assert.throws(()=>estimateRunwayVideoCredits({model:"kling3.0_standard",durationSeconds:5,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.equal(estimateRunwayVideoCredits({model:"kling3.0_standard",durationSeconds:5,audio:false,pricingDate:date}).estimatedCredits,45);
  assert.equal(estimateRunwayVideoCredits({model:"kling3.0_standard",durationSeconds:5,audio:true,pricingDate:date}).estimatedCredits,65);
  assert.equal(estimateRunwayVideoCredits({model:"veo3.1_fast",durationSeconds:4,audio:true,pricingDate:date}).estimatedCredits,60);
});

test("uses resolution-specific rates and rejects unsupported resolutions",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"wan3",durationSeconds:5,resolution:"1080p",pricingDate:date}).estimatedCredits,100);
  assert.equal(estimateRunwayVideoCredits({model:"wan3_prime",durationSeconds:5,resolution:"480p",pricingDate:date}).estimatedCredits,34);
  assert.throws(()=>estimateRunwayVideoCredits({model:"wan3",durationSeconds:5,resolution:"4k",pricingDate:date}));
});

test("applies minimum credit charges for Seedance tiers",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"seedance2",durationSeconds:2,resolution:"480p",pricingDate:date}).estimatedCredits,56);
  assert.equal(estimateRunwayVideoCredits({model:"seedance2_fast",durationSeconds:2,resolution:"720p",pricingDate:date}).estimatedCredits,48);
  assert.equal(estimateRunwayVideoCredits({model:"seedance2_mini",durationSeconds:2,resolution:"480p",pricingDate:date}).estimatedCredits,28);
});

test("accounts for Seedance 2.5 input and reference video duration with a 30-second cap",()=>{
  const estimate=estimateRunwayVideoCredits({model:"seedance2_5",durationSeconds:5,resolution:"720p",inputVideoSeconds:20,referenceVideoSeconds:20,pricingDate:date});
  assert.equal(estimate.estimatedCredits,600);
  assert.equal(estimate.settlementEligible,false);
});

test("accounts for reference media charges on Grok and Hailuo models",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"grok_imagine_1_5",durationSeconds:5,resolution:"720p",referenceImageCount:2,pricingDate:date}).estimatedCredits,82);
  assert.equal(estimateRunwayVideoCredits({model:"hailuo3",durationSeconds:5,resolution:"768p",referenceImageCount:2,referenceVideoSeconds:20,pricingDate:date}).estimatedCredits,110);
});

test("uses the dated Kling 4 promotion and automatically reverts to list pricing",()=>{
  const promo=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-04"});
  const regular=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-12-01"});
  assert.equal(promo.estimatedCredits,62.8);
  assert.equal(promo.discount,"20% promotion through 2026-11-30 UTC");
  assert.equal(regular.estimatedCredits,78.5);
});

test("refuses unsupported models and malformed or missing price inputs",()=>{
  assert.throws(()=>estimateRunwayVideoCredits({model:"ruby",durationSeconds:5,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_MODEL");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:-1,pricingDate:date}));
});
