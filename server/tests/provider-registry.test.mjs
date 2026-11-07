import test from "node:test";
import assert from "node:assert/strict";
import { getProviderCatalog, findProviderForCapability, requireProviderForCapability } from "../provider-registry.mjs";

test("provider catalog is safe by default and never exposes credentials or submits work",()=>{
 const catalog=getProviderCatalog({});
 assert.equal(catalog.summary.total,8);
 assert.equal(catalog.summary.ready,0);
 assert.equal(catalog.summary.disabled,6);
 assert.equal(catalog.providers.find(x=>x.id==="local-media").status,"unavailable");
 assert.equal(catalog.providers.find(x=>x.id==="local-media").capabilities.includes("media.upscale"),true);
 assert.deepEqual(catalog.policy,{remoteCallsRequireExplicitOptIn:true,credentialsExposed:false,pricesEstimated:false,requestsSubmitted:false});
 assert.equal(JSON.stringify(catalog).includes("API_KEY"),false);
});

test("local gateways become ready without remote opt-in and secrets remain hidden",()=>{
 const catalog=getProviderCatalog({
  AI_GATEWAY_ENABLED:"true",AI_GATEWAY_URL:"http://127.0.0.1:20128/v1",AI_GATEWAY_MODEL:"local-text",AI_GATEWAY_API_KEY:"do-not-return",
  VOICE_GATEWAY_ENABLED:"true",VOICE_GATEWAY_URL:"http://localhost:9000/v1",VOICE_GATEWAY_MODEL:"local-speech",
  VOICE_TRANSCRIPTION_ENABLED:"true",VOICE_TRANSCRIPTION_MODEL:"local-asr"
 },{ffmpeg:true,ffprobe:true});
 assert.equal(catalog.providers.find(x=>x.id==="text").status,"ready");
 assert.equal(catalog.providers.find(x=>x.id==="voice").status,"ready");
 assert.equal(catalog.providers.find(x=>x.id==="transcription").status,"ready");
 assert.equal(catalog.providers.find(x=>x.id==="local-media").status,"ready");
 assert.deepEqual(catalog.providers.find(x=>x.id==="local-media").capabilities.filter(value=>value.startsWith("media.")),["media.probe","media.thumbnail","media.transcode","media.proxy","media.audio_extract","media.audio-clean","media.denoise","media.color","media.resize","media.interpolate","media.upscale"]);
 assert.equal(JSON.stringify(catalog).includes("do-not-return"),false);
 assert.equal(findProviderForCapability(catalog,"text.generate").provider,"text");
});

test("remote providers stay blocked until explicit opt-in",()=>{
 const catalog=getProviderCatalog({
  IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_URL:"https://images.example.test/v1",IMAGE_GATEWAY_MODEL:"image-model",
  IMAGE_GATEWAY_ALLOW_REMOTE:"false",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"false",FAL_KEY:"secret",FAL_VIDEO_MODEL:"video/model"
 });
 assert.equal(catalog.providers.find(x=>x.id==="image").status,"remote_opt_in_required");
 assert.equal(catalog.providers.find(x=>x.id==="video").status,"remote_opt_in_required");
 assert.equal(findProviderForCapability(catalog,"image.generate"),null);
 assert.equal(JSON.stringify(catalog).includes("secret"),false);
});

test("remote opt-in and valid HTTPS configuration make capability eligible without submitting a request",()=>{
 const catalog=getProviderCatalog({
  AI_GATEWAY_ENABLED:"true",AI_GATEWAY_URL:"https://gateway.example.test/v1",AI_GATEWAY_MODEL:"text-model",AI_GATEWAY_ALLOW_REMOTE:"true"
 });
 const selected=findProviderForCapability(catalog,"text.translate",{allowRemote:true});
 assert.deepEqual(selected,{provider:"text",model:"text-model",remote:true});
 assert.equal(catalog.policy.requestsSubmitted,false);
});

test("malformed, credential-bearing and insecure non-local URLs fail readiness",()=>{
 const catalog=getProviderCatalog({
  AI_GATEWAY_ENABLED:"true",AI_GATEWAY_URL:"http://gateway.example.test/v1",AI_GATEWAY_MODEL:"model",AI_GATEWAY_ALLOW_REMOTE:"true",
  IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_URL:"https://user:password@example.test/v1",IMAGE_GATEWAY_MODEL:"image",IMAGE_GATEWAY_ALLOW_REMOTE:"true"
 });
 assert.equal(catalog.providers.find(x=>x.id==="text").status,"needs_configuration");
 assert.equal(catalog.providers.find(x=>x.id==="image").status,"needs_configuration");
});

