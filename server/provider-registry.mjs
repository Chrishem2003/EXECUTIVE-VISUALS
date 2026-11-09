import { getFalVideoCapabilities } from "./fal-video-gateway.mjs";
import { getRunwayVideoCapabilities, listRunwayVideoModels } from "./runway-video-gateway.mjs";
import { listGeminiImageModels } from "./gemini-image-gateway.mjs";
import { parseVideoPricingCatalog } from "./video-cost-estimator.mjs";
const LOOPBACKS=new Set(["localhost","127.0.0.1","::1","[::1]"]);
function gatewayState({enabled,configured,url,allowRemote,model,provider,capabilities,id=provider,reasonIfMissing="Set the server-side endpoint and model."}){
 let local=false,validUrl=false;
 if(url){try{const parsed=new URL(url);local=LOOPBACKS.has(parsed.hostname.toLowerCase());validUrl=!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&(parsed.protocol==="https:"||local);}catch{}}
 let status="disabled",reason="Execution is disabled by server configuration.";
 if(enabled){
  if(!configured||!validUrl) {status="needs_configuration";reason=reasonIfMissing;}
  else if(!local&&!allowRemote){status="remote_opt_in_required";reason="Remote execution requires explicit server-side opt-in after reviewing provider pricing and data handling.";}
  else {status="ready";reason="Configured and enabled. No request has been submitted.";}
 }
 return {id,provider,enabled:Boolean(enabled),configured:Boolean(configured&&validUrl),remote:validUrl&&!local,model:model||null,status,reason,capabilities};
}
export function getProviderCatalog(env=process.env,media={ffmpeg:false,ffprobe:false,aiUpscale:null}){
 const text=gatewayState({enabled:env.AI_GATEWAY_ENABLED==="true",configured:Boolean(env.AI_GATEWAY_URL&&env.AI_GATEWAY_MODEL),url:env.AI_GATEWAY_URL,allowRemote:env.AI_GATEWAY_ALLOW_REMOTE==="true",model:env.AI_GATEWAY_MODEL,provider:"text",capabilities:["text.generate","text.rewrite","text.translate","text.summarize"]});
 const imageProvider=String(env.IMAGE_GATEWAY_PROVIDER||"openai-compatible").toLowerCase();
 const imageFal=imageProvider==="fal",imageGemini=imageProvider==="gemini";
 const image=gatewayState({enabled:env.IMAGE_GATEWAY_ENABLED==="true",configured:imageGemini?Boolean(env.GEMINI_API_KEY&&env.GEMINI_IMAGE_MODEL):imageFal?Boolean(env.FAL_KEY&&env.FAL_IMAGE_MODEL):Boolean(env.IMAGE_GATEWAY_URL&&env.IMAGE_GATEWAY_MODEL),url:imageGemini?"https://generativelanguage.googleapis.com":imageFal?"https://queue.fal.run":env.IMAGE_GATEWAY_URL,id:"image",allowRemote:env.IMAGE_GATEWAY_ALLOW_REMOTE==="true",model:imageGemini?env.GEMINI_IMAGE_MODEL:imageFal?env.FAL_IMAGE_MODEL:env.IMAGE_GATEWAY_MODEL,provider:imageGemini?"gemini":"image",capabilities:["image.generate"],reasonIfMissing:imageGemini?"Set GEMINI_API_KEY and GEMINI_IMAGE_MODEL on the server.":imageFal?"Set FAL_KEY and FAL_IMAGE_MODEL on the server.":"Set the server-side image gateway URL and model."});
 if(!imageFal&&!imageGemini&&imageProvider!=="openai-compatible"){image.status="needs_configuration";image.configured=false;image.reason="Choose a supported server-side image provider before enabling image generation.";}
 image.availableModels=imageGemini?listGeminiImageModels():[];
 const videoProvider=String(env.VIDEO_GATEWAY_PROVIDER||"fal").toLowerCase();
 const video=videoProvider==="runway"
  ?gatewayState({enabled:env.VIDEO_GATEWAY_ENABLED==="true",configured:Boolean(env.RUNWAYML_API_SECRET&&env.RUNWAY_VIDEO_MODEL),url:"https://api.dev.runwayml.com",id:"video",allowRemote:env.VIDEO_GATEWAY_ALLOW_REMOTE==="true",model:env.RUNWAY_VIDEO_MODEL,provider:"runway",capabilities:["video.generate"],reasonIfMissing:"Set RUNWAYML_API_SECRET and RUNWAY_VIDEO_MODEL on the server."})
  :gatewayState({enabled:env.VIDEO_GATEWAY_ENABLED==="true",configured:Boolean(env.FAL_KEY&&env.FAL_VIDEO_MODEL),url:"https://queue.fal.run",id:"video",allowRemote:env.VIDEO_GATEWAY_ALLOW_REMOTE==="true",model:env.FAL_VIDEO_MODEL,provider:"fal",capabilities:["video.generate"],reasonIfMissing:"Set FAL_KEY and FAL_VIDEO_MODEL on the server."});
 if(videoProvider!=="runway"&&videoProvider!=="fal"){video.status="needs_configuration";video.configured=false;video.reason="VIDEO_GATEWAY_PROVIDER must be runway or fal.";}
 video.modelCapabilities=videoProvider==="runway"?getRunwayVideoCapabilities(env.RUNWAY_VIDEO_MODEL||""):getFalVideoCapabilities({imageInputField:env.FAL_VIDEO_IMAGE_INPUT_FIELD||""});
 video.availableModels=videoProvider==="runway"?listRunwayVideoModels():[];
 const voice=gatewayState({enabled:env.VOICE_GATEWAY_ENABLED==="true",configured:Boolean(env.VOICE_GATEWAY_URL&&env.VOICE_GATEWAY_MODEL),url:env.VOICE_GATEWAY_URL,allowRemote:env.VOICE_GATEWAY_ALLOW_REMOTE==="true",model:env.VOICE_GATEWAY_MODEL,provider:"voice",capabilities:["voice.generate"]});
 const transcription=gatewayState({enabled:env.VOICE_GATEWAY_ENABLED==="true"&&env.VOICE_TRANSCRIPTION_ENABLED==="true",configured:Boolean(env.VOICE_GATEWAY_URL&&(env.VOICE_TRANSCRIPTION_MODEL||env.VOICE_GATEWAY_MODEL)),url:env.VOICE_GATEWAY_URL,allowRemote:env.VOICE_GATEWAY_ALLOW_REMOTE==="true",model:env.VOICE_TRANSCRIPTION_MODEL||env.VOICE_GATEWAY_MODEL,provider:"transcription",capabilities:["voice.transcribe"]});
 const localMedia={id:"local-media",provider:"local",enabled:Boolean(media.ffmpeg&&media.ffprobe),configured:Boolean(media.ffmpeg&&media.ffprobe),remote:false,model:"FFmpeg / FFprobe",status:media.ffmpeg&&media.ffprobe?"ready":"unavailable",reason:media.ffmpeg&&media.ffprobe?"Local media tools are available.":"Install FFmpeg and FFprobe on the worker host.",capabilities:["media.probe","media.thumbnail","media.transcode","media.proxy","media.audio_extract","media.audio-clean","media.denoise","media.color","media.resize","media.interpolate","media.upscale","timeline.render"]};
 const ai=media.aiUpscale||{available:false,executionEnabled:false,reason:"Configure an NCNN/Vulkan engine and allowlisted model files."};
 // Process success and image-header checks do not prove neural inference or perceptual quality.
 const executionVerified=Boolean(ai.executionVerified);
 const qualityEvidence=ai.qualityEvidence&&typeof ai.qualityEvidence==="object"?ai.qualityEvidence:null;
 const selectedModel=ai.model||"realesrgan-x4plus";
 const qualityVerified=Boolean(ai.qualityVerified&&typeof qualityEvidence?.fixtureId==="string"&&qualityEvidence.fixtureId.trim()&&typeof qualityEvidence?.checkedAt==="string"&&Number.isFinite(Date.parse(qualityEvidence.checkedAt))&&qualityEvidence?.model===selectedModel);
 const availableModels=(Array.isArray(ai.models)?ai.models:[]).map(model=>{
  const modelQualityEvidence=model.qualityEvidence&&typeof model.qualityEvidence==="object"?model.qualityEvidence:null;
  const modelQualityVerified=Boolean(model.qualityVerified&&typeof modelQualityEvidence?.fixtureId==="string"&&modelQualityEvidence.fixtureId.trim()&&typeof modelQualityEvidence?.checkedAt==="string"&&Number.isFinite(Date.parse(modelQualityEvidence.checkedAt))&&modelQualityEvidence?.model===model.model);
  const readiness=!model.available?"unavailable":!model.executionEnabled?"disabled":!model.executionVerified?"unverified":modelQualityVerified?"ready":"quality_review_required";
  const reason=!model.available?model.reason||"Install the selected model weights.":!model.executionEnabled?model.reason||"Enable AI upscaling on this worker.":!model.executionVerified?model.reason||"Run the model-specific execution self-test.":modelQualityVerified?"Model-specific visual quality evidence is recorded.":model.qualityReason||modelQualityEvidence?.reason||"Model-specific human quality review is required.";
  return {id:model.model,label:model.model==="realesrgan-x4plus-anime"?"Real-ESRGAN Anime":"Real-ESRGAN General",readiness,available:Boolean(model.available),executionVerified:Boolean(model.executionVerified),qualityVerified:modelQualityVerified,reason};
 });
 const aiUpscale={id:"ai-upscale",provider:"local",enabled:Boolean(ai.executionEnabled),configured:Boolean(ai.available),remote:false,model:selectedModel,executionVerified,qualityVerified,availableModels,status:!ai.available?"unavailable":!ai.executionEnabled?"disabled":!executionVerified?"unverified":qualityVerified?"ready":"unverified",reason:!ai.available?"Configure the engine executable and allowlisted model files.":!ai.executionEnabled?"AI upscaling is not enabled.":!executionVerified?"Run the selected model-specific execution self-test on this worker.":qualityVerified?"Independent model-specific fixture quality evidence is recorded.":"Execution checks passed; model-specific neural quality remains unverified.",capabilities:ai.available&&ai.executionEnabled&&executionVerified&&qualityVerified?["media.ai-upscale"]:[]};
 const pricingCatalog=parseVideoPricingCatalog(env.VIDEO_MODEL_PRICING_JSON||"");
 video.pricing={configured:pricingCatalog.configured,models:pricingCatalog.records.map(record=>({provider:record.provider,model:record.model,currency:record.currency,sourceUrl:record.sourceUrl,observedAt:record.observedAt,expiresAt:record.expiresAt})),rejectedCount:pricingCatalog.rejectedCount};
 const providers=[text,image,video,voice,transcription,localMedia,aiUpscale];
 const counts=providers.reduce((out,item)=>{out[item.status]=(out[item.status]||0)+1;return out;},{});
 return {version:1,providers,summary:{total:providers.length,ready:providers.filter(x=>x.status==="ready").length,disabled:counts.disabled||0,unverified:counts.unverified||0,needsConfiguration:counts.needs_configuration||0,remoteOptInRequired:counts.remote_opt_in_required||0,unavailable:counts.unavailable||0},policy:{remoteCallsRequireExplicitOptIn:true,credentialsExposed:false,pricesEstimated:false,pricingSchedulesConfigured:pricingCatalog.configured,requestsSubmitted:false}};
}
export function findProviderForCapability(catalog,capability,{allowRemote=false}={}){
 const match=catalog.providers.find(provider=>provider.capabilities.includes(capability)&&provider.status==="ready"&&(!provider.remote||allowRemote));
 return match?{provider:match.provider,model:match.model,remote:match.remote}:null;
}

export function requireProviderForCapability(catalog,capability,{allowRemote=false}={}){
 const selected=findProviderForCapability(catalog,capability,{allowRemote});
 if(selected)return selected;
 const provider=catalog.providers.find(item=>item.capabilities.includes(capability));
 throw Object.assign(new Error(provider?.reason||"No configured provider is ready for this capability."),{
  code:"PROVIDER_NOT_READY",capability,providerStatus:provider?.status||"unavailable"
 });
}
