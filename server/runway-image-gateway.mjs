const API_BASE="https://api.dev.runwayml.com/v1";
const API_VERSION="2024-11-06";
const MAX_OUTPUT_BYTES=50*1024*1024;
const MAX_REFERENCE_BYTES=5*1024*1024;
const MAX_REFERENCE_TOTAL_BYTES=32*1024*1024;
const MODELS=new Set(["gpt_image_2_6_flare","gpt_image_2_6_sunburst"]);
const RATIOS=new Set([
 "1920:1920","1536:1920","1920:1536","1440:1920","1920:1440","1280:1920","1920:1280","1088:1920","1920:1088","2048:880",
 "2560:2560","2048:2560","2560:2048","1920:2560","2560:1920","1712:2560","2560:1712","1440:2560","2560:1440","2912:1248",
 "2880:2880","2560:3200","3200:2560","2448:3264","3264:2448","2336:3504","3504:2336","2160:3840","3840:2160","3840:1648"
]);
const fail=(message,code)=>Object.assign(new Error(message),{code});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function imageDataUri(value){
 if(typeof value!=="string")throw fail("Reference images must be PNG, JPEG or WebP data URIs.","IMAGE_GATEWAY_INVALID_INPUT");
 const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
 if(!match)throw fail("Reference images must be valid PNG, JPEG or WebP data URIs.","IMAGE_GATEWAY_INVALID_INPUT");
 const buffer=Buffer.from(match[2],"base64");
 if(!buffer.length||buffer.length>MAX_REFERENCE_BYTES||buffer.toString("base64").replace(/=+$/,"")!==match[2].replace(/=+$/,""))throw fail("Reference image is invalid or exceeds 5 MiB.","IMAGE_GATEWAY_INVALID_INPUT");
 return {uri:value,bytes:buffer.length};
}
export function buildRunwayImagePayload({model,prompt,ratio="auto",quality="high",reasoningEffort="high",background="auto",referenceImages=[],outputCount=1}={}){
 const id=String(model||"").trim();
 if(!MODELS.has(id))throw fail("Select a verified GPT Image 2.6 model.","IMAGE_GATEWAY_UNSUPPORTED_MODEL");
 const text=typeof prompt==="string"?prompt.trim():"";
 if(!text||text.length>32000)throw fail("GPT Image 2.6 prompts must contain 1 to 32000 characters.","IMAGE_GATEWAY_INVALID_INPUT");
 if(ratio!=="auto"&&!RATIOS.has(ratio))throw fail("ratio must be auto or one of the 30 documented pixel sizes.","IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(!["low","medium","high"].includes(quality))throw fail("quality must be low, medium or high.","IMAGE_GATEWAY_INVALID_INPUT");
 if(!["low","medium","high"].includes(reasoningEffort))throw fail("reasoningEffort must be low, medium or high.","IMAGE_GATEWAY_INVALID_INPUT");
 if(!["auto","opaque","transparent"].includes(background))throw fail("background must be auto, opaque or transparent.","IMAGE_GATEWAY_INVALID_INPUT");
 if(!Number.isSafeInteger(outputCount)||outputCount!==1)throw fail("This workflow adapter currently supports one output per job; multi-output asset fan-out is not enabled yet.","IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(!Array.isArray(referenceImages)||referenceImages.length>16)throw fail("GPT Image 2.6 accepts at most 16 reference images.","IMAGE_GATEWAY_INVALID_INPUT");
 let total=0;
 const refs=referenceImages.map(image=>{const parsed=imageDataUri(image);total+=parsed.bytes;return {uri:parsed.uri};});
 if(total>MAX_REFERENCE_TOTAL_BYTES)throw fail("Combined reference image data exceeds the 32 MiB request budget.","IMAGE_GATEWAY_INVALID_INPUT");
 return Object.freeze({model:id,promptText:text,ratio,quality,reasoningEffort,background,outputCount,referenceImages:refs});
}
async function requestJson(url,{method="GET",headers={},body,timeoutMs=30000,fetchImpl=fetch,submission=false}={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  let response;
  try{response=await fetchImpl(url,{method,headers,body,signal:controller.signal,redirect:"error"});}
  catch(error){throw fail(submission?"Runway image submission outcome is unknown; reconcile before retrying.":error?.name==="AbortError"?"Runway image task request timed out.":"Runway image API is temporarily unavailable.",submission?"IMAGE_GATEWAY_SUBMISSION_UNKNOWN":error?.name==="AbortError"?"IMAGE_GATEWAY_TIMEOUT":"IMAGE_GATEWAY_UNAVAILABLE");}
  const raw=await response.text();
  if(Buffer.byteLength(raw)>2*1024*1024)throw fail("Runway image API returned an oversized response.","IMAGE_GATEWAY_INVALID_RESPONSE");
  let data={};try{data=raw?JSON.parse(raw):{};}catch{throw fail("Runway image API returned invalid JSON.","IMAGE_GATEWAY_INVALID_RESPONSE");}
  if(response.status===429)throw fail("Runway image API rate limit reached.","IMAGE_GATEWAY_RATE_LIMITED");
  if(response.status===401||response.status===403)throw fail("Runway image API key is not authorized.","IMAGE_GATEWAY_ACCESS_DENIED");
  if(response.status>=500)throw fail("Runway image API returned a temporary server error.","IMAGE_GATEWAY_SERVER_ERROR");
  if(!response.ok)throw fail("Runway image API rejected the request (HTTP "+response.status+").","IMAGE_GATEWAY_REQUEST_REJECTED");
  return data;
 }finally{clearTimeout(timer);}
}
function safeOutputUrl(raw){
 let url;try{url=new URL(raw);}catch{throw fail("Runway image task returned an invalid output URL.","IMAGE_GATEWAY_INVALID_RESPONSE");}
 if(url.protocol!=="https:"||!url.hostname.endsWith(".cloudfront.net")||url.username||url.password||url.port||url.hash)throw fail("Runway image task returned an untrusted output host.","IMAGE_GATEWAY_INVALID_RESPONSE");
 return url;
}
async function downloadPng(raw,{fetchImpl=fetch,timeoutMs=60000}={}){
 const url=safeOutputUrl(raw),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  let response;try{response=await fetchImpl(url,{signal:controller.signal,redirect:"error"});}catch(error){throw fail(error?.name==="AbortError"?"Runway image download timed out.":"Runway image could not be downloaded safely.",error?.name==="AbortError"?"IMAGE_GATEWAY_TIMEOUT":"IMAGE_GATEWAY_UNAVAILABLE");}
  if(!response.ok)throw fail("Runway image output download failed.","IMAGE_GATEWAY_INVALID_RESPONSE");
  if(Number(response.headers.get("content-length")||0)>MAX_OUTPUT_BYTES)throw fail("Generated image exceeds the 50 MiB limit.","IMAGE_GATEWAY_INVALID_RESPONSE");
  if(!response.body?.getReader)throw fail("Runway image output cannot be streamed safely.","IMAGE_GATEWAY_INVALID_RESPONSE");
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_OUTPUT_BYTES){await reader.cancel().catch(()=>{});throw fail("Generated image exceeds the 50 MiB limit.","IMAGE_GATEWAY_INVALID_RESPONSE");}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
  const buffer=Buffer.concat(chunks,total),png=Buffer.from([137,80,78,71,13,10,26,10]);
  if(buffer.length<8||!buffer.subarray(0,8).equals(png))throw fail("Runway returned an output that is not a valid PNG signature.","IMAGE_GATEWAY_INVALID_RESPONSE");
  return buffer;
 }finally{clearTimeout(timer);}
}
export async function generateRunwayImage({
 model=process.env.RUNWAY_IMAGE_MODEL||process.env.IMAGE_GATEWAY_MODEL,
 prompt,ratio="auto",quality="high",reasoningEffort="high",background="auto",
 referenceImages=[],outputCount=1,fetchImpl=fetch,sleepImpl=sleep,now=Date.now
}={}){
 if(process.env.IMAGE_GATEWAY_ENABLED!=="true")throw fail("Image generation is disabled by server configuration.","IMAGE_GATEWAY_DISABLED");
 if(process.env.IMAGE_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote image providers are disabled. Review Runway pricing and explicitly enable remote access on the server.","IMAGE_GATEWAY_REMOTE_DISABLED");
 const key=String(process.env.RUNWAY_API_KEY||process.env.RUNWAYML_API_SECRET||"").trim();
 if(!key)throw fail("Configure RUNWAY_API_KEY or RUNWAYML_API_SECRET on the server before using Runway image models.","IMAGE_GATEWAY_CONFIG_INVALID");
 const payload=buildRunwayImagePayload({model,prompt,ratio,quality,reasoningEffort,background,referenceImages,outputCount});
 const headers={authorization:"Bearer "+key,"content-type":"application/json","X-Runway-Version":API_VERSION};
 const submitted=await requestJson(API_BASE+"/text_to_image",{method:"POST",headers,body:JSON.stringify(payload),timeoutMs:30000,fetchImpl,submission:true});
 const taskId=String(submitted.id||"");
 if(!UUID.test(taskId))throw fail("Runway image API did not return a valid task identifier; reconcile the submission before retrying.","IMAGE_GATEWAY_SUBMISSION_UNKNOWN");
 const timeoutMs=Math.max(10000,Math.min(600000,Number(process.env.IMAGE_GATEWAY_TIMEOUT_MS)||300000));
 const deadline=now()+timeoutMs;let task;
 while(now()<deadline){
  task=await requestJson(API_BASE+"/tasks/"+encodeURIComponent(taskId),{headers,timeoutMs:15000,fetchImpl});
  if(task.status==="SUCCEEDED")break;
  if(["FAILED","CANCELED","CANCELLED"].includes(task.status))throw fail("Runway image generation failed. Review the provider task before retrying.","IMAGE_GATEWAY_JOB_FAILED");
  if(!["PENDING","RUNNING","THROTTLED"].includes(task.status))throw fail("Runway returned an unknown image task state.","IMAGE_GATEWAY_INVALID_RESPONSE");
  await sleepImpl(Math.min(5000,Math.max(0,deadline-now())));
 }
 if(!task||task.status!=="SUCCEEDED")throw fail("Runway image task timed out; reconcile its status before retrying.","IMAGE_GATEWAY_TIMEOUT");
 if(!Array.isArray(task.output)||task.output.length!==1||typeof task.output[0]!=="string")throw fail("Runway image task returned an unexpected output collection.","IMAGE_GATEWAY_INVALID_RESPONSE");
 const buffer=await downloadPng(task.output[0],{fetchImpl,timeoutMs:Math.min(60000,Math.max(1000,deadline-now()))});
 const credits=Number(submitted?.estimatedCost?.credits);
 return {buffer,model:String(task.model||payload.model),provider:"runway",taskId,estimatedCostCredits:Number.isFinite(credits)&&credits>=0?credits:null,usage:null,outputFormat:"png"};
}


const ROUTER_ASPECT_RATIOS=new Set(["16:9","9:16","1:1","4:3","3:4","21:9","2:3","3:2","4:5","5:4"]);
function runwayRouterConfig(){
 const slug=String(process.env.RUNWAY_IMAGE_ROUTER_CONFIG||"").trim();
 if(!/^[a-z][a-z0-9_-]{0,63}$/.test(slug))throw fail("Configure a valid saved Runway image Model Router slug.","RUNWAY_ROUTER_CONFIG_INVALID");
 const key=String(process.env.RUNWAY_API_KEY||process.env.RUNWAYML_API_SECRET||"").trim();
 if(!key)throw fail("Configure Runway server credentials before using the image Model Router.","IMAGE_GATEWAY_CONFIG_INVALID");
 if(process.env.IMAGE_GATEWAY_ENABLED!=="true"||process.env.IMAGE_GATEWAY_ALLOW_REMOTE!=="true"||process.env.RUNWAY_IMAGE_ROUTER_ENABLED!=="true")throw fail("Runway image Model Router execution is disabled until all server-side opt-ins are enabled.","IMAGE_GATEWAY_REMOTE_DISABLED");
 return {slug,key,headers:{authorization:"Bearer "+key,"content-type":"application/json","X-Runway-Version":API_VERSION}};
}
function runwayRouterInput({prompt,aspectRatio,resolution,referenceImages=[],outputCount=1}={}){
 const text=typeof prompt==="string"?prompt.trim():"";
 if(!text||text.length>45000)throw fail("Runway routed image prompts must contain 1 to 45000 characters.","IMAGE_GATEWAY_INVALID_INPUT");
 if(!Number.isSafeInteger(outputCount)||outputCount<1||outputCount>4)throw fail("Runway routed image outputCount must be from 1 to 4 for this workflow.","IMAGE_GATEWAY_INVALID_INPUT");
 if(aspectRatio!==undefined&&aspectRatio!==null&&aspectRatio!==""&&aspectRatio!=="auto"&&!ROUTER_ASPECT_RATIOS.has(aspectRatio))throw fail("Runway Model Router aspect ratio is unsupported.","IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
 if(resolution!==undefined&&resolution!==null&&resolution!==""&&!["1k","2k","4k"].includes(String(resolution).toLowerCase()))throw fail("Runway Model Router resolution must be 1k, 2k or 4k.","IMAGE_GATEWAY_INVALID_INPUT");
 if(!Array.isArray(referenceImages)||referenceImages.length>16)throw fail("Runway Model Router accepts at most 16 reference images.","IMAGE_GATEWAY_INVALID_INPUT");
 const refs=referenceImages.map(value=>{
  if(typeof value!=="string"||value.length>7*1024*1024||!(/^https:\/\//i.test(value)||/^runway:\/\//i.test(value)||/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)))throw fail("Runway Model Router references must be valid HTTPS, Runway or image data URIs.","IMAGE_GATEWAY_INVALID_INPUT");
  return {uri:value};
 });
 return {promptText:text,referenceImages:refs,outputCount,...(aspectRatio&&aspectRatio!=="auto"?{aspectRatio}:{}),...(resolution?{resolution:String(resolution).toLowerCase()}: {})};
}
function validateRouterQuote(response,slug){
 if(response?.id)throw fail("Runway image dry-run unexpectedly created a task; quote quarantined.","RUNWAY_ROUTER_DRY_RUN_INVALID");
 const routing=response?.routing,credits=routing?.estimatedCost?.credits;
 if(!routing||routing.configId!==slug||typeof routing.model!=="string"||!routing.model.trim()||typeof routing.provider!=="string"||!routing.provider.trim()||typeof credits!=="number"||!Number.isFinite(credits)||credits<0)throw fail("Runway image dry-run omitted a valid routing decision and estimated credit cost.","RUNWAY_ROUTER_DRY_RUN_INVALID");
 return Object.freeze({billable:false,configId:slug,model:routing.model,provider:routing.provider,estimatedCredits:credits,estimatedUsd:Math.round(credits*0.01*10000)/10000,routing});
}
export async function preflightRunwayRouterImage({prompt,aspectRatio,resolution,referenceImages=[],outputCount=1,fetchImpl=fetch}={}){
 const {slug,headers}=runwayRouterConfig();
 const input=runwayRouterInput({prompt,aspectRatio,resolution,referenceImages,outputCount});
 const response=await requestJson(API_BASE+"/generate/image",{method:"POST",headers,body:JSON.stringify({configId:slug,dryRun:true,input}),timeoutMs:30000,fetchImpl});
 return validateRouterQuote(response,slug);
}
export async function generateRunwayRouterImage({prompt,aspectRatio,resolution,referenceImages=[],outputCount=1,fetchImpl=fetch,sleepImpl=sleep,now=Date.now}={}){
 const {slug,headers}=runwayRouterConfig();
 const input=runwayRouterInput({prompt,aspectRatio,resolution,referenceImages,outputCount});
 const submitted=await requestJson(API_BASE+"/generate/image",{method:"POST",headers,body:JSON.stringify({configId:slug,input}),timeoutMs:30000,fetchImpl,submission:true});
 const taskId=String(submitted.id||"");
 if(!UUID.test(taskId))throw fail("Runway routed image submission omitted a valid task ID; reconcile before retrying.","IMAGE_GATEWAY_SUBMISSION_UNKNOWN");
 const routing=submitted.routing;
 if(!routing||routing.configId!==slug||typeof routing.model!=="string"||!routing.model.trim()||typeof routing.provider!=="string"||!routing.provider.trim())throw fail("Runway routed image response omitted validated routing metadata.","RUNWAY_ROUTER_RESPONSE_INVALID");
 const estimate=Number(submitted.estimatedCost?.credits??routing.estimatedCost?.credits);
 if(!Number.isFinite(estimate)||estimate<0)throw fail("Runway routed image response omitted estimated cost evidence.","RUNWAY_ROUTER_RESPONSE_INVALID");
 const timeoutMs=Math.max(10000,Math.min(600000,Number(process.env.IMAGE_GATEWAY_TIMEOUT_MS)||300000));
 const deadline=now()+timeoutMs;let task;
 while(now()<deadline){
  task=await requestJson(API_BASE+"/tasks/"+encodeURIComponent(taskId),{headers,timeoutMs:15000,fetchImpl});
  if(task.status==="SUCCEEDED")break;
  if(["FAILED","CANCELED","CANCELLED"].includes(task.status))throw fail("Runway routed image generation failed. Review the provider task before retrying.","IMAGE_GATEWAY_JOB_FAILED");
  if(!["PENDING","RUNNING","THROTTLED"].includes(task.status))throw fail("Runway routed image task returned an unknown state.","IMAGE_GATEWAY_INVALID_RESPONSE");
  await sleepImpl(Math.min(5000,Math.max(0,deadline-now())));
 }
 if(!task||task.status!=="SUCCEEDED")throw fail("Runway routed image task timed out; reconcile its status before retrying.","IMAGE_GATEWAY_TIMEOUT");
 if(!Array.isArray(task.output)||task.output.length!==outputCount||task.output.some(value=>typeof value!=="string"))throw fail("Runway routed image task returned an unexpected output count.","IMAGE_GATEWAY_INVALID_RESPONSE");
 const outputs=[];
 for(const [index,url] of task.output.entries())outputs.push({buffer:await downloadPng(url,{fetchImpl,timeoutMs:Math.min(60000,Math.max(1000,deadline-now()))}),outputIndex:index+1});
 const actual=Number(task.cost?.credits);
 return {buffer:outputs[0].buffer,outputs,model:String(task.model||routing.model),provider:"runway",taskId,routeType:"runway-model-router",configId:slug,routing,estimatedCostCredits:estimate,actualCostCredits:Number.isFinite(actual)&&actual>=0?actual:null,usage:null,outputFormat:"png"};
}