test("unsupported image provider identifiers never appear ready",()=>{
 const catalog=getProviderCatalog({IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_PROVIDER:"unknown",IMAGE_GATEWAY_URL:"https://images.example.test/v1",IMAGE_GATEWAY_MODEL:"model",IMAGE_GATEWAY_ALLOW_REMOTE:"true"});
 const image=catalog.providers.find(item=>item.id==="image");
 assert.equal(image.status,"needs_configuration");
 assert.equal(findProviderForCapability(catalog,"image.generate",{allowRemote:true}),null);
});

test("provider readiness never advertises unimplemented reference or image-to-video inputs",()=>{
 const catalog=getProviderCatalog({
  IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_URL:"https://images.example.test/v1",IMAGE_GATEWAY_MODEL:"image-model",IMAGE_GATEWAY_ALLOW_REMOTE:"true",
  VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"secret",FAL_VIDEO_MODEL:"video/model"
 });
 const image=catalog.providers.find(x=>x.id==="image");
 const video=catalog.providers.find(x=>x.id==="video");
 assert.deepEqual(image.capabilities,["image.generate"]);
 assert.deepEqual(video.capabilities,["video.generate"]);
 assert.equal(findProviderForCapability(catalog,"image.reference",{allowRemote:true}),null);
 assert.equal(findProviderForCapability(catalog,"image.variation",{allowRemote:true}),null);
 assert.equal(findProviderForCapability(catalog,"video.image_to_video",{allowRemote:true}),null);
});

test("video provider catalog exposes the configured adapter's actual model capability declaration",()=>{
 const unconfigured=getProviderCatalog({VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"secret",FAL_VIDEO_MODEL:"fal-ai/model"});
 const video=unconfigured.providers.find(item=>item.id==="video");
 assert.deepEqual(video.modelCapabilities.aspectRatios,["16:9","9:16","1:1"]);
 assert.equal(video.availableModels[0].id,"fal-ai/model");
 assert.deepEqual(video.modelCapabilities.resolutions,["provider_default"]);
 assert.equal(video.modelCapabilities.negativePrompt,false);
 assert.equal(video.modelCapabilities.referenceImages,false);
 const configuredReference=getProviderCatalog({FAL_VIDEO_IMAGE_INPUT_FIELD:"image_url"});
 assert.equal(configuredReference.providers.find(item=>item.id==="video").modelCapabilities.referenceImages,true);
 assert.equal(JSON.stringify(unconfigured).includes("secret"),false);
});


test("Runway adapter exposes verified text-to-video and first-frame image-to-video models",()=>{
 const catalog=getProviderCatalog({
  VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
  RUNWAYML_API_SECRET:"do-not-return",RUNWAY_VIDEO_MODEL:"seedance2_5"
 });
 const video=catalog.providers.find(item=>item.id==="video");
 assert.equal(video.provider,"runway");
 assert.equal(video.status,"ready");
 assert.equal(video.model,"seedance2_5");
 assert.equal(video.modelCapabilities.maxDurationSeconds,30);
 assert.equal(video.modelCapabilities.referenceImages,false);
 assert.ok(video.availableModels.some(model=>model.id==="kling_4"));
 assert.equal(JSON.stringify(catalog).includes("do-not-return"),false);
});
test("Runway remains blocked without remote opt-in or credentials",()=>{
 const noKey=getProviderCatalog({VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_MODEL:"seedance2_5"});
 assert.equal(noKey.providers.find(item=>item.id==="video").status,"needs_configuration");
 const noOptIn=getProviderCatalog({VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"false",RUNWAYML_API_SECRET:"secret",RUNWAY_VIDEO_MODEL:"seedance2_5"});
 assert.equal(noOptIn.providers.find(item=>item.id==="video").status,"remote_opt_in_required");
});
test("Gemini Nano Banana Pro is exposed only when configured and explicitly opted in",()=>{
 const ready=getProviderCatalog({IMAGE_GATEWAY_PROVIDER:"gemini",IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_ALLOW_REMOTE:"true",GEMINI_API_KEY:"do-not-return",GEMINI_IMAGE_MODEL:"gemini-3-pro-image"});
 const image=ready.providers.find(item=>item.id==="image");
 assert.equal(image.provider,"gemini");assert.equal(image.status,"ready");assert.equal(image.model,"gemini-3-pro-image");
 assert.equal(image.availableModels[0].id,"gemini-3-pro-image");
 assert.equal(JSON.stringify(ready).includes("do-not-return"),false);
 const blocked=getProviderCatalog({IMAGE_GATEWAY_PROVIDER:"gemini",IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_ALLOW_REMOTE:"false",GEMINI_API_KEY:"secret",GEMINI_IMAGE_MODEL:"gemini-3-pro-image"});
 assert.equal(blocked.providers.find(item=>item.id==="image").status,"remote_opt_in_required");
});
test("AI upscaler is visible as a separate local capability and remains unavailable without a configured engine",()=>{
 const catalog=getProviderCatalog({});
 const provider=catalog.providers.find(item=>item.id==="ai-upscale");
 assert.equal(provider.status,"unavailable");
 assert.deepEqual(provider.capabilities,[]);
 assert.equal(findProviderForCapability(catalog,"media.ai-upscale"),null);
});

