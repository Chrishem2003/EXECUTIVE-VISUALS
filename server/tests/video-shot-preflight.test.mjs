import test from "node:test";
import assert from "node:assert/strict";
import { preflightVideoProduction } from "../video-shot-preflight.mjs";

const video={id:"video",provider:"runway",model:"seedance2_5",status:"ready",reason:"configured",
 availableModels:[{id:"seedance2_5",minDurationSeconds:4,maxDurationSeconds:30,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default","480p","720p","1080p"],constraints:{multipleReferenceImages:true}}]};
const providerCatalog={providers:[video]};
const pricing=[{provider:"runway",model:"seedance2_5",currency:"USD",sourceUrl:"https://provider.example/pricing",
 observedAt:"2026-11-10T00:00:00.000Z",expiresAt:"2026-12-10T00:00:00.000Z",
 ratesPerSecond:{"720p":0.2},billingIncrementSeconds:1}];
const shot={id:"shot-01",provider:"runway",model:"seedance2_5",prompt:"A wide cinematic establishing shot.",durationSeconds:8,aspectRatio:"16:9",resolution:"720p",audioMode:"none",referenceImageCount:1};
const now=()=>new Date("2026-11-11T12:00:00.000Z");

test("provider-aware preflight verifies compatible shots and source-attributed production pricing",()=>{
 const result=preflightVideoProduction({shots:[shot],providerCatalog,pricingCatalog:pricing,now});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.readyForApproval,true);
 assert.equal(result.requestsSubmitted,false);
 assert.equal(result.pricing.status,"verified_estimate");
 assert.equal(result.pricing.quote.amount,1.6);
 assert.ok(result.shots[0].checks.every(check=>check.status==="passed"));
});
test("preflight blocks duration, ratio, resolution, reference and exact-model mismatches",()=>{
 for(const patch of [
  {durationSeconds:31},{durationSeconds:3},{aspectRatio:"4:3"},{resolution:"4k"},
  {referenceImageCount:2,model:"gen4.5"},{model:"unknown"}
 ]){
  const result=preflightVideoProduction({shots:[{...shot,...patch}],providerCatalog,pricingCatalog:pricing,now});
  assert.equal(result.status,"blocked",JSON.stringify(patch));
  assert.equal(result.readyForApproval,false);
  assert.equal(result.requestsSubmitted,false);
 }
});
test("preflight blocks disabled, unconfigured or mismatched providers",()=>{
 for(const patch of [{status:"disabled"},{status:"needs_configuration"},{provider:"fal"}]){
  const result=preflightVideoProduction({shots:[shot],providerCatalog:{providers:[{...video,...patch}]},pricingCatalog:pricing,now});
  assert.equal(result.status,"blocked");
  assert.equal(result.readyForApproval,false);
 }
});
test("technically compatible shots still require current verified pricing",()=>{
 const result=preflightVideoProduction({shots:[shot],providerCatalog,pricingCatalog:[] ,now});
 assert.equal(result.status,"pricing_unverified");
 assert.equal(result.readyForApproval,false);
 assert.equal(result.pricing.status,"unavailable");
 assert.equal(result.requestsSubmitted,false);
 assert.match(result.reason,/will not be invented/);
});
test("preflight validates shot count, prompt and input shape",()=>{
 assert.equal(preflightVideoProduction({shots:[],providerCatalog,pricingCatalog:pricing}).status,"blocked");
 assert.equal(preflightVideoProduction({shots:Array(13).fill(shot),providerCatalog,pricingCatalog:pricing}).status,"blocked");
 const result=preflightVideoProduction({shots:[{...shot,prompt:""}],providerCatalog,pricingCatalog:pricing,now});
 assert.equal(result.status,"blocked");
 assert.equal(result.shots[0].checks.find(check=>check.id==="prompt").status,"failed");
});
