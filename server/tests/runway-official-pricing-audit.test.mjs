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
