const API_BASE="https://api.dev.runwayml.com/v1";
const API_VERSION="2024-11-06";
const MAX_OUTPUT_BYTES=250*1024*1024;
const MODEL_PROFILES=Object.freeze({
  "gen4.5":Object.freeze({label:"Runway Gen-4.5",minDurationSeconds:2,maxDurationSeconds:10,promptMaxCharacters:1000,aspectRatios:["16:9","9:16"],resolutions:["provider_default"],defaultResolution:"provider_default",nativeAudio:false}),
  "seedance2_5":Object.freeze({label:"Seedance 2.5",minDurationSeconds:4,maxDurationSeconds:30,promptMaxCharacters:1000,aspectRatios:["16:9","9:16","1:1","4:3","3:4","3:2","2:3","21:9"],resolutions:["provider_default","480p","720p","1080p"],defaultResolution:"480p",nativeAudio:true}),
  "kling_4":Object.freeze({label:"Kling 4.0",minDurationSeconds:3,maxDurationSeconds:30,promptMaxCharacters:1000,aspectRatios:["16:9","9:16","1:1","21:9"],resolutions:["provider_default","720p","1080p"],defaultResolution:"720p",nativeAudio:true}),
  "kling_4_flash":Object.freeze({label:"Kling 4.0 Flash",minDurationSeconds:3,maxDurationSeconds:20,promptMaxCharacters:26000,aspectRatios:["16:9","9:16","1:1","21:9"],resolutions:["provider_default","720p"],defaultResolution:"720p",nativeAudio:true}),
  "gemini_omni_flash_1.2":Object.freeze({label:"Gemini Omni 1.2 Flash",minDurationSeconds:3,maxDurationSeconds:15,promptMaxCharacters:4000,aspectRatios:["16:9","9:16"],resolutions:["provider_default","360p","720p","1080p","4k"],defaultResolution:"720p",nativeAudio:false}),
  "kling3.0_standard":Object.freeze({label:"Kling 3.0 Standard",minDurationSeconds:3,maxDurationSeconds:15,promptMaxCharacters:1000,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default"],defaultResolution:"provider_default",nativeAudio:true}),
  "kling3.0_pro":Object.freeze({label:"Kling 3.0 Pro",minDurationSeconds:3,maxDurationSeconds:15,promptMaxCharacters:1000,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default"],defaultResolution:"provider_default",nativeAudio:true})
});
const fail=(message,code)=>Object.assign(new Error(message),{code});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ratioFor=(model,ratio,resolution)=>{
  const maps={
    "gen4.5":{"16:9":"1280:720","9:16":"720:1280"},
    "seedance2_5":{
      "16:9":resolution==="1080p"?"1920:1080":resolution==="720p"?"1280:720":"854:480",
      "9:16":resolution==="1080p"?"1080:1920":resolution==="720p"?"720:1280":"480:854",
      "1:1":resolution==="1080p"?"1080:1080":resolution==="720p"?"720:720":"480:480",
      "4:3":resolution==="1080p"?"1440:1080":resolution==="720p"?"960:720":"640:480",
      "3:4":resolution==="1080p"?"1080:1440":resolution==="720p"?"720:960":"480:640",
      "3:2":resolution==="1080p"?"1620:1080":resolution==="720p"?"1080:720":"720:480",
      "2:3":resolution==="1080p"?"1080:1620":resolution==="720p"?"720:1080":"480:720",
      "21:9":resolution==="1080p"?"2520:1080":resolution==="720p"?"1680:720":"1120:480"
    },
    "kling_4":{
      "16:9":resolution==="1080p"?"1920:1080":"1280:720",
      "9:16":resolution==="1080p"?"1080:1920":"720:1280",
      "1:1":resolution==="1080p"?"1440:1440":"940:940",
      "21:9":resolution==="1080p"?"2200:940":"1460:624"
    },
    "kling_4_flash":{
      "16:9":"1280:720","9:16":"720:1280","1:1":"960:960","21:9":"1464:628"
    },
    "gemini_omni_flash_1.2":{
      "16:9":resolution==="4k"?"3840:2160":resolution==="1080p"?"1920:1080":resolution==="360p"?"640:360":"1280:720",
      "9:16":resolution==="4k"?"2160:3840":resolution==="1080p"?"1080:1920":resolution==="360p"?"360:640":"720:1280"
    },
    "kling3.0_standard":{"16:9":"1280:720","9:16":"720:1280","1:1":"960:960"},
    "kling3.0_pro":{"16:9":"1920:1080","9:16":"1080:1920","1:1":"1440:1440"}
  };
  return maps[model]?.[ratio]||"";
};
export function listRunwayVideoModels(){
  return Object.entries(MODEL_PROFILES).map(([id,profile])=>({
    id,label:profile.label,minDurationSeconds:profile.minDurationSeconds,
    maxDurationSeconds:profile.maxDurationSeconds,promptMaxCharacters:profile.promptMaxCharacters,
    aspectRatios:[...profile.aspectRatios],resolutions:[...profile.resolutions],
    nativeAudio:profile.nativeAudio,execution:"async",inputModes:["text-to-video","image-to-video"],
    readiness:"adapter-supported for text-to-video and first-frame image-to-video; credentials and remote opt-in required"
  }));
}
export function getRunwayVideoCapabilities(model=process.env.RUNWAY_VIDEO_MODEL||""){
  const profile=MODEL_PROFILES[String(model||"").trim()];
  if(!profile)return Object.freeze({negativePrompt:false,seed:false,startFrame:false,endFrame:false,motionReference:false,referenceImages:false,audioModes:[],aspectRatios:[],resolutions:[],minDurationSeconds:0,maxDurationSeconds:0});
  return Object.freeze({
    negativePrompt:false,seed:false,startFrame:true,endFrame:false,motionReference:false,
    // This gateway currently implements a single first-frame input, not separate reference-image collections.
    referenceImages:false,audioModes:Object.freeze(profile.nativeAudio?["generated"]:[]),
    aspectRatios:Object.freeze([...profile.aspectRatios]),
    resolutions:Object.freeze([...profile.resolutions]),
    minDurationSeconds:profile.minDurationSeconds,maxDurationSeconds:profile.maxDurationSeconds
  });
}
export function buildRunwayVideoPayload({model,prompt,durationSeconds=5,aspectRatio="16:9",resolution="provider_default"}={}){
  const id=String(model||"").trim(),profile=MODEL_PROFILES[id];
  if(!profile)throw fail("Select a Runway video model with a verified text-to-video adapter.","VIDEO_GATEWAY_UNSUPPORTED_MODEL");
  const text=typeof prompt==="string"?prompt.trim():"";
  if(!text||text.length>profile.promptMaxCharacters)throw fail("Runway text-to-video prompt exceeds the selected model's documented limit.","VIDEO_GATEWAY_INVALID_INPUT");
  if(!Number.isInteger(durationSeconds)||durationSeconds<profile.minDurationSeconds||durationSeconds>profile.maxDurationSeconds)throw fail("Duration is outside the selected model's documented range.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  if(!profile.aspectRatios.includes(aspectRatio))throw fail("Aspect ratio is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const effectiveResolution=resolution==="provider_default"?profile.defaultResolution:resolution;
  const ratio=ratioFor(id,aspectRatio,effectiveResolution);
  if(!ratio)throw fail("No verified output ratio mapping exists for this model and aspect ratio.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const payload={model:id,promptText:text,ratio,duration:durationSeconds};
  if(id==="seedance2_5"&&effectiveResolution!=="provider_default")payload.resolution=effectiveResolution;
  return Object.freeze(payload);
}
export function buildRunwayImageToVideoPayload({model,prompt,promptImage,durationSeconds=5,aspectRatio="16:9",resolution="provider_default"}={}){
 const id=String(model||"").trim(),profile=MODEL_PROFILES[id];
 if(!profile)throw fail("Select a Runway model with a verified image-to-video adapter.","VIDEO_GATEWAY_UNSUPPORTED_MODEL");
 const text=typeof prompt==="string"?prompt.trim():"";
 if(!text||text.length>profile.promptMaxCharacters)throw fail("Runway image-to-video prompt exceeds the selected model's documented limit.","VIDEO_GATEWAY_INVALID_INPUT");
 if(typeof promptImage!=="string"||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(promptImage)||Buffer.byteLength(promptImage)>5*1024*1024)throw fail("Runway first-frame images must be valid PNG, JPEG or WebP data URIs no larger than 5 MiB.","VIDEO_GATEWAY_INVALID_INPUT");
 if(!Number.isInteger(durationSeconds)||durationSeconds<profile.minDurationSeconds||durationSeconds>profile.maxDurationSeconds)throw fail("Duration is outside the selected model's documented range.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(!profile.aspectRatios.includes(aspectRatio))throw fail("Aspect ratio is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 const payload={model:id,promptText:text,promptImage,duration:durationSeconds};
 if(id==="seedance2_5"){
  const effectiveResolution=resolution==="provider_default"?profile.defaultResolution:resolution;
  if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const ratio=ratioFor(id,aspectRatio,effectiveResolution);
  if(!ratio)throw fail("No verified Seedance image-to-video ratio mapping exists.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  payload.ratio=ratio;
  if(effectiveResolution!=="provider_default")payload.resolution=effectiveResolution;
 }else if(id==="gen4.5"){
  const ratio={"16:9":"1280:720","9:16":"720:1280"}[aspectRatio];
  if(!ratio)throw fail("Gen-4.5 image-to-video ratio is unsupported.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  payload.ratio=ratio;
 }else if(id==="gemini_omni_flash_1.2"){
  const effectiveResolution=resolution==="provider_default"?profile.defaultResolution:resolution;
  if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by Gemini Omni 1.2 Flash.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const ratio=ratioFor(id,aspectRatio,effectiveResolution);
  if(!ratio)throw fail("Gemini Omni 1.2 Flash image-to-video ratio is unsupported.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  payload.ratio=ratio;
 }
 // Kling models follow the supplied first frame's framing; omit ratio.
 return Object.freeze(payload);
}
async function requestJson(url,{method="GET",headers={},body,timeoutMs=30000,fetchImpl=fetch}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    let response;
    try{response=await fetchImpl(url,{method,headers,body,signal:controller.signal,redirect:"error"});}
    catch(error){throw fail(error?.name==="AbortError"?"Runway API request timed out.":"Runway API could not be reached.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE");}
    const raw=await response.text();
    if(Buffer.byteLength(raw)>2*1024*1024)throw fail("Runway API returned an oversized response.","VIDEO_GATEWAY_INVALID_RESPONSE");
    let data={};try{data=raw?JSON.parse(raw):{};}catch{throw fail("Runway API returned invalid JSON.","VIDEO_GATEWAY_INVALID_RESPONSE");}
    if(response.status===429)throw fail("Runway API rate limit reached.","VIDEO_GATEWAY_RATE_LIMITED");
    if(response.status>=500)throw fail("Runway API returned a temporary server error.","VIDEO_GATEWAY_SERVER_ERROR");
    if(!response.ok)throw fail("Runway API rejected the request ("+response.status+").","VIDEO_GATEWAY_REQUEST_REJECTED");
    return data;
  }finally{clearTimeout(timer);}
}
function safeOutputUrl(raw){
  let url;try{url=new URL(raw);}catch{throw fail("Runway task returned an invalid output URL.","VIDEO_GATEWAY_INVALID_RESPONSE");}
  if(url.protocol!=="https:"||!url.hostname.endsWith(".cloudfront.net")||url.username||url.password||url.port||url.hash)throw fail("Runway task returned an untrusted output host.","VIDEO_GATEWAY_INVALID_RESPONSE");
  return url;
}
async function downloadMp4(raw,{fetchImpl=fetch,timeoutMs=60000}={}){
  const url=safeOutputUrl(raw),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    let response;try{response=await fetchImpl(url,{signal:controller.signal,redirect:"error"});}catch(error){throw fail(error?.name==="AbortError"?"Runway output download timed out.":"Runway output could not be downloaded safely.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE");}
    if(!response.ok)throw fail("Runway output download failed.","VIDEO_GATEWAY_INVALID_RESPONSE");
    if(Number(response.headers.get("content-length")||0)>MAX_OUTPUT_BYTES)throw fail("Generated video exceeds the 250 MiB limit.","VIDEO_GATEWAY_INVALID_RESPONSE");
    if(!response.body?.getReader)throw fail("Runway output cannot be streamed safely.","VIDEO_GATEWAY_INVALID_RESPONSE");
    const reader=response.body.getReader(),chunks=[];let total=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_OUTPUT_BYTES){await reader.cancel().catch(()=>{});throw fail("Generated video exceeds the 250 MiB limit.","VIDEO_GATEWAY_INVALID_RESPONSE");}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    const buffer=Buffer.concat(chunks,total);
    if(buffer.length<12||buffer.toString("ascii",4,8)!=="ftyp")throw fail("Runway output is not a supported MP4 file.","VIDEO_GATEWAY_INVALID_RESPONSE");
    return buffer;
  }finally{clearTimeout(timer);}
}
export async function generateRunwayVideo({model=process.env.RUNWAY_VIDEO_MODEL,prompt,durationSeconds=5,aspectRatio="16:9",resolution="provider_default",referenceImageDataUrl="",fetchImpl=fetch,sleepImpl=sleep,now=Date.now}={}){
  if(process.env.VIDEO_GATEWAY_ENABLED!=="true")throw fail("Video generation is disabled by server configuration.","VIDEO_GATEWAY_DISABLED");
  if(process.env.VIDEO_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote video providers are disabled. Review Runway pricing and explicitly enable remote access on the server.","VIDEO_GATEWAY_REMOTE_DISABLED");
  const key=String(process.env.RUNWAY_API_KEY||process.env.RUNWAYML_API_SECRET||"").trim();
  if(!key)throw fail("Configure RUNWAYML_API_SECRET on the server before using Runway models.","VIDEO_GATEWAY_CONFIG_INVALID");
  const payload=referenceImageDataUrl
   ?buildRunwayImageToVideoPayload({model,prompt,promptImage:referenceImageDataUrl,durationSeconds,aspectRatio,resolution})
   :buildRunwayVideoPayload({model,prompt,durationSeconds,aspectRatio,resolution});
  const headers={authorization:"Bearer "+key,"content-type":"application/json","X-Runway-Version":API_VERSION};
  const submitted=await requestJson(API_BASE+(referenceImageDataUrl?"/image_to_video":"/text_to_video"),{method:"POST",headers,body:JSON.stringify(payload),timeoutMs:30000,fetchImpl});
  const taskId=String(submitted.id||"");
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId))throw fail("Runway did not return a valid task identifier.","VIDEO_GATEWAY_INVALID_RESPONSE");
  const timeoutMs=Math.max(10000,Math.min(600000,Number(process.env.VIDEO_GATEWAY_TIMEOUT_MS)||300000));
  const deadline=now()+timeoutMs;let task;
  while(now()<deadline){
    task=await requestJson(API_BASE+"/tasks/"+encodeURIComponent(taskId),{headers,timeoutMs:15000,fetchImpl});
    if(task.status==="SUCCEEDED")break;
    if(["FAILED","CANCELED","CANCELLED"].includes(task.status))throw fail("Runway generation failed. Review the provider task details before retrying.","VIDEO_GATEWAY_JOB_FAILED");
    if(!["PENDING","RUNNING","THROTTLED"].includes(task.status))throw fail("Runway returned an unknown task state.","VIDEO_GATEWAY_INVALID_RESPONSE");
    await sleepImpl(Math.min(5000,Math.max(0,deadline-now())));
  }
  if(task?.status!=="SUCCEEDED")throw fail("Runway generation timed out before completion.","VIDEO_GATEWAY_TIMEOUT");
  const output=Array.isArray(task.output)?task.output.find(item=>typeof item==="string"&&item.length>0):"";
  if(!output)throw fail("Runway task succeeded without an output video URL.","VIDEO_GATEWAY_INVALID_RESPONSE");
  const buffer=await downloadMp4(output,{fetchImpl,timeoutMs:Math.min(60000,Math.max(1000,deadline-now()))});
  return {buffer,model:String(task.model||model),provider:"runway",requestId:taskId,usage:null,estimatedCostCredits:Number(submitted.estimatedCost?.credits)||null,mimeType:"video/mp4",adapterVersion:"runway-video-gateway-v1"};
}
