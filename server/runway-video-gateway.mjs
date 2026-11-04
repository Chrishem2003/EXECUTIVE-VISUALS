import {assertVideoCapabilities,normalizeVideoGenerationRequest} from "./video-generation-contract.mjs";
const API_BASE="https://api.dev.runwayml.com/v1";
const API_VERSION="2024-11-06";
const MODEL="gen4.5";
const TEXT_RATIOS=new Set(["1280:720","720:1280"]);
const ASPECT_TO_RATIO=Object.freeze({"16:9":"1280:720","9:16":"720:1280","4:3":"1104:832","1:1":"960:960","3:4":"832:1104","21:9":"1584:672"});
const IMAGE_ASPECT_RATIOS=Object.freeze(["16:9","9:16","4:3","1:1","3:4","21:9"]);
const CAPABILITIES=Object.freeze({negativePrompt:false,seed:true,startFrame:true,endFrame:false,motionReference:false,referenceImages:false,audioModes:Object.freeze([]),aspectRatios:IMAGE_ASPECT_RATIOS,resolutions:Object.freeze(["provider_default"]),minDurationSeconds:2,maxDurationSeconds:10});
const TERMINAL=new Set(["SUCCEEDED","FAILED","CANCELED"]);
export const RUNWAY_MIN_POLL_INTERVAL_MS=5000;
const fail=(message,code)=>Object.assign(new Error(message),{code});
function taskId(value){
 const id=String(value||"");
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw fail("Runway task ID is invalid.","RUNWAY_INVALID_TASK_ID");
 return id;
}
function normalizeTask(payload){
 if(!payload||typeof payload!=="object"||Array.isArray(payload))throw fail("Runway returned an invalid task response.","RUNWAY_INVALID_RESPONSE");
 const id=taskId(payload.id);
 const raw=String(payload.status||"").toUpperCase();
 const states={PENDING:"queued",THROTTLED:"queued",RUNNING:"running",SUCCEEDED:"succeeded",FAILED:"failed",CANCELED:"canceled"};
 if(!states[raw])throw fail("Runway returned an unknown task state.","RUNWAY_INVALID_RESPONSE");
 const output=Array.isArray(payload.output)?payload.output:payload.output==null?[]:[payload.output];
 const outputUrls=output.map(value=>{
  let url;try{url=new URL(value)}catch{throw fail("Runway returned an invalid output URL.","RUNWAY_INVALID_RESPONSE")}
  if(url.protocol!=="https:"||url.username||url.password||url.hash)throw fail("Runway returned an unsafe output URL.","RUNWAY_INVALID_RESPONSE");
  return url.href;
 });
 const credits=Number(payload.estimatedCost?.credits??payload.cost?.credits);
 return Object.freeze({
  taskId:id,status:states[raw],provider:"runway",model:MODEL,
  outputUrls:Object.freeze(outputUrls),
  ...(Number.isFinite(credits)&&credits>=0?{estimatedCostCredits:credits}:{}),
  ...(typeof payload.failure==="string"?{failure:payload.failure.slice(0,1000)}:{}),
  ...(typeof payload.failureCode==="string"?{failureCode:payload.failureCode.slice(0,120)}:{})
 });
}
export function buildRunwayTextVideoPayload({prompt,duration=5,ratio="1280:720",seed}={}){
 if(typeof prompt!=="string"||!prompt.trim()||prompt.trim().length>1000)throw fail("Runway video prompt must contain 1 to 1000 characters.","RUNWAY_INVALID_INPUT");
 if(!Number.isInteger(duration)||duration<2||duration>10)throw fail("Runway Gen-4.5 duration must be a whole number from 2 to 10 seconds.","RUNWAY_UNSUPPORTED_CAPABILITY");
 if(!TEXT_RATIOS.has(ratio))throw fail("Runway Gen-4.5 supports 1280:720 or 720:1280 output ratios.","RUNWAY_UNSUPPORTED_CAPABILITY");
 const payload={model:MODEL,promptText:prompt.trim(),ratio,duration};
 if(seed!==undefined){if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw fail("Runway seed must be an unsigned 32-bit integer.","RUNWAY_INVALID_INPUT");payload.seed=seed;}
 return Object.freeze(payload);
}
export function buildRunwayImageVideoPayload({prompt,promptImage,duration=5,ratio="1280:720",seed}={}){
 if(typeof prompt!=="string"||!prompt.trim()||prompt.trim().length>1000)throw fail("Runway video prompt must contain 1 to 1000 characters.","RUNWAY_INVALID_INPUT");
 if(typeof promptImage!=="string"||promptImage.length<13||promptImage.length>5000)throw fail("Runway image input URI is invalid.","RUNWAY_INVALID_INPUT");
 if(!/^runway:\/\/[A-Za-z0-9._~:/-]+$/.test(promptImage)){
  let url;try{url=new URL(promptImage)}catch{throw fail("Runway image input URI is invalid.","RUNWAY_INVALID_INPUT")}
  if(url.protocol!=="https:"||url.username||url.password||url.hash)throw fail("Runway image input must be an HTTPS asset URI without credentials or fragments.","RUNWAY_INVALID_INPUT");
 }
 if(!Object.values(ASPECT_TO_RATIO).includes(ratio))throw fail("Runway Gen-4.5 image-to-video ratio is unsupported.","RUNWAY_UNSUPPORTED_CAPABILITY");
 if(!Number.isInteger(duration)||duration<2||duration>10)throw fail("Runway Gen-4.5 duration must be a whole number from 2 to 10 seconds.","RUNWAY_UNSUPPORTED_CAPABILITY");
 const payload={model:MODEL,promptImage,promptText:prompt.trim(),position:"first",ratio,duration};
 if(seed!==undefined){if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw fail("Runway seed must be an unsigned 32-bit integer.","RUNWAY_INVALID_INPUT");payload.seed=seed;}
 return Object.freeze(payload);
}
export function createRunwayVideoAdapter({env=process.env,fetchImpl=globalThis.fetch,timeoutMs=30000,resolveAssetUri}={}){
 if(typeof fetchImpl!=="function")throw new TypeError("A fetch implementation is required.");
 function configuration(){
  if(env.RUNWAY_VIDEO_ENABLED!=="true")throw fail("Runway video generation is disabled by server configuration.","RUNWAY_DISABLED");
  if(env.RUNWAY_VIDEO_ALLOW_REMOTE!=="true")throw fail("Runway remote execution requires explicit server-side opt-in.","RUNWAY_REMOTE_DISABLED");
  const key=String(env.RUNWAY_API_KEY||"").trim();
  if(!key)throw fail("Configure the Runway API key on the server before enabling this adapter.","RUNWAY_CONFIG_INVALID");
  const configuredModel=String(env.RUNWAY_VIDEO_MODEL||MODEL).trim();
  if(configuredModel!==MODEL)throw fail("The initial Runway adapter supports the verified gen4.5 model only.","RUNWAY_CONFIG_INVALID");
  return {key,model:configuredModel};
 }
 async function request(path,{method="GET",body}={}){
  const {key}=configuration();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(120000,timeoutMs)));
  try{
   let response;
   try{response=await fetchImpl(API_BASE+path,{method,headers:{authorization:"Bearer "+key,"X-Runway-Version":API_VERSION,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:"error"});}
   catch(error){throw fail(error?.name==="AbortError"?"Runway request timed out.":"Runway API could not be reached.",error?.name==="AbortError"?"RUNWAY_TIMEOUT":"RUNWAY_UNAVAILABLE");}
   if(response.status===429)throw fail("Runway rate limit reached.","RUNWAY_RATE_LIMITED");
   if(response.status>=500)throw fail("Runway returned a temporary server error.","RUNWAY_SERVER_ERROR");
   if(!response.ok)throw fail("Runway rejected the request ("+response.status+").","RUNWAY_REQUEST_REJECTED");
   if(response.status===204)return null;
   const raw=await response.text();
   if(Buffer.byteLength(raw)>2*1024*1024)throw fail("Runway response exceeded the 2 MB limit.","RUNWAY_INVALID_RESPONSE");
   try{return JSON.parse(raw);}catch{throw fail("Runway returned invalid JSON.","RUNWAY_INVALID_RESPONSE");}
  }finally{clearTimeout(timer);}
 }
 return Object.freeze({
  provider:"runway",model:MODEL,minimumPollIntervalMs:RUNWAY_MIN_POLL_INTERVAL_MS,
  async function prepareInput(input,context={}){
   const normalized=normalizeVideoGenerationRequest(input);
   assertVideoCapabilities(normalized,CAPABILITIES);
   if(!normalized.startFrameAssetId)return input;
   if(typeof resolveAssetUri!=="function")throw fail("Runway image-to-video requires a server-side private asset resolver.","RUNWAY_IMAGE_ASSET_RESOLVER_REQUIRED");
   const ownerId=context?.job?.owner_id,projectId=context?.job?.project_id||null;
   if(typeof ownerId!=="string"||!ownerId.trim())throw fail("Runway image-to-video requires an owned job context.","RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
   let promptImage;
   try{promptImage=await resolveAssetUri({assetId:normalized.startFrameAssetId,ownerId,projectId});}
   catch{throw fail("The selected first-frame asset could not be resolved before provider submission.","RUNWAY_IMAGE_ASSET_RESOLUTION_FAILED");}
   const ratio=ASPECT_TO_RATIO[normalized.aspectRatio];
   if(!ratio)throw fail("Runway Gen-4.5 does not support the requested aspect ratio.","RUNWAY_UNSUPPORTED_CAPABILITY");
   buildRunwayImageVideoPayload({prompt:normalized.prompt,promptImage,duration:normalized.durationSeconds,ratio,seed:normalized.seed});
   return Object.freeze({...input,runwayPromptImage:promptImage});
  }
  async submit(input,context={}){
   const normalized=normalizeVideoGenerationRequest(input);
   assertVideoCapabilities(normalized,CAPABILITIES);
   if(normalized.provider&&normalized.provider!=="runway")throw fail("The request selects a different video provider.","RUNWAY_INVALID_INPUT");
   if(normalized.model&&normalized.model!==MODEL)throw fail("The initial Runway adapter supports gen4.5 only.","RUNWAY_UNSUPPORTED_CAPABILITY");
   const ratio=ASPECT_TO_RATIO[normalized.aspectRatio];
   if(!ratio)throw fail("Runway Gen-4.5 does not support the requested aspect ratio.","RUNWAY_UNSUPPORTED_CAPABILITY");
   let endpoint,payload;
   if(normalized.startFrameAssetId){
    const promptImage=input?.runwayPromptImage;
    if(typeof promptImage!=="string")throw fail("Runway image input was not prepared before provider submission.","RUNWAY_IMAGE_ASSET_NOT_PREPARED");
    payload=buildRunwayImageVideoPayload({prompt:normalized.prompt,promptImage,duration:normalized.durationSeconds,ratio,seed:normalized.seed});
    endpoint="/image_to_video";
   }else{
    if(!TEXT_RATIOS.has(ratio))throw fail("Runway Gen-4.5 text-to-video supports only 16:9 and 9:16.","RUNWAY_UNSUPPORTED_CAPABILITY");
    payload=buildRunwayTextVideoPayload({prompt:normalized.prompt,duration:normalized.durationSeconds,ratio,seed:normalized.seed});
    endpoint="/text_to_video";
   }
   const result=await request(endpoint,{method:"POST",body:payload});
   return Object.freeze({...normalizeTask(result),platformRequestId:normalized.requestId});
  },
  async getStatus(id){return normalizeTask(await request("/tasks/"+encodeURIComponent(taskId(id))));},
  async cancel(id){
   const current=await this.getStatus(id);
   if(current.status!=="queued"&&current.status!=="running"){
    return Object.freeze({taskId:current.taskId,status:current.status,cancelRequested:false,reason:"Task is already terminal; it was not deleted."});
   }
   await request("/tasks/"+encodeURIComponent(taskId(id)),{method:"DELETE"});
   return Object.freeze({taskId:current.taskId,status:"cancel_requested",cancelRequested:true,warning:"Cancellation is best-effort; execution or billing may already have advanced."});
  }
 });
}
