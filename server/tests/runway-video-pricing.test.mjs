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
  assert.equal(estimateRunwayVideoCredits({model:"seedance2",durationSeconds:4,resolution:"2160p",pricingDate:date}).estimatedCredits,600);
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
  assert.equal(estimateRunwayVideoCredits({model:"grok_imagine_1_5",durationSeconds:5,resolution:"720p",hasStartFrame:true,referenceImageCount:2,pricingDate:date}).estimatedCredits,83);
  assert.equal(estimateRunwayVideoCredits({model:"grok_imagine_1_5_lite",durationSeconds:5,resolution:"720p",hasStartFrame:true,pricingDate:date}).estimatedCredits,16);
  assert.equal(estimateRunwayVideoCredits({model:"hailuo3",durationSeconds:5,resolution:"768p",referenceImageCount:2,referenceVideoSeconds:20,pricingDate:date}).estimatedCredits,204);
  assert.equal(estimateRunwayVideoCredits({model:"hailuo3",durationSeconds:5,resolution:"768p",hasStartFrame:true,referenceImageCount:2,pricingDate:date}).estimatedCredits,56);
  assert.equal(estimateRunwayVideoCredits({model:"hailuo3",durationSeconds:5,resolution:"768p",referenceImageCount:2,inputVideoSeconds:5,pricingDate:date}).estimatedCredits,104);
});

test("uses the dated Kling 4 promotion and automatically reverts to list pricing",()=>{
  const promo=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-04"});
  const regular=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-12-01"});
  assert.equal(promo.estimatedCredits,64);
  assert.equal(promo.discount,"20% promotion through 2026-11-30 UTC");
  assert.equal(regular.estimatedCredits,79);
  assert.equal(estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"1080p",pricingDate:date}).estimatedCredits,95);
  assert.equal(estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"1080p",pricingDate:"2026-12-01"}).estimatedCredits,118);
  const referenced=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,referenceVideoSeconds:10,resolution:"720p",pricingDate:date});
  assert.equal(referenced.estimatedCredits,113);
});

test("refuses unsupported models and malformed or missing price inputs",()=>{
  assert.throws(()=>estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:5,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
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
  assert.equal(estimateRunwayVideoCredits({model:"enhance_frame_rate",durationSeconds:5,inputVideoSeconds:5,targetFramerate:60,pricingDate:date}).estimatedCredits,3);
  assert.equal(estimateRunwayVideoCredits({model:"enhance_frame_rate",durationSeconds:300,targetFramerate:60,pricingDate:date}).estimatedCredits,150);
  assert.throws(()=>estimateRunwayVideoCredits({model:"enhance_frame_rate",durationSeconds:301,targetFramerate:60,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
  assert.throws(()=>estimateRunwayVideoCredits({model:"enhance_frame_rate",durationSeconds:10,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"enhance_frame_rate",durationSeconds:10,targetFramerate:15,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.equal(estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,sourceWidth:1920,sourceHeight:1080,pricingDate:date}).estimatedCredits,200);
  assert.equal(estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,sourceWidth:3840,sourceHeight:2160,pricingDate:date}).estimatedCredits,400);
  assert.equal(estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,sourceWidth:4096,sourceHeight:2160,pricingDate:date}).estimatedCredits,400);
  assert.equal(estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,sourceWidth:2000,sourceHeight:2000,pricingDate:date}).estimatedCredits,200);
  assert.equal(estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,sourceWidth:2001,sourceHeight:2000,pricingDate:date}).estimatedCredits,400);
  assert.throws(()=>estimateRunwayVideoCredits({model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,pricingDate:date,outputFormat:"unverified_format"}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateRunwayVideoCredits({model:"ruby",durationSeconds:5,sourceWidth:1920,sourceHeight:1080,pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
});

test("includes Aleph 2 minimum charge and Gemini Omni Flash 1.1 4K tier",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"aleph2",durationSeconds:1,pricingDate:date}).estimatedCredits,56);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.1",durationSeconds:5,resolution:"4k",pricingDate:date}).estimatedCredits,150);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.1",durationSeconds:5,resolution:"720p",inputVideoSeconds:5,referenceImageCount:2,hasStartFrame:true,pricingDate:date}).estimatedCredits,58);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash",durationSeconds:5,inputType:"image",pricingDate:date}).estimatedCredits,51);
});

