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
  assert.equal(estimateRunwayVideoCredits({model:"grok_imagine_1_5",durationSeconds:5,resolution:"720p",referenceImageCount:2,referenceAudioCount:1,pricingDate:date}).estimatedCredits,83);
  assert.equal(estimateRunwayVideoCredits({model:"grok_imagine_1_5_lite",durationSeconds:5,resolution:"720p",referenceImageCount:3,hasStartFrame:true,pricingDate:date}).estimatedCredits,16);
  assert.equal(estimateRunwayVideoCredits({model:"hailuo3",durationSeconds:5,resolution:"768p",referenceImageCount:2,referenceVideoSeconds:20,pricingDate:date}).estimatedCredits,204);
});

test("uses the dated Kling 4 promotion and automatically reverts to list pricing",()=>{
  const promo=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-04"});
  const regular=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-12-01"});
  assert.equal(promo.estimatedCredits,64);
  assert.equal(promo.discount,"20% promotion through 2026-11-30 UTC");
  assert.equal(regular.estimatedCredits,79);
});

test("refuses unsupported models and malformed or missing price inputs",()=>{
  assert.throws(()=>estimateRunwayVideoCredits({model:"ruby",durationSeconds:5,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_MODEL");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:-1,pricingDate:date}));
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:31,pricingDate:date}));
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,pricingDate:"2026-02-31"}));
});

test("prices Magnific video upscaling by output frame count and resolution",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"magnific_video_upscaler_creative",durationSeconds:10,outputFrames:300,resolution:"720p",pricingDate:date}).estimatedCredits,210);
  assert.equal(estimateRunwayVideoCredits({model:"magnific_video_upscaler_creative",durationSeconds:10,outputFrames:300,resolution:"2k",pricingDate:date}).estimatedCredits,270);
  assert.equal(estimateRunwayVideoCredits({model:"magnific_video_upscaler_creative",durationSeconds:10,outputFrames:300,resolution:"4k",pricingDate:date}).estimatedCredits,360);
  assert.throws(()=>estimateRunwayVideoCredits({model:"magnific_video_upscaler_creative",durationSeconds:10,resolution:"4k",pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
});

test("prices frame-rate enhancement and Ruby HDR from input duration and source dimensions",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"enhance_frame_rate",durationSeconds:5,inputVideoSeconds:5,pricingDate:date}).estimatedCredits,3);
  assert.equal(estimateRunwayVideoCredits({model:"ruby",durationSeconds:10,sourceWidth:1920,sourceHeight:1080,pricingDate:date}).estimatedCredits,200);
  assert.equal(estimateRunwayVideoCredits({model:"ruby",durationSeconds:10,sourceWidth:3840,sourceHeight:2160,pricingDate:date}).estimatedCredits,400);
  assert.throws(()=>estimateRunwayVideoCredits({model:"ruby",durationSeconds:10,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,pricingDate:date,outputFormat:"prores"}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION");
});

test("includes Aleph 2 minimum charge and Gemini Omni Flash 1.1 4K tier",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"aleph2",durationSeconds:1,pricingDate:date}).estimatedCredits,56);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.1",durationSeconds:5,resolution:"4k",pricingDate:date}).estimatedCredits,150);
});