test("AI upscaler requires independent fixture evidence, not a claimed inference flag",()=>{
 const installed=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:false,model:"realesrgan-x4plus",reason:"Execution is disabled."}});
 const installedProvider=installed.providers.find(item=>item.id==="ai-upscale");
 assert.equal(installedProvider.status,"disabled");
 assert.deepEqual(installedProvider.capabilities,[]);
 const enabled=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:true,executionVerified:false,inferenceVerified:false,model:"realesrgan-x4plus",reason:"Self-test required."}});
 const enabledProvider=enabled.providers.find(item=>item.id==="ai-upscale");
 assert.equal(enabledProvider.status,"unverified");
 assert.deepEqual(enabledProvider.capabilities,[]);
 assert.equal(enabled.summary.unverified,1);
 assert.equal(findProviderForCapability(enabled,"media.ai-upscale"),null);
 const executionOnly=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:true,executionVerified:true,inferenceVerified:true,model:"realesrgan-x4plus",reason:"A caller-supplied flag is not evidence."}});
 const executionProvider=executionOnly.providers.find(item=>item.id==="ai-upscale");
 assert.equal(executionProvider.status,"unverified");
 assert.deepEqual(executionProvider.capabilities,[]);
 const qualityChecked=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:true,executionVerified:true,qualityVerified:true,qualityEvidence:{fixtureId:"fixture-set-v1",checkedAt:"2026-11-01T00:00:00.000Z"},model:"realesrgan-x4plus",reason:"Fixture quality checks passed."}});
 const verifiedProvider=qualityChecked.providers.find(item=>item.id==="ai-upscale");
 assert.equal(verifiedProvider.status,"ready");
 assert.deepEqual(verifiedProvider.capabilities,["media.ai-upscale"]);
 assert.equal(findProviderForCapability(qualityChecked,"media.ai-upscale").provider,"local");
});


test("Gemini Omni is visible in settings but remains blocked until app authorization callbacks are composed", () => {
 const catalog = getProviderCatalog({
  GEMINI_API_KEY: "never-return-this",
  GOOGLE_OMNI_VIDEO_ENABLED: "true",
  GOOGLE_OMNI_VIDEO_ALLOW_REMOTE: "true",
  GEMINI_OMNI_ENABLED: "true",
  GEMINI_OMNI_ALLOW_REMOTE: "true"
 });
 const provider = catalog.providers.find(item => item.id === "video-google-omni");
 assert.equal(provider.status, "needs_configuration");
 assert.equal(provider.model, "gemini-omni-1.1-flash");
 assert.match(provider.reason, /application-injected approval/);
 assert.equal(findProviderForCapability(catalog, "video.edit", { allowRemote: true }), null);
 assert.equal(JSON.stringify(catalog).includes("never-return-this"), false);
});