test("Kling O3 video-to-video bills against input duration rather than output duration",()=>{
  const estimate=estimateRunwayVideoCredits({model:"klingO3_pro",durationSeconds:5,inputType:"video",inputVideoSeconds:12,pricingDate:date});
  assert.equal(estimate.estimatedCredits,204);
  assert.throws(()=>estimateRunwayVideoCredits({model:"klingO3_pro",durationSeconds:5,inputType:"video",pricingDate:date}),
    error=>error.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,inputType:"audio",pricingDate:date}),
    error=>error.code==="RUNWAY_PRICE_INVALID_INPUT");
});

test("prices Gen-4.5 and Aleph professional editorial containers",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,outputFormat:"prores",pricingDate:date}).estimatedCredits,85);
  assert.equal(estimateRunwayVideoCredits({model:"aleph2",durationSeconds:2,outputFormat:"png_sequence",pricingDate:date}).estimatedCredits,66);
  assert.equal(estimateRunwayVideoCredits({model:"seedance2_5",durationSeconds:5,resolution:"720p",outputFormat:"mov",pricingDate:date}).estimatedCredits,150);
  assert.throws(()=>estimateRunwayVideoCredits({model:"wan3",durationSeconds:5,resolution:"720p",outputFormat:"prores",pricingDate:date}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION");
});

