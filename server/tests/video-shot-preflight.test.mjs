import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { preflightVideoProduction } from "../video-shot-preflight.mjs";
import { getProviderCatalog } from "../provider-registry.mjs";

const video={id:"video",provider:"runway",model:"seedance2_5",status:"ready",reason:"configured",
 availableModels:[{id:"seedance2_5",minDurationSeconds:4,maxDurationSeconds:30,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default","480p","720p","1080p"],constraints:{multipleReferenceImages:true}}]};
const providerCatalog={providers:[video]};
const pricing=[{provider:"runway",model:"seedance2_5",currency:"USD",sourceUrl:"https://provider.example/pricing",
 observedAt:"2026-11-10T00:00:00.000Z",expiresAt:"2026-12-10T00:00:00.000Z",
 ratesPerSecond:{"720p":0.2},billingIncrementSeconds:1}];
const shot={id:"shot-01",provider:"runway",model:"seedance2_5",prompt:"A wide cinematic establishing shot.",durationSeconds:8,aspectRatio:"16:9",resolution:"720p",audioMode:"none",referenceImageCount:1,rightsConfirmed:true};
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
 assert.match(result.reason,/price will be invented/);
});
test("preflight validates shot count, prompt and input shape",()=>{
 assert.equal(preflightVideoProduction({shots:[],providerCatalog,pricingCatalog:pricing}).status,"blocked");
 assert.equal(preflightVideoProduction({shots:Array(13).fill(shot),providerCatalog,pricingCatalog:pricing}).status,"blocked");
 const result=preflightVideoProduction({shots:[{...shot,prompt:""}],providerCatalog,pricingCatalog:pricing,now});
 assert.equal(result.status,"blocked");
 assert.equal(result.shots[0].checks.find(check=>check.id==="prompt").status,"failed");
});


test("preflight rejects generated or reference audio when the selected model does not advertise it",()=>{
 for(const audioMode of ["generated","reference"]){
  const result=preflightVideoProduction({shots:[{...shot,audioMode}],providerCatalog,pricingCatalog:pricing,now});
  assert.equal(result.status,"blocked",audioMode);
  assert.equal(result.shots[0].checks.find(check=>check.id==="audio_mode").status,"failed");
  assert.match(result.shots[0].checks.find(check=>check.id==="audio_mode").reason,/does not advertise/);
  assert.equal(result.requestsSubmitted,false);
 }
});
test("preflight accepts generated audio only when the exact model advertises generated-audio support",()=>{
 const audioProvider={providers:[{...video,availableModels:[{...video.availableModels[0],audioModes:["generate"]}]}]};
 const result=preflightVideoProduction({shots:[{...shot,audioMode:"generated"}],providerCatalog:audioProvider,pricingCatalog:pricing,now});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.shots[0].checks.find(check=>check.id==="audio_mode").status,"passed");
});
test("preflight permits explicit no-audio and provider-default modes but rejects unknown audio modes",()=>{
 for(const audioMode of ["none","provider_default"]){
  const result=preflightVideoProduction({shots:[{...shot,audioMode}],providerCatalog,pricingCatalog:pricing,now});
  assert.equal(result.status,"ready_for_approval",audioMode);
 }
 const invalid=preflightVideoProduction({shots:[{...shot,audioMode:"clone_voice"}],providerCatalog,pricingCatalog:pricing,now});
 assert.equal(invalid.status,"blocked");
 assert.equal(invalid.shots[0].checks.find(check=>check.id==="audio_mode").status,"failed");
});


test("preflight recognizes the durable Fal worker adapter",()=>{
 const falVideo={...video,provider:"fal",model:"fal-video-model",availableModels:[],modelCapabilities:{
  minDurationSeconds:1,maxDurationSeconds:30,aspectRatios:["16:9"],resolutions:["provider_default"],referenceImages:false,audioModes:[]
 }};
 const falShot={...shot,provider:"fal",model:"fal-video-model",durationSeconds:5,resolution:"provider_default",referenceImageCount:0,audioMode:"none"};
 const result=preflightVideoProduction({shots:[falShot],providerCatalog:{providers:[falVideo]},pricingCatalog:pricing,now});
 assert.equal(result.status,"pricing_unverified");
 assert.equal(result.readyForApproval,false);
 assert.equal(result.shots[0].checks.find(check=>check.id==="worker_adapter").status,"passed");
 assert.equal(result.requestsSubmitted,false);
});
test("preflight explicitly records the durable Runway worker adapter as supported",()=>{
 const result=preflightVideoProduction({shots:[shot],providerCatalog,pricingCatalog:pricing,now});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.shots[0].checks.find(check=>check.id==="worker_adapter").status,"passed");
});

