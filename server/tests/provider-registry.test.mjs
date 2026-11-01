import test from "node:test";
import assert from "node:assert/strict";
import { getProviderCatalog, findProviderForCapability, requireProviderForCapability } from "../provider-registry.mjs";

test("provider catalog is safe by default and never exposes credentials or submits work",()=>{
 const catalog=getProviderCatalog({});
 assert.equal(catalog.summary.total,7);
 assert.equal(catalog.summary.ready,0);
 assert.equal(catalog.summary.disabled,5);
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
 assert.deepEqual(video.modelCapabilities.resolutions,["provider_default"]);
 assert.equal(video.modelCapabilities.negativePrompt,false);
 assert.equal(video.modelCapabilities.referenceImages,false);
 const configuredReference=getProviderCatalog({FAL_VIDEO_IMAGE_INPUT_FIELD:"image_url"});
 assert.equal(configuredReference.providers.find(item=>item.id==="video").modelCapabilities.referenceImages,true);
 assert.equal(JSON.stringify(unconfigured).includes("secret"),false);
});


test("AI upscaler is visible as a separate local capability and remains unavailable without a configured engine",()=>{
 const catalog=getProviderCatalog({});
 const provider=catalog.providers.find(item=>item.id==="ai-upscale");
 assert.equal(provider.status,"unavailable");
 assert.deepEqual(provider.capabilities,[]);
 assert.equal(findProviderForCapability(catalog,"media.ai-upscale"),null);
});

test("AI upscaler is advertised only when engine readiness and explicit execution opt-in are both true",()=>{
 const installed=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:false,model:"realesrgan-x4plus",reason:"Execution is disabled."}});
 const installedProvider=installed.providers.find(item=>item.id==="ai-upscale");
 assert.equal(installedProvider.status,"disabled");
 assert.deepEqual(installedProvider.capabilities,[]);
 const enabled=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:true,inferenceVerified:false,model:"realesrgan-x4plus",reason:"Self-test required."}});
 const enabledProvider=enabled.providers.find(item=>item.id==="ai-upscale");
 assert.equal(enabledProvider.status,"unverified");
 assert.deepEqual(enabledProvider.capabilities,[]);
 assert.equal(enabled.summary.unverified,1);
 assert.equal(findProviderForCapability(enabled,"media.ai-upscale"),null);
 const verified=getProviderCatalog({}, {aiUpscale:{available:true,executionEnabled:true,inferenceVerified:true,model:"realesrgan-x4plus",reason:"Inference self-test passed."}});
 const verifiedProvider=verified.providers.find(item=>item.id==="ai-upscale");
 assert.equal(verifiedProvider.status,"ready");
 assert.deepEqual(verifiedProvider.capabilities,["media.ai-upscale"]);
 assert.equal(findProviderForCapability(verified,"media.ai-upscale").provider,"local");
});