test("prices 10-bit SDR and Gen-4.5 HDR output by output megapixels",()=>{
  const base={model:"gen4.5",durationSeconds:5,pricingDate:date,outputWidth:1920,outputHeight:1080};
  assert.equal(estimateRunwayVideoCredits({...base,outputFormat:"sdr_rec709_10bit"}).estimatedCredits,160);
  assert.equal(estimateRunwayVideoCredits({...base,outputFormat:"hdr10"}).estimatedCredits,160);
  assert.equal(estimateRunwayVideoCredits({...base,outputFormat:"hdr_prores"}).estimatedCredits,160);
  assert.equal(estimateRunwayVideoCredits({...base,outputWidth:3840,outputHeight:2160,outputFormat:"hdr10"}).estimatedCredits,260);
  assert.equal(estimateRunwayVideoCredits({...base,outputWidth:2000,outputHeight:2000,outputFormat:"hdr10"}).estimatedCredits,160);
  assert.equal(estimateRunwayVideoCredits({...base,outputWidth:2001,outputHeight:2000,outputFormat:"hdr10"}).estimatedCredits,260);
  assert.throws(()=>estimateRunwayVideoCredits({model:"aleph2",durationSeconds:5,outputWidth:1920,outputHeight:1080,outputFormat:"hdr10",pricingDate:date}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gen4.5",durationSeconds:5,outputFormat:"hdr10",pricingDate:date}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
});

test("prices Ruby HDR delivery profiles at the base HDR rate without a second surcharge",()=>{
  const source={model:"ruby",sourceDynamicRange:"sdr",durationSeconds:10,sourceWidth:1920,sourceHeight:1080,pricingDate:date};
  for(const outputFormat of ["hdr10","hlg","hdr_prores","hdr_exr_sequence","hdr_exr_acescg_sequence_1_3","hdr_exr_acescg_sequence_2_0"]) {
    assert.equal(estimateRunwayVideoCredits({...source,outputFormat}).estimatedCredits,200);
  }
  assert.equal(estimateRunwayVideoCredits({...source,sourceWidth:3840,sourceHeight:2160,outputFormat:"hdr10"}).estimatedCredits,400);
  assert.throws(()=>estimateRunwayVideoCredits({...source,outputFormat:"hdr_pq_12bit_master"}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION");
  assert.throws(()=>estimateRunwayVideoCredits({...source,outputFormat:"hdr_png_sequence"}),e=>e.code==="RUNWAY_PRICE_UNSUPPORTED_OPTION");
  assert.equal(estimateRunwayVideoCredits({...source,sourceWidth:4096,sourceHeight:2160,outputFormat:"hdr10"}).estimatedCredits,400);
  const { sourceHeight: omittedHeight, ...missingHeight } = source;
  assert.throws(()=>estimateRunwayVideoCredits({...missingHeight,sourceWidth:4096}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
});

test("Gen-4.5 HDR formats add the documented professional surcharge",()=>{
  const base={model:"gen4.5",durationSeconds:5,outputWidth:1920,outputHeight:1080,pricingDate:date};
  assert.equal(estimateRunwayVideoCredits({...base,outputFormat:"hdr_pq_12bit_master"}).estimatedCredits,160);
  assert.equal(estimateRunwayVideoCredits({...base,outputFormat:"hdr_png_sequence"}).estimatedCredits,160);
  assert.equal(estimateRunwayVideoCredits({...base,outputFormat:"hdr_exr_acescg_sequence_2_0"}).estimatedCredits,160);
});

test("prices Kling 4.0 Flash with its minimum, input-video formula and combined-reference cap",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-07"}).estimatedCredits,47);
  assert.equal(estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:5,resolution:"720p",inputVideoSeconds:3,pricingDate:"2026-11-07"}).estimatedCredits,63);
  assert.equal(estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:5,resolution:"720p",inputVideoSeconds:10,pricingDate:"2026-11-07"}).estimatedCredits,95);
  assert.equal(estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:3,resolution:"720p",pricingDate:"2026-11-07"}).estimatedCredits,29);
  assert.throws(()=>estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:2,resolution:"720p",pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
  assert.throws(()=>estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:5,resolution:"1080p",pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INPUT_REQUIRED");
  assert.throws(()=>estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:5,resolution:"720p",referenceImageCount:10,hasStartFrame:true,pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
});

test("prices Gemini Omni 1.2 by output resolution, image/keyframe and input-video charges",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"360p",pricingDate:"2026-11-07"}).estimatedCredits,10);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-07"}).estimatedCredits,35);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"1080p",pricingDate:"2026-11-07"}).estimatedCredits,50);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"4k",pricingDate:"2026-11-07"}).estimatedCredits,105);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"720p",referenceImageCount:2,hasStartFrame:true,inputVideoSeconds:4,pricingDate:"2026-11-07"}).estimatedCredits,42);
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:3,resolution:"360p",pricingDate:"2026-11-07"}).estimatedCredits,6);
  assert.throws(()=>estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:16,resolution:"720p",pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
  assert.throws(()=>estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"720p",referenceImageCount:5,hasStartFrame:true,pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
});

test("Gemini Omni 1.2 auto-duration reserves the documented 15-second maximum",()=>{
  const estimate=estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationAuto:true,resolution:"720p",pricingDate:"2026-11-07"});
  assert.equal(estimate.estimatedCredits,105);
  assert.equal(estimate.durationAutoReservationSeconds,15);
  assert.equal(estimate.billable,false);
  assert.equal(estimate.settlementEligible,false);
  assert.throws(()=>estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationAuto:true,durationSeconds:5,resolution:"720p",pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
});

test("Gemini Omni 1.2 image-to-video pricing accepts first and optional last keyframes only",()=>{
  assert.equal(estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,inputType:"image",hasStartFrame:true,referenceImageCount:1,resolution:"720p",pricingDate:"2026-11-07"}).estimatedCredits,37);
  assert.throws(()=>estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,inputType:"image",hasStartFrame:true,referenceImageCount:2,resolution:"720p",pricingDate:"2026-11-07"}),e=>e.code==="RUNWAY_PRICE_INVALID_INPUT");
});