test("preflight blocks shots without explicit rights clearance",()=>{
 for(const patch of [{rightsConfirmed:false},{rightsConfirmed:undefined}]){
  const result=preflightVideoProduction({shots:[{...shot,...patch}],providerCatalog,pricingCatalog:pricing,now});
  assert.equal(result.status,"blocked");
  assert.equal(result.shots[0].checks.find(item=>item.id==="rights").status,"failed");
 }
});

const lumaProvider={id:"video-luma",provider:"luma",model:"ray-3.2",status:"ready",reason:"configured",
 capabilities:["video.generate"],
 modelCapabilities:{minDurationSeconds:5,maxDurationSeconds:10,aspectRatios:["16:9","9:16","1:1"],resolutions:["360p","540p","720p","1080p"],referenceImages:true,maxReferenceImages:1,audioModes:["none"],durationsSeconds:[5,10],operations:["generate","edit","reframe","extend"]},
 availableModels:[{id:"ray-3.2",label:"Luma Ray 3.2",readiness:"ready",available:true,executionVerified:true,
  minDurationSeconds:5,maxDurationSeconds:10,aspectRatios:["16:9","9:16","1:1"],resolutions:["360p","540p","720p","1080p"],
  referenceImages:true,maxReferenceImages:1,audioModes:["none"]}]};
const lumaShot={id:"luma-shot-01",provider:"luma",model:"ray-3.2",prompt:"A cinematic portrait of a city at sunrise.",
 durationSeconds:5,aspectRatio:"9:16",resolution:"720p",audioMode:"none",referenceImageCount:1,rightsConfirmed:true};
const lumaCatalog={providers:[lumaProvider]};
const privateSourceId="182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";

test("Luma Ray 3.2 passes exact model, first-frame and account-rate preflight without submitting work",()=>{
 const result=preflightVideoProduction({shots:[lumaShot],providerCatalog:{providers:[video,lumaProvider]},lumaUsdPerCredit:"0.003",now});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.readyForApproval,true);
 assert.equal(result.requestsSubmitted,false);
 assert.equal(result.pricing.quote.amount,0.3);
 assert.equal(result.pricing.quote.shots[0].provider,"luma");
 assert.equal(result.pricing.quote.shots[0].pricing.credits,100);
 assert.match(result.pricing.quote.shots[0].pricing.sourceUrl,/lumalabs\.ai/);
 assert.ok(result.pricing.quote.shots[0].pricing.expiresAt>result.pricing.quote.shots[0].pricing.observedAt);
 assert.ok(result.shots[0].checks.every(check=>check.status==="passed"));
});

test("Luma preflight rejects unsupported resolution, excessive references and missing account rate",()=>{
 const unsupported=preflightVideoProduction({shots:[{...lumaShot,resolution:"4k"}],providerCatalog:{providers:[lumaProvider]},lumaUsdPerCredit:"0.003",now});
 assert.equal(unsupported.status,"blocked");
 const tooMany=preflightVideoProduction({shots:[{...lumaShot,referenceImageCount:2}],providerCatalog:{providers:[lumaProvider]},lumaUsdPerCredit:"0.003",now});
 assert.equal(tooMany.status,"blocked");
 const noRate=preflightVideoProduction({shots:[lumaShot],providerCatalog:{providers:[lumaProvider]},now});
 assert.equal(noRate.status,"pricing_unverified");
 assert.equal(noRate.requestsSubmitted,false);
});

