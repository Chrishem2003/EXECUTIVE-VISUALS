const LOOPBACKS=new Set(["localhost","127.0.0.1","::1","[::1]"]);
function gatewayState({enabled,configured,url,allowRemote,model,provider,capabilities,reasonIfMissing="Set the server-side endpoint and model."}){
 let local=false,validUrl=false;
 if(url){try{const parsed=new URL(url);local=LOOPBACKS.has(parsed.hostname.toLowerCase());validUrl=!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&(parsed.protocol==="https:"||local);}catch{}}
 let status="disabled",reason="Execution is disabled by server configuration.";
 if(enabled){
  if(!configured||!validUrl) {status="needs_configuration";reason=reasonIfMissing;}
  else if(!local&&!allowRemote){status="remote_opt_in_required";reason="Remote execution requires explicit server-side opt-in after reviewing provider pricing and data handling.";}
  else {status="ready";reason="Configured and enabled. No request has been submitted.";}
 }
 return {id:provider,provider,enabled:Boolean(enabled),configured:Boolean(configured&&validUrl),remote:validUrl&&!local,model:model||null,status,reason,capabilities};
}
export function getProviderCatalog(env=process.env,media={ffmpeg:false,ffprobe:false}){
 const text=gatewayState({enabled:env.AI_GATEWAY_ENABLED==="true",configured:Boolean(env.AI_GATEWAY_URL&&env.AI_GATEWAY_MODEL),url:env.AI_GATEWAY_URL,allowRemote:env.AI_GATEWAY_ALLOW_REMOTE==="true",model:env.AI_GATEWAY_MODEL,provider:"text",capabilities:["text.generate","text.rewrite","text.translate","text.summarize"]});
 const imageProvider=String(env.IMAGE_GATEWAY_PROVIDER||"openai-compatible").toLowerCase();
 const imageFal=imageProvider==="fal";
 const image=gatewayState({enabled:env.IMAGE_GATEWAY_ENABLED==="true",configured:imageFal?Boolean(env.FAL_KEY&&env.FAL_IMAGE_MODEL):Boolean(env.IMAGE_GATEWAY_URL&&env.IMAGE_GATEWAY_MODEL),url:imageFal?"https://queue.fal.run":env.IMAGE_GATEWAY_URL,allowRemote:imageFal?env.IMAGE_GATEWAY_ALLOW_REMOTE==="true":env.IMAGE_GATEWAY_ALLOW_REMOTE==="true",model:imageFal?env.FAL_IMAGE_MODEL:env.IMAGE_GATEWAY_MODEL,provider:"image",capabilities:["image.generate","image.variation","image.reference"]});
 const video=gatewayState({enabled:env.VIDEO_GATEWAY_ENABLED==="true",configured:Boolean(env.FAL_KEY&&env.FAL_VIDEO_MODEL),url:"https://queue.fal.run",allowRemote:env.VIDEO_GATEWAY_ALLOW_REMOTE==="true",model:env.FAL_VIDEO_MODEL,provider:"video",capabilities:["video.generate","video.image_to_video"]});
 const voice=gatewayState({enabled:env.VOICE_GATEWAY_ENABLED==="true",configured:Boolean(env.VOICE_GATEWAY_URL&&env.VOICE_GATEWAY_MODEL),url:env.VOICE_GATEWAY_URL,allowRemote:env.VOICE_GATEWAY_ALLOW_REMOTE==="true",model:env.VOICE_GATEWAY_MODEL,provider:"voice",capabilities:["voice.generate"]});
 const transcription=gatewayState({enabled:env.VOICE_GATEWAY_ENABLED==="true"&&env.VOICE_TRANSCRIPTION_ENABLED==="true",configured:Boolean(env.VOICE_GATEWAY_URL&&(env.VOICE_TRANSCRIPTION_MODEL||env.VOICE_GATEWAY_MODEL)),url:env.VOICE_GATEWAY_URL,allowRemote:env.VOICE_GATEWAY_ALLOW_REMOTE==="true",model:env.VOICE_TRANSCRIPTION_MODEL||env.VOICE_GATEWAY_MODEL,provider:"transcription",capabilities:["voice.transcribe"]});
 const localMedia={id:"local-media",provider:"local",enabled:Boolean(media.ffmpeg&&media.ffprobe),configured:Boolean(media.ffmpeg&&media.ffprobe),remote:false,model:"FFmpeg / FFprobe",status:media.ffmpeg&&media.ffprobe?"ready":"unavailable",reason:media.ffmpeg&&media.ffprobe?"Local media tools are available.":"Install FFmpeg and FFprobe on the worker host.",capabilities:["media.probe","media.thumbnail","media.transcode","media.audio_extract","media.enhance","timeline.render"]};
 const providers=[text,image,video,voice,transcription,localMedia];
 const counts=providers.reduce((out,item)=>{out[item.status]=(out[item.status]||0)+1;return out;},{});
 return {version:1,providers,summary:{total:providers.length,ready:providers.filter(x=>x.status==="ready").length,disabled:counts.disabled||0,needsConfiguration:counts.needs_configuration||0,remoteOptInRequired:counts.remote_opt_in_required||0,unavailable:counts.unavailable||0},policy:{remoteCallsRequireExplicitOptIn:true,credentialsExposed:false,pricesEstimated:false,requestsSubmitted:false}};
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
