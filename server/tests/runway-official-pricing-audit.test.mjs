import test from "node:test";
import assert from "node:assert/strict";
import {estimateRunwayVideoCredits} from "../runway-video-pricing.mjs";

const pricingDate="2026-11-25";

test("Seedance 2.5 published 1080p and 4K rates match the official Runway Dev price sheet",()=>{
 const five1080=estimateRunwayVideoCredits({model:"seedance2_5",durationSeconds:5,resolution:"1080p",pricingDate});
 const five4k=estimateRunwayVideoCredits({model:"seedance2_5",durationSeconds:5,resolution:"4k",pricingDate});
 assert.equal(five1080.estimatedCredits,340);
 assert.equal(five1080.estimatedUsd,3.4);
 assert.equal(five4k.estimatedCredits,550);
 assert.equal(five4k.estimatedUsd,5.5);
});

test("Seedance 2.5 reference video is separately charged at half the output rate",()=>{
 const result=estimateRunwayVideoCredits({model:"seedance2_5",durationSeconds:5,resolution:"1080p",
  referenceVideoSeconds:2,pricingDate});
 assert.equal(result.estimatedCredits,408);
 assert.equal(result.estimatedUsd,4.08);
});

test("Kling 3.0 Standard explicitly distinguishes audio and silent output",()=>{
 const silent=estimateRunwayVideoCredits({model:"kling3.0_standard",durationSeconds:5,audio:false,pricingDate});
 const audio=estimateRunwayVideoCredits({model:"kling3.0_standard",durationSeconds:5,audio:true,pricingDate});
 assert.equal(silent.estimatedCredits,45);
 assert.equal(silent.estimatedUsd,0.45);
 assert.equal(audio.estimatedCredits,65);
 assert.equal(audio.estimatedUsd,0.65);
});

test("WAN 3.0 1080p, 720p and 480p rates are independently covered",()=>{
 const estimate=resolution=>estimateRunwayVideoCredits({model:"wan3",durationSeconds:5,resolution,pricingDate});
 assert.equal(estimate("480p").estimatedCredits,25);
 assert.equal(estimate("720p").estimatedCredits,50);
 assert.equal(estimate("1080p").estimatedCredits,100);
});

test("WAN 3.0 Prime remains a separate higher-priced model tier",()=>{
 const base=estimateRunwayVideoCredits({model:"wan3",durationSeconds:5,resolution:"1080p",pricingDate});
 const prime=estimateRunwayVideoCredits({model:"wan3_prime",durationSeconds:5,resolution:"1080p",pricingDate});
 assert.equal(base.estimatedCredits,100);
 assert.equal(prime.estimatedCredits,140);
});

test("Kling 3.0 Pro and 4K published tiers remain distinct from Standard",()=>{
 const proSilent=estimateRunwayVideoCredits({model:"kling3.0_pro",durationSeconds:5,audio:false,pricingDate});
 const proAudio=estimateRunwayVideoCredits({model:"kling3.0_pro",durationSeconds:5,audio:true,pricingDate});
 const fourK=estimateRunwayVideoCredits({model:"kling3.0_4k",durationSeconds:5,audio:false,pricingDate});
 assert.equal(proSilent.estimatedCredits,60);
 assert.equal(proAudio.estimatedCredits,85);
 assert.equal(fourK.estimatedCredits,215);
});

test("Gemini Omni Flash 1.1 1080p uses its distinct published fifteen-credit rate",()=>{
 const result=estimateRunwayVideoCredits({model:"gemini_omni_flash_1.1",durationSeconds:5,
  resolution:"1080p",pricingDate});
 assert.equal(result.estimatedCredits,75);
 assert.equal(result.estimatedUsd,0.75);
});

test("Kling 4.0 promotional pricing rounds the list charge before applying the discount",()=>{
 const five1080=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"1080p",pricingDate:"2026-11-25",hdr:false});
 const five720=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-25",hdr:false});
 assert.equal(five1080.estimatedCredits,95);
 assert.equal(five720.estimatedCredits,64);
 assert.equal(five1080.discount,"20% promotion through 2026-11-30 UTC");
});

test("Kling 4.0 promotion ends after November 30 and 4K is not discounted",()=>{
 const dec1080=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"1080p",pricingDate:"2026-12-01",hdr:false});
 const promo4k=estimateRunwayVideoCredits({model:"kling_4",durationSeconds:5,resolution:"4k",pricingDate:"2026-11-25",hdr:false});
 assert.equal(dec1080.estimatedCredits,118);
 assert.equal(dec1080.discount,null);
 assert.equal(promo4k.estimatedCredits,275);
 assert.equal(promo4k.discount,null);
});

test("Gemini Omni Flash 1.2 and Kling 4.0 Flash retain distinct current price tiers",()=>{
 const gemini1080=estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"1080p",pricingDate:"2026-11-25"});
 const gemini720=estimateRunwayVideoCredits({model:"gemini_omni_flash_1.2",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-25"});
 const klingFlash=estimateRunwayVideoCredits({model:"kling_4_flash",durationSeconds:5,resolution:"720p",pricingDate:"2026-11-25"});
 assert.equal(gemini1080.estimatedCredits,50);
 assert.equal(gemini720.estimatedCredits,35);
 assert.equal(klingFlash.estimatedCredits,47);
});
