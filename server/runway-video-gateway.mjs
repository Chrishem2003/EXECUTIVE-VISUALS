const API_BASE="https://api.dev.runwayml.com/v1";
const API_VERSION="2024-11-06";
const MAX_OUTPUT_BYTES=250*1024*1024;
const MODEL_PROFILES=Object.freeze({
  "gen4.5":Object.freeze({label:"Runway Gen-4.5",minDurationSeconds:2,maxDurationSeconds:10,aspectRatios:["16:9","9:16"],resolutions:["provider_default"],defaultResolution:"provider_default"}),
  "gemini_omni_flash_1.2":Object.freeze({label:"Gemini Omni Flash 1.2",minDurationSeconds:3,maxDurationSeconds:15,aspectRatios:["16:9","9:16"],resolutions:["provider_default","360p","720p","1080p","4k"],defaultResolution:"720p"}),
  "seedance2_5":Object.freeze({label:"Seedance 2.5",minDurationSeconds:4,maxDurationSeconds:30,aspectRatios:["21:9","16:9","4:3","1:1","3:4","9:16"],resolutions:["provider_default","480p","720p","1080p","4k"],defaultResolution:"720p"}),
  "kling_4":Object.freeze({label:"Kling 4.0",minDurationSeconds:3,maxDurationSeconds:30,aspectRatios:["16:9","9:16","1:1","21:9"],resolutions:["provider_default","720p","1080p"],defaultResolution:"720p"}),
  "kling_4_flash":Object.freeze({label:"Kling 4.0 Flash",minDurationSeconds:3,maxDurationSeconds:20,aspectRatios:["16:9","9:16","1:1","21:9"],resolutions:["provider_default","720p"],defaultResolution:"720p"}),
  "kling3.0_standard":Object.freeze({label:"Kling 3.0 Standard",minDurationSeconds:3,maxDurationSeconds:15,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default"],defaultResolution:"provider_default"}),
  "kling3.0_pro":Object.freeze({label:"Kling 3.0 Pro",minDurationSeconds:3,maxDurationSeconds:15,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default"],defaultResolution:"provider_default"}),
  "kling3.0_4k":Object.freeze({label:"Kling 3.0 4K",minDurationSeconds:3,maxDurationSeconds:15,aspectRatios:["16:9","9:16","1:1"],resolutions:["provider_default"],defaultResolution:"provider_default"})
});
const fail=(message,code)=>Object.assign(new Error(message),{code});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ratioFor=(model,ratio,resolution)=>{
  const maps={
    "gen4.5":{"16:9":"1280:720","9:16":"720:1280"},
    "gemini_omni_flash_1.2":{
      "16:9":resolution==="4k"?"3840:2160":resolution==="1080p"?"1920:1080":resolution==="360p"?"640:360":"1280:720",
      "9:16":resolution==="4k"?"2160:3840":resolution==="1080p"?"1080:1920":resolution==="360p"?"360:640":"720:1280"
    },
    "seedance2_5":{
      "16:9":resolution==="4k"?"3840:2160":resolution==="1080p"?"1920:1080":resolution==="720p"?"1280:720":"854:480",
      "9:16":resolution==="4k"?"2160:3840":resolution==="1080p"?"1080:1920":resolution==="720p"?"720:1280":"480:854",
      "1:1":resolution==="4k"?"3840:3840":resolution==="1080p"?"1440:1440":resolution==="720p"?"960:960":"640:640",
      "4:3":resolution==="4k"?"3840:2880":resolution==="1080p"?"1664:1248":resolution==="720p"?"1112:834":"752:560",
      "3:4":resolution==="4k"?"2880:3840":resolution==="1080p"?"1248:1664":resolution==="720p"?"834:1112":"560:752",
      "21:9":resolution==="4k"?"3840:1646":resolution==="1080p"?"2206:946":resolution==="720p"?"1470:630":"992:432"
    },
    "kling_4":{
      "16:9":resolution==="1080p"?"1920:1080":"1280:720",
      "9:16":resolution==="1080p"?"1080:1920":"720:1280",
      "1:1":resolution==="1080p"?"1440:1440":"940:940",
      "21:9":resolution==="1080p"?"2200:940":"1460:624"
    },
    "kling_4_flash":{"16:9":"1280:720","9:16":"720:1280","1:1":"960:960","21:9":"1464:628"},
    "kling3.0_standard":{"16:9":"1280:720","9:16":"720:1280","1:1":"960:960"},
    "kling3.0_pro":{"16:9":"1920:1080","9:16":"1080:1920","1:1":"1440:1440"},
    "kling3.0_4k":{"16:9":"3840:2160","9:16":"2160:3840","1:1":"2880:2880"}
  };
  return maps[model]?.[ratio]||"";
};
export function listRunwayVideoModels(){
  return Object.entries(MODEL_PROFILES).map(([id,profile])=>({
    id,label:profile.label,minDurationSeconds:profile.minDurationSeconds,
    maxDurationSeconds:profile.maxDurationSeconds,aspectRatios:[...profile.aspectRatios],
    resolutions:[...profile.resolutions],execution:"async",inputModes:["kling_4_flash","gemini_omni_flash_1.2"].includes(id)?["text-to-video","image-to-video","video-to-video"]:["text-to-video","image-to-video"],
    readiness:"adapter-supported; credentials and remote opt-in required"
  }));
}
export function getRunwayVideoCapabilities(model=process.env.RUNWAY_VIDEO_MODEL||""){
  const profile=MODEL_PROFILES[String(model||"").trim()];
  if(!profile)return Object.freeze({negativePrompt:false,seed:false,startFrame:false,endFrame:false,motionReference:false,referenceImages:false,audioModes:[],aspectRatios:[],resolutions:[],minDurationSeconds:0,maxDurationSeconds:0});
  return Object.freeze({
    negativePrompt:false,seed:false,startFrame:true,endFrame:false,motionReference:false,
    referenceImages:String(model||"").trim()!=="kling_4_flash",audioModes:Object.freeze(["seedance2_5","kling3.0_standard","kling3.0_pro","kling3.0_4k"].includes(String(model||"").trim())?["generated","none"]:["kling_4","kling_4_flash"].includes(String(model||"").trim())?["generated"]:[]),
    aspectRatios:Object.freeze([...profile.aspectRatios]),
    resolutions:Object.freeze([...profile.resolutions]),
    minDurationSeconds:profile.minDurationSeconds,maxDurationSeconds:profile.maxDurationSeconds
  });
}
function validateKlingMultiPrompt(model,multiPrompt,shotType,promptText){
 if(multiPrompt===undefined||multiPrompt===null)return null;
 if(!String(model||"").startsWith("kling3.0_"))throw fail("Multi-shot prompts are supported only by Kling 3.0 profiles.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(!Array.isArray(multiPrompt)||multiPrompt.length<1||multiPrompt.length>6)throw fail("Kling multi-shot prompts require one to six segments.","VIDEO_GATEWAY_INVALID_INPUT");
 const segments=multiPrompt.map(segment=>({prompt:String(segment?.prompt||"").trim(),duration:Number(segment?.duration)}));
 if(segments.some(segment=>segment.prompt.length<3||segment.prompt.length>512||!Number.isInteger(segment.duration)||segment.duration<1||segment.duration>15))throw fail("Each Kling shot requires a 3–512 character prompt and an integer duration from 1 to 15 seconds.","VIDEO_GATEWAY_INVALID_INPUT");
 const total=segments.reduce((sum,item)=>sum+item.duration,0);
 if(total<3||total>15)throw fail("Kling multi-shot segment durations must total 3–15 seconds.","VIDEO_GATEWAY_INVALID_INPUT");
 if(!["customize","intelligence"].includes(shotType))throw fail("Kling multi-shot shotType must be customize or intelligence.","VIDEO_GATEWAY_INVALID_INPUT");
 if(shotType==="intelligence"&&(String(promptText||"").trim().length<2||String(promptText||"").length>2500))throw fail("Kling intelligence shot type requires a 2–2,500 character promptText.","VIDEO_GATEWAY_INVALID_INPUT");
 return Object.freeze(segments.map(item=>Object.freeze(item)));
}
export function buildRunwayVideoPayload({model,prompt,durationSeconds=5,aspectRatio="16:9",resolution="provider_default",multiPrompt,shotType="customize",draft=false,references=[],referenceAudio=[]}={}){
  const id=String(model||"").trim(),profile=MODEL_PROFILES[id];
  if(!profile)throw fail("Select a Runway video model with a verified text-to-video adapter.","VIDEO_GATEWAY_UNSUPPORTED_MODEL");
  const text=typeof prompt==="string"?prompt.trim():"";
  if(typeof draft!=="boolean")throw fail("Draft mode must be a boolean.","VIDEO_GATEWAY_INVALID_INPUT");
  if(draft&&id!=="seedance2_5")throw fail("Draft previews are supported only by Seedance 2.5.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  if(draft&&resolution!=="480p")throw fail("Seedance 2.5 draft previews are fixed at 480p.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const kling3=id.startsWith("kling3.0_");
  const maxPrompt=id==="seedance2_5"?15000:["kling_4","kling_4_flash"].includes(id)?26000:id==="gemini_omni_flash_1.2"?4000:kling3?2500:1000;
  const segments=validateKlingMultiPrompt(id,multiPrompt,shotType,text);
  const validUri = value => typeof value === "string" && (/^https:\/\//i.test(value) || /^runway:\/\//i.test(value));
  if (!Array.isArray(references) || references.length > 30 || references.some(item => !item || !validUri(item.uri))) throw fail("Seedance image references must contain at most 30 valid HTTPS or Runway URIs.","VIDEO_GATEWAY_INVALID_INPUT");
  if (!Array.isArray(referenceAudio) || referenceAudio.length > 10 || referenceAudio.some(item => !item || !validUri(item.uri))) throw fail("Seedance audio references must contain at most 10 valid HTTPS or Runway URIs.","VIDEO_GATEWAY_INVALID_INPUT");
  if (id !== "seedance2_5" && (references.length || referenceAudio.length)) throw fail("Native image/audio references are enabled only for Seedance 2.5 in this adapter.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  if((!text&&!segments&&!references.length&&!referenceAudio.length)||text.length>maxPrompt)throw fail("Runway text-to-video prompt is empty or exceeds the selected model limit of "+maxPrompt+" characters.","VIDEO_GATEWAY_INVALID_INPUT");
  if(kling3&&text&&text.length<2)throw fail("Kling 3.0 prompts require at least two characters.","VIDEO_GATEWAY_INVALID_INPUT");
  if(!segments&&(!Number.isInteger(durationSeconds)||durationSeconds<profile.minDurationSeconds||durationSeconds>profile.maxDurationSeconds))throw fail("Duration is outside the selected model documented range.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  if(!profile.aspectRatios.includes(aspectRatio))throw fail("Aspect ratio is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const effectiveResolution=draft?"480p":resolution==="provider_default"?profile.defaultResolution:resolution;
  const ratio=ratioFor(id,aspectRatio,draft?"720p":effectiveResolution);
  if(!ratio)throw fail("No verified output ratio mapping exists for this model and aspect ratio.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const payload={model:id,ratio,...(text?{promptText:text}:{}),...(segments?{providerSettings:{multiPrompt:segments,shotType}}:{duration:durationSeconds}),...(references.length?{references:references.map(item=>({uri:item.uri}))}:{}),...(referenceAudio.length?{referenceAudio:referenceAudio.map(item=>({uri:item.uri}))}:{}),...(draft?{draft:true}:{})};
  if(id==="seedance2_5"&&segments)throw fail("Seedance multi-shot requests require the dedicated recipe adapter and are not enabled in this worker.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  return Object.freeze(payload);
}
export function buildRunwayImageToVideoPayload({model,prompt,promptImage,durationSeconds=5,aspectRatio="16:9",resolution="provider_default",multiPrompt,shotType="customize",draft=false}={}){
 const id=String(model||"").trim(),profile=MODEL_PROFILES[id];
 if(!profile)throw fail("Select a Runway model with a verified image-to-video adapter.","VIDEO_GATEWAY_UNSUPPORTED_MODEL");
 const text=typeof prompt==="string"?prompt.trim():"";
 if(typeof draft!=="boolean")throw fail("Draft mode must be a boolean.","VIDEO_GATEWAY_INVALID_INPUT");
 if(draft&&id!=="seedance2_5")throw fail("Draft previews are supported only by Seedance 2.5.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(draft&&resolution!=="480p")throw fail("Seedance 2.5 draft previews are fixed at 480p.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 const kling3=id.startsWith("kling3.0_");
 const maxPrompt=id==="seedance2_5"?15000:["kling_4","kling_4_flash"].includes(id)?26000:id==="gemini_omni_flash_1.2"?4000:kling3?2500:1000;
 const segments=validateKlingMultiPrompt(id,multiPrompt,shotType,text);
 if((!text&&!segments)||text.length>maxPrompt)throw fail("Runway image-to-video prompt is empty or exceeds the selected model limit of "+maxPrompt+" characters.","VIDEO_GATEWAY_INVALID_INPUT");
 if(kling3&&text&&text.length<2)throw fail("Kling 3.0 prompts require at least two characters.","VIDEO_GATEWAY_INVALID_INPUT");
 if(typeof promptImage!=="string"||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(promptImage)||Buffer.byteLength(promptImage)>5*1024*1024)throw fail("Runway first-frame images must be valid PNG, JPEG or WebP data URIs no larger than 5 MiB.","VIDEO_GATEWAY_INVALID_INPUT");
 if(!segments&&(!Number.isInteger(durationSeconds)||durationSeconds<profile.minDurationSeconds||durationSeconds>profile.maxDurationSeconds))throw fail("Duration is outside the selected model documented range.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(!profile.aspectRatios.includes(aspectRatio))throw fail("Aspect ratio is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 const payload={model:id,...(text?{promptText:text}:{}),promptImage,...(segments?{providerSettings:{multiPrompt:segments,shotType}}:{duration:durationSeconds}),...(draft?{draft:true}:{})};
 if(id==="seedance2_5"){
  const effectiveResolution=draft?"480p":resolution==="provider_default"?profile.defaultResolution:resolution;
  if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by the selected Runway model.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const ratio=ratioFor(id,aspectRatio,effectiveResolution);
  if(!ratio)throw fail("No verified Seedance image-to-video ratio mapping exists.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  payload.ratio=ratio;
 }else if(id==="gen4.5"){
  const ratio={"16:9":"1280:720","9:16":"720:1280"}[aspectRatio];
  if(!ratio)throw fail("Gen-4.5 image-to-video ratio is unsupported.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  payload.ratio=ratio;
 }else if(id==="gemini_omni_flash_1.2"){
  const effectiveResolution=resolution==="provider_default"?profile.defaultResolution:resolution;
  if(!profile.resolutions.includes(resolution))throw fail("Resolution is not supported by Gemini Omni 1.2 image-to-video.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  const ratio=ratioFor(id,aspectRatio,effectiveResolution);
  if(!ratio)throw fail("No verified Gemini Omni 1.2 image-to-video ratio mapping exists.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  payload.ratio=ratio;
 }else if(id==="kling_4"){
  payload.ratio=resolution==="1080p"?"auto_1080p":"auto_720p";
 }else if(id.startsWith("kling3.0_")){
  payload.ratio=ratioFor(id,aspectRatio,profile.defaultResolution);
 }
 return Object.freeze(payload);
}
async function readBoundedJsonText(response,maxBytes=2*1024*1024){
  const declared=Number(response.headers?.get?.("content-length")||0);
  if(Number.isFinite(declared)&&declared>maxBytes){try{await response.body?.cancel?.()}catch{}throw fail("Runway API returned an oversized response.","VIDEO_GATEWAY_INVALID_RESPONSE");}
  const reader=response.body?.getReader?.();
  if(!reader)throw fail("Runway API response did not provide a readable stream.","VIDEO_GATEWAY_INVALID_RESPONSE");
  const chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel().catch(()=>{});throw fail("Runway API returned an oversized response.","VIDEO_GATEWAY_INVALID_RESPONSE");}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock?.();}
  return Buffer.concat(chunks,total).toString("utf8");
}
async function requestJson(url,{method="GET",headers={},body,timeoutMs=30000,fetchImpl=fetch,allowStatuses=[]}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    let response;
    try{response=await fetchImpl(url,{method,headers,body,signal:controller.signal,redirect:"error"});}
    catch(error){throw fail(error?.name==="AbortError"?"Runway API request timed out.":"Runway API could not be reached.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE");}
    if(response.status===429){try{await response.body?.cancel?.()}catch{}throw fail("Runway API rate limit reached.","VIDEO_GATEWAY_RATE_LIMITED");}
    if(response.status>=500){try{await response.body?.cancel?.()}catch{}throw fail("Runway API returned a temporary server error.","VIDEO_GATEWAY_SERVER_ERROR");}
    if(!response.ok&&!allowStatuses.includes(response.status)){try{await response.body?.cancel?.()}catch{}throw fail("Runway API rejected the request ("+response.status+").","VIDEO_GATEWAY_REQUEST_REJECTED");}
    if(response.status===404&&allowStatuses.includes(404))return {__httpStatus:404};
    const raw=await readBoundedJsonText(response);
    let data={};try{data=raw?JSON.parse(raw):{};}catch{throw fail("Runway API returned invalid JSON.","VIDEO_GATEWAY_INVALID_RESPONSE");}
    return response.status===404?{...data,__httpStatus:404}:data;
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
    if(Number(response.headers.get("content-length")||0)>MAX_OUTPUT_BYTES){try{await response.body?.cancel?.()}catch{}throw fail("Generated video exceeds the 250 MiB limit.","VIDEO_GATEWAY_INVALID_RESPONSE");}
    if(!response.body?.getReader)throw fail("Runway output cannot be streamed safely.","VIDEO_GATEWAY_INVALID_RESPONSE");
    const reader=response.body.getReader(),chunks=[];let total=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_OUTPUT_BYTES){await reader.cancel().catch(()=>{});throw fail("Generated video exceeds the 250 MiB limit.","VIDEO_GATEWAY_INVALID_RESPONSE");}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    const buffer=Buffer.concat(chunks,total);
    if(buffer.length<12||buffer.toString("ascii",4,8)!=="ftyp")throw fail("Runway output is not a supported MP4 file.","VIDEO_GATEWAY_INVALID_RESPONSE");
    return buffer;
  }finally{clearTimeout(timer);}
}
function runwayServerConfig(){
 if(process.env.VIDEO_GATEWAY_ENABLED!=="true")throw fail("Video generation is disabled by server configuration.","VIDEO_GATEWAY_DISABLED");
 if(process.env.VIDEO_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote video providers are disabled. Review Runway pricing and explicitly enable remote access on the server.","VIDEO_GATEWAY_REMOTE_DISABLED");
 const key=String(process.env.RUNWAYML_API_SECRET||"").trim();
 if(!key)throw fail("Configure RUNWAYML_API_SECRET on the server before using Runway models.","VIDEO_GATEWAY_CONFIG_INVALID");
 return {authorization:"Bearer "+key,"content-type":"application/json","X-Runway-Version":API_VERSION};
}
function assertRunwayTaskId(value){
 const id=String(value||"");
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw fail("Runway did not return a valid task identifier.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return id;
}
/** Submit once. Ambiguous outcomes must be reconciled, never blindly resubmitted. */
export async function submitRunwayVideoTask({model=process.env.RUNWAY_VIDEO_MODEL,prompt,durationSeconds=5,aspectRatio="16:9",resolution="provider_default",referenceImageDataUrl="",fetchImpl=fetch}={}){
 const headers=runwayServerConfig();
 const payload=referenceImageDataUrl?buildRunwayImageToVideoPayload({model,prompt,promptImage:referenceImageDataUrl,durationSeconds,aspectRatio,resolution}):buildRunwayVideoPayload({model,prompt,durationSeconds,aspectRatio,resolution});
 let submitted;
 try{submitted=await requestJson(API_BASE+(referenceImageDataUrl?"/image_to_video":"/text_to_video"),{method:"POST",headers,body:JSON.stringify(payload),timeoutMs:30000,fetchImpl});}
 catch(error){
  if(["VIDEO_GATEWAY_TIMEOUT","VIDEO_GATEWAY_UNAVAILABLE","VIDEO_GATEWAY_SERVER_ERROR"].includes(error?.code))throw fail("Runway submission outcome is unknown. Reconcile the provider task/account before any retry; automatic resubmission is unsafe.","VIDEO_GATEWAY_SUBMISSION_UNKNOWN");
  throw error;
 }
 return Object.freeze({taskId:assertRunwayTaskId(submitted.id),status:"PENDING",model:String(model),estimatedCostCredits:Number(submitted.estimatedCost?.credits)||null,submittedAt:new Date().toISOString()});
}
/** Retrieve an existing provider task; polling may safely use bounded backoff. */
export async function getRunwayVideoTask({taskId,fetchImpl=fetch}={}){
 const id=assertRunwayTaskId(taskId),headers=runwayServerConfig();
 const task=await requestJson(API_BASE+"/tasks/"+encodeURIComponent(id),{headers,timeoutMs:15000,fetchImpl,allowStatuses:[404]});
 if(task.__httpStatus===404)return Object.freeze({taskId:id,status:"CANCELED",model:String(task.model||""),outputUrl:null,createdAt:null,completedAt:null,error:null});
 const statuses=new Set(["PENDING","THROTTLED","RUNNING","SUCCEEDED","FAILED","CANCELED","CANCELLED"]);
 if(!statuses.has(task.status))throw fail("Runway returned an unknown task state.","VIDEO_GATEWAY_INVALID_RESPONSE");
 if(task.id&&task.id!==id)throw fail("Runway task identity did not match the requested task.","VIDEO_GATEWAY_INVALID_RESPONSE");
 const outputUrl=Array.isArray(task.output)?task.output.find(item=>typeof item==="string"&&item.length>0)||null:null;
 if(task.status==="SUCCEEDED"&&!outputUrl)throw fail("Runway task succeeded without an output video URL.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return Object.freeze({taskId:id,status:task.status,model:String(task.model||""),outputUrl,createdAt:task.createdAt||null,completedAt:task.completedAt||null,error:task.failure||task.error||null});
}
/** Cancel or delete a persisted Runway task. A 404 is idempotent after cancellation/deletion. */
export async function cancelRunwayVideoTask({taskId,fetchImpl=fetch}={}){
 const id=assertRunwayTaskId(taskId),headers=runwayServerConfig();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  let response;
  try{response=await fetchImpl(API_BASE+"/tasks/"+encodeURIComponent(id),{method:"DELETE",headers,signal:controller.signal,redirect:"error"});}
  catch(error){throw fail(error?.name==="AbortError"?"Runway cancellation timed out.":"Runway cancellation could not be confirmed.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE");}
  if(response.status===204)return {taskId:id,status:"CANCELLED"};
  if(response.status===404)return {taskId:id,status:"NOT_FOUND"};
  if(response.status===429)throw fail("Runway API rate limit reached.","VIDEO_GATEWAY_RATE_LIMITED");
  if(response.status>=500)throw fail("Runway API returned a temporary server error.","VIDEO_GATEWAY_SERVER_ERROR");
  throw fail("Runway rejected the task cancellation ("+response.status+").","VIDEO_GATEWAY_REQUEST_REJECTED");
 }finally{clearTimeout(timer);}
}
export async function downloadRunwayVideoTaskOutput({outputUrl,fetchImpl=fetch,timeoutMs=60000}={}){
 return downloadMp4(outputUrl,{fetchImpl,timeoutMs});
}
export async function generateRunwayVideo({model=process.env.RUNWAY_VIDEO_MODEL,prompt,durationSeconds=5,aspectRatio="16:9",resolution="provider_default",referenceImageDataUrl="",fetchImpl=fetch,sleepImpl=sleep,now=Date.now}={}){
  const submitted=await submitRunwayVideoTask({model,prompt,durationSeconds,aspectRatio,resolution,referenceImageDataUrl,fetchImpl});
  const taskId=submitted.taskId;
  const headers=runwayServerConfig();
  const timeoutMs=Math.max(10000,Math.min(600000,Number(process.env.VIDEO_GATEWAY_TIMEOUT_MS)||300000));
  const deadline=now()+timeoutMs;let task;
  while(now()<deadline){
    task=await getRunwayVideoTask({taskId,fetchImpl});
    if(task.status==="SUCCEEDED")break;
    if(["FAILED","CANCELED","CANCELLED"].includes(task.status))throw fail("Runway generation failed. Review the provider task details before retrying.","VIDEO_GATEWAY_JOB_FAILED");
    await sleepImpl(Math.min(5000,Math.max(0,deadline-now())));
  }
  if(task?.status!=="SUCCEEDED")throw fail("Runway generation timed out before completion.","VIDEO_GATEWAY_TIMEOUT");
  const output=task.outputUrl;
  const buffer=await downloadRunwayVideoTaskOutput({outputUrl:output,fetchImpl,timeoutMs:Math.min(60000,Math.max(1000,deadline-now()))});
  return {buffer,model:String(task.model||model),provider:"runway",requestId:taskId,usage:null,estimatedCostCredits:submitted.estimatedCostCredits,mimeType:"video/mp4",adapterVersion:"runway-video-gateway-v1"};
}



const MAX_EPHEMERAL_UPLOAD_BYTES = 200 * 1024 * 1024;
const UPLOAD_TYPES = Object.freeze({
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac"
});

/**
 * Upload an already-authorized project asset to Runway's 24-hour ephemeral
 * storage. The caller is responsible for resolving ownership/permissions and
 * reading the file from private storage before calling this function.
 */
export async function uploadRunwayEphemeralAsset({
  buffer,
  filename,
  mimeType,
  fetchImpl = fetch
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 512 || buffer.length > MAX_EPHEMERAL_UPLOAD_BYTES) {
    throw fail("Runway ephemeral uploads must be between 512 bytes and 200 MiB.", "VIDEO_GATEWAY_INVALID_INPUT");
  }
  const type = String(mimeType || "").toLowerCase();
  const expectedExtension = UPLOAD_TYPES[type];
  const safeName = typeof filename === "string" ? filename.trim() : "";
  if (!expectedExtension || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(safeName) || safeName.includes("..") ||
      safeName.slice(safeName.lastIndexOf(".")).toLowerCase() !== expectedExtension) {
    throw fail("Upload filename extension and supported media type must match.", "VIDEO_GATEWAY_INVALID_INPUT");
  }
  const key = String(process.env.RUNWAYML_API_SECRET || "").trim();
  if (!key) throw fail("Configure RUNWAYML_API_SECRET on the server before uploading to Runway.", "VIDEO_GATEWAY_CONFIG_INVALID");
  const headers = { authorization: "Bearer " + key, "content-type": "application/json", "X-Runway-Version": API_VERSION };
  const created = await requestJson(API_BASE + "/uploads", {
    method: "POST", headers, body: JSON.stringify({ filename: safeName, type: "ephemeral" }),
    timeoutMs: 30000, fetchImpl
  });
  const runwayUri = assertRunwayUploadUri(created.runwayUri, "Runway upload response");
  let uploadUrl;
  try { uploadUrl = new URL(created.uploadUrl); } catch {
    throw fail("Runway returned an invalid ephemeral upload URL.", "VIDEO_GATEWAY_INVALID_RESPONSE");
  }
  if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.port || uploadUrl.hash) {
    throw fail("Runway returned an unsafe ephemeral upload URL.", "VIDEO_GATEWAY_INVALID_RESPONSE");
  }
  if (!created.fields || typeof created.fields !== "object" || Array.isArray(created.fields) ||
      Object.keys(created.fields).length > 30 ||
      Object.entries(created.fields).some(([name, value]) =>
        !/^[A-Za-z0-9_-]{1,128}$/.test(name) || typeof value !== "string" || value.length > 4096)) {
    throw fail("Runway returned invalid ephemeral upload fields.", "VIDEO_GATEWAY_INVALID_RESPONSE");
  }
  const form = new FormData();
  for (const [name, value] of Object.entries(created.fields)) form.append(name, value);
  form.append("file", new Blob([buffer], { type }), safeName);
  let response;
  try {
    response = await fetchImpl(uploadUrl, { method: "POST", body: form, redirect: "error" });
  } catch {
    // Runway explicitly requires a fresh upload allocation after upload failure.
    throw fail("Runway ephemeral upload failed. Start a new upload allocation before retrying.", "VIDEO_GATEWAY_UPLOAD_FAILED");
  }
  if (!response.ok) {
    throw fail("Runway ephemeral upload failed. Start a new upload allocation before retrying.", "VIDEO_GATEWAY_UPLOAD_FAILED");
  }
  return Object.freeze({ runwayUri, filename: safeName, mimeType: type, byteSize: buffer.length, expiresInHours: 24 });
}

const VIDEO_TO_VIDEO_MODELS = new Set(["aleph2"]);
const RUNWAY_UPLOAD_URI = /^runway:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,4980}$/;

function assertRunwayUploadUri(value, label) {
  if (typeof value !== "string" || value.length > 5000 || !RUNWAY_UPLOAD_URI.test(value)) {
    throw fail(label + " must be a Runway ephemeral upload URI created from an authorized source asset.", "VIDEO_GATEWAY_INVALID_INPUT");
  }
  return value;
}

/**
 * Build the documented Runway video-to-video request.
 * Only model profiles verified against the current adapter contract are exposed.
 * Inputs must already have been uploaded through Runway's ephemeral upload API;
 * callers must resolve and authorize source assets before uploading them.
 */
export function buildRunwayVideoToVideoPayload({
  model = "aleph2",
  videoUri,
  prompt,
  keyframes = [],
  outputFormat = "mp4",
  durationSeconds,
} = {}) {
  const id = String(model || "").trim();
  if (!VIDEO_TO_VIDEO_MODELS.has(id)) {
    throw fail("The selected Runway model has no verified video-to-video adapter profile.", "VIDEO_GATEWAY_UNSUPPORTED_MODEL");
  }
  const source = assertRunwayUploadUri(videoUri, "Source video");
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text || text.length > 1000) {
    throw fail("Video-edit prompts must contain 1 to 1000 characters.", "VIDEO_GATEWAY_INVALID_INPUT");
  }
  if (!Array.isArray(keyframes) || keyframes.length > 5) {
    throw fail("Video editing accepts at most five keyframe guidance images.", "VIDEO_GATEWAY_INVALID_INPUT");
  }
  let previousAt = -1;
  const normalizedKeyframes = keyframes.map((frame, index) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw fail("Each keyframe must contain an upload URI and timestamp.", "VIDEO_GATEWAY_INVALID_INPUT");
    }
    const uri = assertRunwayUploadUri(frame.uri, "Keyframe " + (index + 1));
    if (!Number.isFinite(frame.at) || frame.at < 0 || frame.at > 1 || frame.at <= previousAt) {
      throw fail("Keyframe timestamps must be strictly increasing and between 0 and 1 (fraction of source duration).", "VIDEO_GATEWAY_INVALID_INPUT");
    }
    previousAt = frame.at;
    return Object.freeze({ uri, at: frame.at });
  });
  if (outputFormat !== "mp4") {
    throw fail("Only MP4 output is currently supported by the private media ingestor.", "VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  }
  if (durationSeconds != null && (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30)) {
    throw fail("Source video duration must be between 1 and 30 seconds.", "VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  }
  return Object.freeze({
    model: id,
    videoUri: source,
    promptText: text,
    ...(normalizedKeyframes.length ? { keyframes: Object.freeze(normalizedKeyframes) } : {}),
    outputFormat: "mp4"
  });
}

/**
 * Submit, reconcile and privately download a Runway video-to-video derivative.
 * No source asset is modified. This synchronous adapter is intended for the
 * existing governed executor; durable worker integrations should persist the
 * provider task ID and poll on subsequent leases instead of holding a lease.
 */
export async function editRunwayVideo({
  model = "aleph2",
  videoUri,
  sourceVideo,
  prompt,
  keyframes = [],
  outputFormat = "mp4",
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now
} = {}) {
  if (process.env.VIDEO_GATEWAY_ENABLED !== "true") {
    throw fail("Video generation is disabled by server configuration.", "VIDEO_GATEWAY_DISABLED");
  }
  if (process.env.VIDEO_GATEWAY_ALLOW_REMOTE !== "true") {
    throw fail("Remote video providers are disabled. Review Runway pricing and explicitly enable remote access on the server.", "VIDEO_GATEWAY_REMOTE_DISABLED");
  }
  const key = String(process.env.RUNWAYML_API_SECRET || "").trim();
  if (!key) throw fail("Configure RUNWAYML_API_SECRET on the server before using Runway models.", "VIDEO_GATEWAY_CONFIG_INVALID");
  let resolvedVideoUri = videoUri;
  if (sourceVideo) {
    const uploaded = await uploadRunwayEphemeralAsset({ ...sourceVideo, fetchImpl });
    resolvedVideoUri = uploaded.runwayUri;
  }
  let resolvedKeyframes = keyframes;
  if (Array.isArray(keyframes) && keyframes.some(frame => frame?.buffer)) {
    resolvedKeyframes = [];
    for (const frame of keyframes) {
      if (frame?.buffer) {
        const uploaded = await uploadRunwayEphemeralAsset({
          buffer: frame.buffer, filename: frame.filename, mimeType: frame.mimeType, fetchImpl
        });
        resolvedKeyframes.push({ uri: uploaded.runwayUri, at: frame.at });
      } else {
        resolvedKeyframes.push(frame);
      }
    }
  }
  const payload = buildRunwayVideoToVideoPayload({ model, videoUri: resolvedVideoUri, prompt, keyframes: resolvedKeyframes, outputFormat });
  const headers = { authorization: "Bearer " + key, "content-type": "application/json", "X-Runway-Version": API_VERSION };
  const submitted = await requestJson(API_BASE + "/video_to_video", {
    method: "POST", headers, body: JSON.stringify(payload), timeoutMs: 30000, fetchImpl
  });
  const taskId = String(submitted.id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    throw fail("Runway did not return a valid task identifier.", "VIDEO_GATEWAY_INVALID_RESPONSE");
  }
  const timeoutMs = Math.max(10000, Math.min(600000, Number(process.env.VIDEO_GATEWAY_TIMEOUT_MS) || 300000));
  const deadline = now() + timeoutMs;
  let task;
  while (now() < deadline) {
    task = await requestJson(API_BASE + "/tasks/" + encodeURIComponent(taskId), { headers, timeoutMs: 15000, fetchImpl });
    if (task.status === "SUCCEEDED") break;
    if (["FAILED", "CANCELED", "CANCELLED"].includes(task.status)) {
      throw fail("Runway video edit failed. Review the provider task details before retrying.", "VIDEO_GATEWAY_JOB_FAILED");
    }
    if (!["PENDING", "RUNNING", "THROTTLED"].includes(task.status)) {
      throw fail("Runway returned an unknown task state.", "VIDEO_GATEWAY_INVALID_RESPONSE");
    }
    await sleepImpl(Math.min(5000, Math.max(0, deadline - now())));
  }
  if (task?.status !== "SUCCEEDED") throw fail("Runway video edit timed out before completion.", "VIDEO_GATEWAY_TIMEOUT");
  const output = Array.isArray(task.output) ? task.output.find(item => typeof item === "string" && item.length > 0) : "";
  if (!output) throw fail("Runway task succeeded without an output video URL.", "VIDEO_GATEWAY_INVALID_RESPONSE");
  const buffer = await downloadMp4(output, { fetchImpl, timeoutMs: Math.min(60000, Math.max(1000, deadline - now())) });
  return {
    buffer, model: String(task.model || model), provider: "runway", requestId: taskId,
    usage: null, estimatedCostCredits: Number(submitted.estimatedCost?.credits) || null,
    mimeType: "video/mp4", adapterVersion: "runway-video-to-video-v1",
    operation: "video-to-video", sourceIsImmutable: true
  };
}
