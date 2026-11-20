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
 const runwayAllowlist=String(env.RUNWAY_VIDEO_MODELS||env.RUNWAY_VIDEO_MODEL||"").split(",").map(value=>value.trim()).filter(Boolean);
 const runwayApiKeyConfigured=Boolean(env.RUNWAY_API_KEY||env.RUNWAYML_API_SECRET);
 const runwayPrimaryModel=String(env.RUNWAY_VIDEO_MODEL||runwayAllowlist[0]||"").trim();
 const runwayRouterRequested=env.RUNWAY_MODEL_ROUTER_ENABLED==="true";
 const runwayRouterConfig=String(env.RUNWAY_VIDEO_ROUTER_CONFIG||"").trim();
 const runwayRouterConfigValid=/^[a-z][a-z0-9_-]{0,63}$/.test(runwayRouterConfig);
 const runwayRouterConfigured=runwayRouterRequested&&runwayRouterConfigValid&&runwayApiKeyConfigured;
 const runwayRouterMisconfigured=runwayRouterRequested&&!runwayRouterConfigured;
 const runwayDirectConfigured=runwayApiKeyConfigured&&runwayAllowlist.length>0;
 const runwayConfigured=!runwayRouterMisconfigured&&(runwayDirectConfigured||runwayRouterConfigured);
 const runwaySelectedModel=runwayRouterConfigured?"model-router":runwayPrimaryModel;
 const runwayRouterCapabilities={
  // Keep the catalogue conservative: only advertise capabilities documented
  // by the routed-video contract. The selected model can vary per request.
  textToVideo:true,imageToVideo:true,videoToVideo:false,videoEdit:false,videoExtend:false,videoReframe:false,
  nativeAudio:false,negativePrompt:true,seed:false,startFrame:false,endFrame:false,motionReference:false,
  referenceImages:true,referenceVideos:false,referenceAudio:false,maxReferenceImages:4,
  audioModes:["none"],aspectRatios:["16:9","9:16","1:1","4:3","3:4","21:9"],
  resolutions:["provider_default"],minDurationSeconds:2,maxDurationSeconds:30
 };
 const video=videoProvider==="runway"
  ?gatewayState({
    enabled:env.VIDEO_GATEWAY_ENABLED==="true",
    configured:runwayConfigured,
    id:"video",
    url:"https://api.dev.runwayml.com",
    id:"video",
    allowRemote:env.VIDEO_GATEWAY_ALLOW_REMOTE==="true"&&env.RUNWAY_VIDEO_ALLOW_REMOTE==="true",
    model:runwaySelectedModel,
    provider:"runway",
    capabilities:["video.generate"],
    reasonIfMissing:runwayRouterRequested
      ?"Set RUNWAY_API_KEY (or RUNWAYML_API_SECRET) and a valid RUNWAY_VIDEO_ROUTER_CONFIG for the enabled Model Router."
      :"Set RUNWAY_API_KEY (or RUNWAYML_API_SECRET) and RUNWAY_VIDEO_MODEL or RUNWAY_VIDEO_MODELS on the server."
  })
  :gatewayState({enabled:env.VIDEO_GATEWAY_ENABLED==="true",configured:Boolean(env.FAL_KEY&&env.FAL_VIDEO_MODEL),id:"video",url:"https://queue.fal.run",id:"video",allowRemote:env.VIDEO_GATEWAY_ALLOW_REMOTE==="true",model:env.FAL_VIDEO_MODEL,provider:"fal",capabilities:["video.generate"],reasonIfMissing:"Set FAL_KEY and FAL_VIDEO_MODEL on the server."});
 if(videoProvider!=="runway"&&videoProvider!=="fal"){video.status="needs_configuration";video.configured=false;video.reason="VIDEO_GATEWAY_PROVIDER must be runway or fal.";}
 if(videoProvider==="runway"&&video.status==="ready"&&
    (env.CLOUD_WORKER_ENABLED!=="true"||env.CLOUD_VIDEO_WORKER_ENABLED!=="true")){
  video.status="needs_configuration";
  video.reason="Enable CLOUD_WORKER_ENABLED and CLOUD_VIDEO_WORKER_ENABLED before Runway models can be selected by the durable worker.";
 }
 video.modelCapabilities=videoProvider==="runway"
  ?(runwaySelectedModel==="model-router"?runwayRouterCapabilities:getRunwayVideoCapabilities(runwaySelectedModel))
  :getFalVideoCapabilities({imageInputField:env.FAL_VIDEO_IMAGE_INPUT_FIELD||""});
 video.availableModels=videoProvider==="runway"
  ?[
    ...listRunwayVideoModels().map(model=>{
      const allowlisted=runwayAllowlist.includes(model.id);
      const ready=video.status==="ready"&&!runwayRouterConfigured&&allowlisted;
      return {...model,available:ready,executionVerified:ready,readiness:ready?"ready":runwayRouterConfigured?"router_active":allowlisted?video.status:"not_configured",
        reason:ready?"Exact model profile is allowlisted and the server-side gateway is ready.":runwayRouterConfigured?"The configured Runway Model Router takes precedence over direct-model selection.":allowlisted?video.reason:"Add this exact model ID to RUNWAY_VIDEO_MODELS before it can be selected."};
    }),
    ...(runwayRouterRequested?[{
      id:"model-router",name:"Runway Model Router",label:"Runway Model Router",
      ...runwayRouterCapabilities,
      available:video.status==="ready"&&runwayRouterConfigured,
      executionVerified:video.status==="ready"&&runwayRouterConfigured,
      readiness:runwayRouterConfigured?video.status:"needs_configuration",
      capabilities:runwayRouterCapabilities,
      reason:runwayRouterConfigured?video.reason:
        "Enable RUNWAY_MODEL_ROUTER_ENABLED and configure a valid saved router slug plus RUNWAY_API_KEY."
    }]:[])
  ]
  :[];
 const lumaRate=String(env.LUMA_USD_PER_CREDIT||"").trim();
 const lumaRateValid=/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(lumaRate)&&Number(lumaRate)>0&&Number(lumaRate)<=1000;
 const lumaSchemaReady=env.LUMA_PROVIDER_FILES_SCHEMA_READY==="true";
 const lumaStorageReady=String(env.CLOUD_MEDIA_STORAGE_PROVIDER||"supabase").toLowerCase()!=="r2"||
  Boolean(env.R2_ACCOUNT_ID&&env.R2_ACCESS_KEY_ID&&env.R2_SECRET_ACCESS_KEY);
 const luma=gatewayState({
  enabled:env.LUMA_VIDEO_ENABLED==="true",
  configured:Boolean(env.LUMA_AGENTS_API_KEY&&lumaRateValid&&lumaSchemaReady&&lumaStorageReady&&env.SUPABASE_URL&&env.SUPABASE_SERVICE_ROLE_KEY&&String(env.CLOUD_VIDEO_OUTPUT_HOSTS||"").trim()),
  url:"https://agents.lumalabs.ai",
  allowRemote:env.LUMA_VIDEO_ALLOW_REMOTE==="true"&&env.VIDEO_GATEWAY_ENABLED==="true"&&env.VIDEO_GATEWAY_ALLOW_REMOTE==="true"&&env.CLOUD_WORKER_ENABLED==="true"&&env.CLOUD_VIDEO_WORKER_ENABLED==="true",
  model:"ray-3.2",provider:"luma",id:"video-luma",
  capabilities:["video.generate","video.image_to_video","video.video_to_video","video.reframe","video.extend"],
  reasonIfMissing:"Set LUMA_AGENTS_API_KEY and LUMA_USD_PER_CREDIT, configure private Supabase storage and output hosts, apply the Luma provider-file migration and set LUMA_PROVIDER_FILES_SCHEMA_READY=true."
 });
 if(!lumaSchemaReady&&env.LUMA_VIDEO_ENABLED==="true"){
  luma.status="needs_configuration";luma.configured=false;luma.reason="Apply the Luma private provider-file migration to the target database before enabling Luma source-media workflows.";
 }
 luma.modelCapabilities={
  minDurationSeconds:5,maxDurationSeconds:10,
  aspectRatios:["16:9","9:16","1:1","4:3","3:4","21:9"],
  resolutions:["360p","540p","720p","1080p"],referenceImages:true,maxReferenceImages:1,
  audioModes:["none"],durationsSeconds:[5,10],operations:["generate","edit","reframe","extend"]
 };
 luma.availableModels=[{
  id:"ray-3.2",label:"Luma Ray 3.2",readiness:luma.status==="ready"?"ready":luma.status,
  available:luma.status==="ready",executionVerified:luma.status==="ready",
  minDurationSeconds:5,maxDurationSeconds:10,
  aspectRatios:[...luma.modelCapabilities.aspectRatios],resolutions:[...luma.modelCapabilities.resolutions],
  referenceImages:true,maxReferenceImages:1,audioModes:["none"],durationsSeconds:[5,10],operations:[...luma.modelCapabilities.operations],reason:luma.reason
 }];
 const voice=gatewayState({enabled:env.VOICE_GATEWAY_ENABLED==="true",configured:Boolean(env.VOICE_GATEWAY_URL&&env.VOICE_GATEWAY_MODEL),url:env.VOICE_GATEWAY_URL,allowRemote:env.VOICE_GATEWAY_ALLOW_REMOTE==="true",model:env.VOICE_GATEWAY_MODEL,provider:"voice",capabilities:["voice.generate"]});
 const transcription=gatewayState({enabled:env.VOICE_GATEWAY_ENABLED==="true"&&env.VOICE_TRANSCRIPTION_ENABLED==="true",configured:Boolean(env.VOICE_GATEWAY_URL&&(env.VOICE_TRANSCRIPTION_MODEL||env.VOICE_GATEWAY_MODEL)),url:env.VOICE_GATEWAY_URL,allowRemote:env.VOICE_GATEWAY_ALLOW_REMOTE==="true",model:env.VOICE_TRANSCRIPTION_MODEL||env.VOICE_GATEWAY_MODEL,provider:"transcription",capabilities:["voice.transcribe"]});
 const runwayAudio=gatewayState({enabled:env.RUNWAY_AUDIO_ENABLED==="true",configured:Boolean(env.RUNWAYML_API_SECRET),url:"https://api.dev.runwayml.com",allowRemote:env.RUNWAY_AUDIO_ALLOW_REMOTE==="true",model:"eleven_voice_isolation / eleven_voice_dubbing",provider:"runway",id:"runway-audio",capabilities:["voice.isolate","voice.dub"],reasonIfMissing:"Set RUNWAYML_API_SECRET and explicitly enable RUNWAY_AUDIO_ENABLED after reviewing Runway audio pricing and data handling."});
 const localMedia={id:"local-media",provider:"local",enabled:Boolean(media.ffmpeg&&media.ffprobe),configured:Boolean(media.ffmpeg&&media.ffprobe),remote:false,model:"FFmpeg / FFprobe",status:media.ffmpeg&&media.ffprobe?"ready":"unavailable",reason:media.ffmpeg&&media.ffprobe?"Local media tools are available.":"Install FFmpeg and FFprobe on the worker host.",capabilities:["media.probe","media.thumbnail","media.transcode","media.proxy","media.audio_extract","media.audio-clean","media.audio-master","media.audio_replace","media.denoise","media.color","media.resize","media.interpolate","media.upscale","timeline.render"]};
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
 const providers=[text,image,video,luma,voice,transcription,runwayAudio,localMedia,aiUpscale];
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
