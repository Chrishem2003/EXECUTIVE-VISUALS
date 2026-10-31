import test from "node:test";
import assert from "node:assert/strict";
import { getProviderCatalog, findProviderForCapability } from "../provider-registry.mjs";

test("provider catalog is safe by default and never exposes credentials or submits work",()=>{
 const catalog=getProviderCatalog({});
 assert.equal(catalog.summary.total,6);
 assert.equal(catalog.summary.ready,0);
 assert.equal(catalog.summary.disabled,5);
 assert.equal(catalog.providers.find(x=>x.id==="local-media").status,"unavailable");
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