test("Luma preflight refuses to proceed when its provider or worker readiness gate is closed",()=>{
 const blockedProvider={...lumaProvider,status:"needs_configuration",reason:"Apply private file migration."};
 const result=preflightVideoProduction({shots:[lumaShot],providerCatalog:{providers:[blockedProvider]},lumaUsdPerCredit:"0.003",now});
 assert.equal(result.status,"blocked");
 assert.equal(result.shots[0].checks.find(check=>check.id==="provider").status,"failed");
});

test("Luma Ray 3.2 preflight uses the configured account rate and supports 360p draft without submitting",()=>{
 const result=preflightVideoProduction({shots:[{...lumaShot,resolution:"360p"}],providerCatalog:lumaCatalog,lumaUsdPerCredit:"0.004",now});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.pricing.quote.amount,0.08);
 assert.equal(result.pricing.quote.shots[0].pricing.credits,20);
 assert.equal(result.requestsSubmitted,false);
});
test("Luma preflight rejects unsupported durations and requires explicit account pricing",()=>{
 const duration=preflightVideoProduction({shots:[{...lumaShot,durationSeconds:7}],providerCatalog:lumaCatalog,lumaUsdPerCredit:"0.004",now});
 assert.equal(duration.status,"blocked");
 assert.equal(duration.shots[0].checks.find(x=>x.id==="duration").status,"failed");
 const rate=preflightVideoProduction({shots:[lumaShot],providerCatalog:lumaCatalog,lumaUsdPerCredit:"",now});
 assert.equal(rate.status,"pricing_unverified");
 assert.equal(rate.requestsSubmitted,false);
});
test("Luma preflight prices edit, extend and reframe with distinct published credit schedules",()=>{
 const edit=preflightVideoProduction({shots:[{...lumaShot,operation:"edit",resolution:"720p",sourceVideoAssetId:privateSourceId}],providerCatalog:lumaCatalog,lumaUsdPerCredit:"0.003",now});
 assert.equal(edit.status,"ready_for_approval");
 assert.equal(edit.pricing.quote.shots[0].pricing.credits,360);
 const extend=preflightVideoProduction({shots:[{...lumaShot,operation:"extend",resolution:"720p",durationSeconds:10,sourceGenerationId:privateSourceId}],providerCatalog:lumaCatalog,lumaUsdPerCredit:"0.003",now});
 assert.equal(extend.status,"ready_for_approval");
 assert.equal(extend.pricing.quote.shots[0].pricing.credits,100);
 const reframe=preflightVideoProduction({shots:[{...lumaShot,operation:"reframe",resolution:"720p",durationSeconds:20,sourceVideoAssetId:privateSourceId}],providerCatalog:lumaCatalog,lumaUsdPerCredit:"0.003",now});
 assert.equal(reframe.status,"ready_for_approval");
 assert.equal(reframe.pricing.quote.shots[0].pricing.credits,800);
});
test("Luma edit, reframe and extension preflight reject missing or malformed source identity",()=>{
 for(const patch of [{operation:"edit"},{operation:"reframe",sourceVideoAssetId:"not-a-uuid"},{operation:"extend",sourceGenerationId:"bad"}]){
  const result=preflightVideoProduction({shots:[{...lumaShot,...patch}],providerCatalog:lumaCatalog,lumaUsdPerCredit:"0.003",now});
  assert.equal(result.status,"blocked");
  assert.equal(result.shots[0].checks.find(x=>x.id==="source_video").status,"failed");
 }
});


test("Runway Model Router catalogue profile passes the real shot preflight contract without submitting a provider request",()=>{
 const catalog=getProviderCatalog({
  VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
  CLOUD_WORKER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",
  RUNWAY_MODEL_ROUTER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",
  RUNWAY_VIDEO_ROUTER_CONFIG:"production-video",RUNWAY_API_KEY:"server-only"
 });
 const routerPricing=[{
  provider:"runway",model:"model-router",currency:"USD",sourceUrl:"https://docs.dev.runwayml.com/pricing/",
  observedAt:"2026-11-11T00:00:00.000Z",expiresAt:"2026-12-11T00:00:00.000Z",
  ratesPerSecond:{"provider_default":0.1},billingIncrementSeconds:1
 }];
 const routerShot={...shot,model:"model-router",durationSeconds:8,resolution:"provider_default",referenceImageCount:1,audioMode:"none"};
 const result=preflightVideoProduction({shots:[routerShot],providerCatalog:catalog,pricingCatalog:routerPricing,now});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.readyForApproval,true);
 assert.equal(result.requestsSubmitted,false);
 assert.equal(result.pricing.quote.amount,0.8);
 assert.ok(result.shots[0].checks.every(check=>check.status==="passed"));
});