test("Runway GPT Image 2.6 adapter is discoverable but remains disabled until explicit opt-in",()=>{
 const catalog=getProviderCatalog({
  IMAGE_GATEWAY_PROVIDER:"runway",IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_ALLOW_REMOTE:"false",
  RUNWAY_API_KEY:"do-not-return",RUNWAY_IMAGE_MODEL:"gpt_image_2_6_flare"
 });
 const image=catalog.providers.find(item=>item.id==="image");
 assert.equal(image.provider,"runway");
 assert.equal(image.status,"remote_opt_in_required");
 assert.ok(image.availableModels.some(model=>model.id==="gpt_image_2_6_flare"&&model.executionAdapter==="runway-image-v1"));
 assert.ok(image.availableModels.some(model=>model.id==="gpt_image_2_6_sunburst"));
 assert.equal(findProviderForCapability(catalog,"image.generate"),null);
 assert.equal(JSON.stringify(catalog).includes("do-not-return"),false);
});
test("Runway image provider requires an allowlisted model and server key",()=>{
 const noKey=getProviderCatalog({IMAGE_GATEWAY_PROVIDER:"runway",IMAGE_GATEWAY_ENABLED:"true",RUNWAY_IMAGE_MODEL:"gpt_image_2_6_flare"});
 assert.equal(noKey.providers.find(item=>item.id==="image").status,"needs_configuration");
 const wrongModel=getProviderCatalog({IMAGE_GATEWAY_PROVIDER:"runway",IMAGE_GATEWAY_ENABLED:"true",RUNWAY_API_KEY:"secret",RUNWAY_IMAGE_MODEL:"unknown"});
 assert.equal(wrongModel.providers.find(item=>item.id==="image").status,"needs_configuration");
});

test("Runway image Model Router is discoverable only with a valid saved config and remains opt-in gated",()=>{
 const catalog=getProviderCatalog({
  IMAGE_GATEWAY_PROVIDER:"runway",IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_ALLOW_REMOTE:"false",
  RUNWAY_IMAGE_ROUTER_ENABLED:"true",RUNWAY_IMAGE_ROUTER_CONFIG:"campaign-images",RUNWAY_API_KEY:"secret"
 });
 const image=catalog.providers.find(item=>item.id==="image");
 assert.equal(image.model,"model-router");
 assert.equal(image.status,"remote_opt_in_required");
 assert.ok(image.availableModels.some(model=>model.id==="model-router"&&model.outputCounts.max===4));
 assert.equal(findProviderForCapability(catalog,"image.generate"),null);
 const invalid=getProviderCatalog({
  IMAGE_GATEWAY_PROVIDER:"runway",IMAGE_GATEWAY_ENABLED:"true",IMAGE_GATEWAY_ALLOW_REMOTE:"true",
  RUNWAY_IMAGE_ROUTER_ENABLED:"true",RUNWAY_IMAGE_ROUTER_CONFIG:"INVALID SLUG",RUNWAY_API_KEY:"secret"
 });
 assert.equal(invalid.providers.find(item=>item.id==="image").status,"needs_configuration");
});
test("Runway video provider exposes the new Flash profiles but rejects unknown model IDs",()=>{
 const catalog=getProviderCatalog({
  VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
  RUNWAY_API_KEY:"secret",RUNWAY_VIDEO_MODEL:"kling_4_flash"
 });
 const video=catalog.providers.find(item=>item.id==="video");
 assert.equal(video.status,"ready");
 assert.ok(video.availableModels.some(model=>model.id==="kling_4_flash"&&model.maxDurationSeconds===20));
 assert.ok(video.availableModels.some(model=>model.id==="gemini_omni_flash_1.2"&&model.maxDurationSeconds===15&&model.nativeAudio===true));
 const unknown=getProviderCatalog({
  VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
  RUNWAY_API_KEY:"secret",RUNWAY_VIDEO_MODEL:"not-an-adapter"
 });
 assert.equal(unknown.providers.find(item=>item.id==="video").status,"needs_configuration");
});



test("legacy provider exposes only models with a verified synchronous adapter, independent of cloud-worker readiness", () => {
 const catalog=getProviderCatalog({
  VIDEO_GATEWAY_PROVIDER:"runway",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
  RUNWAYML_API_SECRET:"do-not-return",RUNWAY_VIDEO_MODEL:"seedance2_5"
 });
 const video=catalog.providers.find(item=>item.id==="video");
 assert.equal(video.status,"ready");
 for(const id of ["seedance2_5","kling_4","kling_4_flash","gemini_omni_flash_1.2"]){
  assert.equal(video.availableModels.some(model=>model.id===id),true,id+" has a verified legacy adapter");
 }
 for(const id of ["veo3.1","veo3.1_fast","seedance2","seedance2_fast"]){
  assert.equal(video.availableModels.some(model=>model.id===id),false,id+" has no verified legacy adapter");
 }
 assert.equal(JSON.stringify(catalog).includes("do-not-return"),false);
});
