const MAX_OUTPUT_BYTES=250*1024*1024;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(message,code)=>Object.assign(new Error(message),{code});
function queueUrl(raw){
 let url;try{url=new URL(raw)}catch{throw fail("The video provider returned an invalid job URL.","VIDEO_GATEWAY_INVALID_RESPONSE")}
 if(url.protocol!=="https:"||url.hostname!=="queue.fal.run"||url.username||url.password||url.port||url.hash)throw fail("The video provider returned an unsafe job URL.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return url;
}
async function jsonRequest(url,options,timeoutMs,fetchImpl=fetch,allowStatuses=[]){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  let response;try{response=await fetchImpl(url,{...options,signal:controller.signal,redirect:"error"})}catch(error){throw fail(error?.name==="AbortError"?"Video provider request timed out.":"Video provider could not be reached.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE")}
  if(response.status===429)throw fail("Video provider rate limit reached.","VIDEO_GATEWAY_RATE_LIMITED");
  if(response.status>=500)throw fail("Video provider returned a temporary server error.","VIDEO_GATEWAY_SERVER_ERROR");
  if(!response.ok&&!allowStatuses.includes(response.status))throw fail("Video provider rejected the request ("+response.status+").","VIDEO_GATEWAY_REQUEST_REJECTED");
  const raw=await response.text();if(Buffer.byteLength(raw)>2*1024*1024)throw fail("Video provider returned an oversized response.","VIDEO_GATEWAY_INVALID_RESPONSE");
  try{return JSON.parse(raw)}catch{throw fail("Video provider returned invalid JSON.","VIDEO_GATEWAY_INVALID_RESPONSE")}
 }finally{clearTimeout(timer)}
}
const IMAGE_INPUT_FIELDS=new Set(["image_url","start_image_url","first_frame_image_url"]);
const FAL_VIDEO_ASPECT_RATIOS=Object.freeze(["16:9","9:16","1:1"]);
export function getFalVideoCapabilities({imageInputField=process.env.FAL_VIDEO_IMAGE_INPUT_FIELD||""}={}){
 return Object.freeze({
  negativePrompt:false,seed:false,startFrame:false,endFrame:false,motionReference:false,
  referenceImages:IMAGE_INPUT_FIELDS.has(String(imageInputField||"").trim()),
  audioModes:Object.freeze([]),aspectRatios:FAL_VIDEO_ASPECT_RATIOS,
  resolutions:Object.freeze(["provider_default"]),minDurationSeconds:1,maxDurationSeconds:30
 });
}
export function buildFalVideoPayload({prompt,duration=5,aspectRatio="16:9",referenceImageDataUrl="",imageInputField=process.env.FAL_VIDEO_IMAGE_INPUT_FIELD||""}={}){
 const text=typeof prompt==="string"?prompt.trim():"";
 if(!text||text.length>12000)throw fail("Video prompt must contain 1 to 12000 characters.","VIDEO_GATEWAY_INVALID_INPUT");
 if(!Number.isInteger(duration)||duration<1||duration>30)throw fail("Video duration must be a whole number from 1 to 30 seconds.","VIDEO_GATEWAY_INVALID_INPUT");
 if(!FAL_VIDEO_ASPECT_RATIOS.includes(aspectRatio))throw fail("The selected video model does not support this aspect ratio.","VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 const seconds=duration;
 const payload={prompt:text,duration:seconds,aspect_ratio:aspectRatio};
 if(referenceImageDataUrl){
  const field=String(imageInputField||"").trim();
  if(!IMAGE_INPUT_FIELDS.has(field))throw fail("Configure FAL_VIDEO_IMAGE_INPUT_FIELD to a field supported by the selected image-to-video model before passing a reference image.","VIDEO_GATEWAY_IMAGE_INPUT_UNCONFIGURED");
  if(typeof referenceImageDataUrl!=="string"||referenceImageDataUrl.length>14*1024*1024||!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(referenceImageDataUrl))throw fail("The reference image data URL is invalid or oversized.","VIDEO_GATEWAY_INVALID_INPUT");
  payload[field]=referenceImageDataUrl;
 }
 return payload;
}
function falWorkerConfig(model){
 if(process.env.VIDEO_GATEWAY_ENABLED!=="true")throw fail("Video generation is disabled by server configuration.","VIDEO_GATEWAY_DISABLED");
 if(process.env.VIDEO_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote video providers are disabled. Review pricing and explicitly enable remote access on the server.","VIDEO_GATEWAY_REMOTE_DISABLED");
 const key=String(process.env.FAL_KEY||"").trim(),configured=String(process.env.FAL_VIDEO_MODEL||"").trim();
 if(!key||!configured||configured!==model||model.length>240||!/^[a-zA-Z0-9_./:-]+$/.test(model)||model.includes("..")||model.startsWith("/")||model.endsWith("/")||model.split("/").length<2)
  throw fail("The selected Fal model does not match the configured server-side model or credentials are missing.","VIDEO_GATEWAY_CONFIG_INVALID");
 return {key,parts:model.split("/")};
}
function falTaskUrl(model,taskId,suffix=""){
 const parts=String(model||"").split("/");
 if(parts.length<2||parts.some(part=>!part||part==="."||part===".."))throw fail("Fal model identity is invalid.","VIDEO_GATEWAY_INVALID_INPUT");
 const id=String(taskId||"");
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw fail("Fal request identity is invalid.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return new URL("https://queue.fal.run/"+encodeURIComponent(parts[0])+"/"+encodeURIComponent(parts[1])+"/requests/"+id+suffix);
}
/** Submit one durable Fal queue task; the worker persists its request ID before polling. */
export async function submitFalVideoTask({model=process.env.FAL_VIDEO_MODEL,prompt,durationSeconds=5,aspectRatio="16:9",referenceImageDataUrl="",fetchImpl=fetch}={}){
 const {key,parts}=falWorkerConfig(model);
 const payload=buildFalVideoPayload({prompt,duration:durationSeconds,aspectRatio,referenceImageDataUrl});
 const endpoint=new URL("https://queue.fal.run/"+parts.map(part=>encodeURIComponent(part)).join("/"));
 const submitted=await jsonRequest(endpoint,{method:"POST",headers:{authorization:"Key "+key,"content-type":"application/json","X-Fal-No-Retry":"1"},body:JSON.stringify(payload)},30000,fetchImpl);
 const taskId=String(submitted.request_id||"");
 falTaskUrl(model,taskId);
 if(submitted.status!=="IN_QUEUE"&&submitted.status!=="IN_PROGRESS")throw fail("Fal did not confirm that the generation request entered its durable queue.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return {taskId,status:"PENDING",model,provider:"fal",submittedAt:new Date().toISOString()};
}
/** Poll only the persisted Fal request ID; this never submits a second request. */
export async function getFalVideoTask({taskId,model=process.env.FAL_VIDEO_MODEL,fetchImpl=fetch}={}){
 const {key}=falWorkerConfig(model);
 const statusUrl=falTaskUrl(model,taskId,"/status");
 const status=await jsonRequest(statusUrl,{headers:{authorization:"Key "+key}},15000,fetchImpl);
 if(status.request_id&&status.request_id!==taskId)throw fail("Fal task identity did not match the requested task.","VIDEO_GATEWAY_INVALID_RESPONSE");
 if(status.status==="IN_QUEUE")return {taskId,status:"PENDING"};
 if(status.status==="IN_PROGRESS")return {taskId,status:"RUNNING"};
 if(status.status!=="COMPLETED")throw fail("Fal returned an unknown queue state.","VIDEO_GATEWAY_INVALID_RESPONSE");
 if(status.error||status.error_type)return {taskId,status:"FAILED",error:{code:String(status.error_type||"FAL_TASK_FAILED"),message:String(status.error||"Fal task failed.").slice(0,300)}};
 const result=await jsonRequest(falTaskUrl(model,taskId),{headers:{authorization:"Key "+key}},20000,fetchImpl);
 const outputUrl=String(result.video?.url||result.videos?.[0]?.url||"");
 let url;try{url=new URL(outputUrl)}catch{throw fail("Fal completed the request without a valid video URL.","VIDEO_GATEWAY_INVALID_RESPONSE");}
 if(url.protocol!=="https:"||!(url.hostname==="fal.media"||url.hostname.endsWith(".fal.media"))||url.username||url.password||url.port||url.hash||url.search)
  throw fail("Fal returned an untrusted output URL.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return {taskId,status:"SUCCEEDED",outputUrl};
}
/** Request cancellation for a persisted Fal queue request. CANCELLATION_REQUESTED is not treated as terminal. */
export async function cancelFalVideoTask({taskId,model=process.env.FAL_VIDEO_MODEL,fetchImpl=fetch}={}){
 const {key}=falWorkerConfig(model);
 const response=await jsonRequest(falTaskUrl(model,taskId,"/cancel"),{method:"PUT",headers:{authorization:"Key "+key}},15000,fetchImpl,[404]);
 const status=String(response.status||"");
 if(!["OK","CANCELLATION_REQUESTED","ALREADY_COMPLETED","NOT_FOUND"].includes(status))
  throw fail("Fal returned an unknown cancellation state.","VIDEO_GATEWAY_INVALID_RESPONSE");
 return {taskId,status};
}
/** Download a completed Fal result from its allowlisted media host with strict size and MP4 checks. */
export async function downloadFalVideoTaskOutput({outputUrl,fetchImpl=fetch,timeoutMs=60000,maxOutputBytes=MAX_OUTPUT_BYTES}={}){
 let url;try{url=new URL(outputUrl)}catch{throw fail("Fal output URL is invalid.","VIDEO_GATEWAY_INVALID_RESPONSE");}
 if(url.protocol!=="https:"||!(url.hostname==="fal.media"||url.hostname.endsWith(".fal.media"))||url.username||url.password||url.port||url.hash||url.search)
  throw fail("Fal output URL is not on an approved media host.","VIDEO_GATEWAY_INVALID_RESPONSE");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(120000,timeoutMs)));
 try{
  let response;try{response=await fetchImpl(url,{signal:controller.signal,redirect:"error"})}catch(error){throw fail(error?.name==="AbortError"?"Fal output download timed out.":"Fal output could not be downloaded safely.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE");}
  if(!response.ok)throw fail("Fal output download failed.","VIDEO_GATEWAY_INVALID_RESPONSE");
  if(Number(response.headers.get("content-length")||0)>maxOutputBytes)throw fail("Fal output exceeds the configured size limit.","VIDEO_OUTPUT_INVALID");
  if(!response.body?.getReader)throw fail("Fal output cannot be streamed safely.","VIDEO_GATEWAY_INVALID_RESPONSE");
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxOutputBytes){await reader.cancel().catch(()=>{});throw fail("Fal output exceeds the configured size limit.","VIDEO_OUTPUT_INVALID");}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  const buffer=Buffer.concat(chunks,total);
  if(buffer.length<12||buffer.toString("ascii",4,8)!=="ftyp")throw fail("Fal output is not a supported MP4 video.","VIDEO_OUTPUT_INVALID");
  return buffer;
 }finally{clearTimeout(timer);}
}
export async function generateFalVideo({prompt,duration=5,aspectRatio="16:9",referenceImageDataUrl=""}={}){
 if(process.env.VIDEO_GATEWAY_ENABLED!=="true")throw fail("Video generation is disabled by server configuration.","VIDEO_GATEWAY_DISABLED");
 if(process.env.VIDEO_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote video providers are disabled. Verify pricing and explicitly enable remote access on the server.","VIDEO_GATEWAY_REMOTE_DISABLED");
 const key=String(process.env.FAL_KEY||"").trim(),model=String(process.env.FAL_VIDEO_MODEL||"").trim();
 if(!key||!model||model.length>240||!/^[a-zA-Z0-9_./:-]+$/.test(model)||model.includes("..")||model.startsWith("/"))throw fail("Configure a valid server-side video provider key and model before running this node.","VIDEO_GATEWAY_CONFIG_INVALID");
 const text=String(prompt||"").trim().slice(0,20000);if(!text)throw fail("Video generation requires a non-empty prompt.","PROMPT_REQUIRED");
 const timeoutMs=Math.max(1000,Math.min(600000,Number(process.env.VIDEO_GATEWAY_TIMEOUT_MS)||300000));
 const endpoint="https://queue.fal.run/"+model.split("/").map(encodeURIComponent).join("/");
 const headers={authorization:"Key "+key,"content-type":"application/json"};
 const payload=buildFalVideoPayload({prompt:text,duration,aspectRatio,referenceImageDataUrl});
 const submitted=await jsonRequest(endpoint,{method:"POST",headers,body:JSON.stringify(payload)},Math.min(timeoutMs,30000));
 const id=String(submitted.request_id||"");if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw fail("Video provider did not return a valid request identifier.","VIDEO_GATEWAY_INVALID_RESPONSE");
 const statusUrl=queueUrl(submitted.status_url||("https://queue.fal.run/"+model+"/requests/"+id+"/status"));
 const resultUrl=queueUrl(submitted.response_url||("https://queue.fal.run/"+model+"/requests/"+id));
 const deadline=Date.now()+timeoutMs;let result;
 while(Date.now()<deadline){
  const status=await jsonRequest(statusUrl,{headers:{authorization:"Key "+key}},Math.min(15000,Math.max(1000,deadline-Date.now())));
  if(status.status==="COMPLETED"){result=await jsonRequest(resultUrl,{headers:{authorization:"Key "+key}},Math.min(20000,Math.max(1000,deadline-Date.now())));break}
  if(["FAILED","CANCELLED"].includes(status.status))throw fail("Video provider job did not complete successfully.","VIDEO_GATEWAY_JOB_FAILED");
  if(!["IN_QUEUE","IN_PROGRESS"].includes(status.status))throw fail("Video provider returned an unknown job state.","VIDEO_GATEWAY_INVALID_RESPONSE");
  await sleep(Math.min(1500,Math.max(0,deadline-Date.now())));
 }
 if(!result)throw fail("Video provider job timed out before completion.","VIDEO_GATEWAY_TIMEOUT");
 const rawUrl=String(result.video?.url||result.videos?.[0]?.url||"");let url;
 try{url=new URL(rawUrl)}catch{throw fail("Video provider returned no valid output video URL.","VIDEO_GATEWAY_INVALID_RESPONSE")}
 if(url.protocol!=="https:"||!(url.hostname==="fal.media"||url.hostname.endsWith(".fal.media"))||url.username||url.password||url.port)throw fail("Video provider returned an unsafe output URL.","VIDEO_GATEWAY_INVALID_RESPONSE");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(60000,Math.max(1000,deadline-Date.now())));
 try{
  let response;try{response=await fetch(url,{signal:controller.signal,redirect:"error"})}catch(error){throw fail(error?.name==="AbortError"?"Generated video download timed out.":"Generated video could not be downloaded safely.",error?.name==="AbortError"?"VIDEO_GATEWAY_TIMEOUT":"VIDEO_GATEWAY_UNAVAILABLE")}
  if(!response.ok)throw fail("Generated video download failed.","VIDEO_GATEWAY_INVALID_RESPONSE");
  if(Number(response.headers.get("content-length")||0)>MAX_OUTPUT_BYTES)throw fail("Generated video exceeds the 250 MiB limit.","VIDEO_GATEWAY_INVALID_RESPONSE");
  if(!response.body?.getReader)throw fail("Generated video response cannot be streamed safely.","VIDEO_GATEWAY_INVALID_RESPONSE");
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_OUTPUT_BYTES){await reader.cancel().catch(()=>{});throw fail("Generated video exceeds the 250 MiB limit.","VIDEO_GATEWAY_INVALID_RESPONSE")}chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}
  const buffer=Buffer.concat(chunks,total);
  if(buffer.length<12||buffer.toString("ascii",4,8)!=="ftyp")throw fail("Generated output is not a supported MP4 video.","VIDEO_GATEWAY_INVALID_RESPONSE");
  return {buffer,model,provider:"fal",requestId:id,usage:null,mimeType:"video/mp4"};
 }finally{clearTimeout(timer)}
}