test("Runway Model Router preflight supports first-frame and private source-video operations",()=>{
 const catalog=getProviderCatalog({
  VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
  CLOUD_WORKER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",
  RUNWAY_MODEL_ROUTER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",
  RUNWAY_VIDEO_ROUTER_CONFIG:"production-video",RUNWAY_API_KEY:"server-only"
 });
 const routerPricing=[{
  provider:"runway",model:"model-router",currency:"USD",sourceUrl:"https://docs.dev.runwayml.com/pricing/",
  observedAt:"2026-11-11T00:00:00.000Z",expiresAt:"2026-12-11T00:00:00.000Z",
  ratesPerSecond:{"provider_default":0.1},billingIncrementSeconds:1
 }];
 const imageShot={...shot,model:"model-router",operation:"image-to-video",durationSeconds:8,resolution:"provider_default",referenceImageCount:1,audioMode:"none"};
 const imageResult=preflightVideoProduction({shots:[imageShot],providerCatalog:catalog,pricingCatalog:routerPricing,now});
 assert.equal(imageResult.status,"ready_for_approval");
 assert.equal(imageResult.requestsSubmitted,false);
 assert.ok(imageResult.shots[0].checks.every(check=>check.status==="passed"));
 const missingFrame=preflightVideoProduction({shots:[{...imageShot,referenceImageCount:0}],providerCatalog:catalog,pricingCatalog:routerPricing,now});
 assert.equal(missingFrame.status,"blocked");
 assert.equal(missingFrame.shots[0].checks.find(check=>check.id==="references").status,"failed");
 const sourceVideoAssetId="a2f40e12-9d7e-4f42-9a16-83c5d9a1a004";
 const sourceShot={...shot,model:"model-router",operation:"video-to-video",durationSeconds:12,resolution:"provider_default",referenceImageCount:0,audioMode:"none",sourceVideoAssetId};
 const sourceResult=preflightVideoProduction({shots:[sourceShot],providerCatalog:catalog,pricingCatalog:routerPricing,now});
 assert.equal(sourceResult.status,"ready_for_approval");
 assert.equal(sourceResult.requestsSubmitted,false);
 assert.ok(sourceResult.shots[0].checks.every(check=>check.status==="passed"));
 const missingSource=preflightVideoProduction({shots:[{...sourceShot,sourceVideoAssetId:""}],providerCatalog:catalog,pricingCatalog:routerPricing,now});
 assert.equal(missingSource.status,"blocked");
 assert.equal(missingSource.shots[0].checks.find(check=>check.id==="source_video").status,"failed");
 const invalidSource=preflightVideoProduction({shots:[{...sourceShot,sourceVideoAssetId:"not-a-uuid"}],providerCatalog:catalog,pricingCatalog:routerPricing,now});
 assert.equal(invalidSource.status,"blocked");
 assert.equal(invalidSource.shots[0].checks.find(check=>check.id==="source_video").status,"failed");
});


test("customer-facing storyboard preflight renders per-shot provider cost and customer credits safely",async()=>{
 const app=await readFile(new URL("../../src/platform/app.ts",import.meta.url),"utf8");
 assert.match(app,/customer-credit-quote-breakdown/);
 assert.match(app,/providerTotal\.textContent=/);
 assert.match(app,/totalStrong\.textContent=/);
 assert.match(app,/creditRows\.find\(item=>item\?\.shotId===shot\?\.shotId\)/);
 assert.match(app,/item\.textContent=label/);
 assert.match(app,/panel\.replaceChildren\(\)/);
 assert.match(app,/Customer-credit pricing is unavailable\. No fallback price has been assumed/);
 assert.match(app,/no customer credits were reserved or deducted/i);
});
