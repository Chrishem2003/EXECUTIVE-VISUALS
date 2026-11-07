import { generateFalImage } from "./fal-image-gateway.mjs";
import { generateGeminiImage } from "./gemini-image-gateway.mjs";
const loopbacks=new Set(["localhost","127.0.0.1","::1","[::1]"]);
export async function generateImage({prompt,size="1024x1024",quality="medium",referenceImageDataUrl="",model=""}={}){
 const provider=String(process.env.IMAGE_GATEWAY_PROVIDER||"openai-compatible").trim().toLowerCase();
 if(provider==="fal")return generateFalImage({prompt,size,quality,referenceImageDataUrl});
 if(provider==="gemini")return generateGeminiImage({prompt,size,quality,referenceImageDataUrl,model:model||process.env.GEMINI_IMAGE_MODEL});
 if(provider!=="openai-compatible")throw Object.assign(new Error("The configured image provider is not supported."),{code:"IMAGE_GATEWAY_CONFIG_INVALID"});
 if(referenceImageDataUrl)throw Object.assign(new Error("Reference-conditioned image generation requires a configured model-specific reference input field."),{code:"IMAGE_GATEWAY_UNSUPPORTED_INPUT"});
 if(process.env.IMAGE_GATEWAY_ENABLED!=="true")throw Object.assign(new Error("Image generation is disabled by server configuration."),{code:"IMAGE_GATEWAY_DISABLED"});
 const rawUrl=String(process.env.IMAGE_GATEWAY_URL||"").trim(),model=String(process.env.IMAGE_GATEWAY_MODEL||"").trim();
 if(!rawUrl||!model)throw Object.assign(new Error("Configure the server-side image gateway URL and model before running this node."),{code:"IMAGE_GATEWAY_CONFIG_INVALID"});
 let base;try{base=new URL(rawUrl);}catch{throw Object.assign(new Error("The configured image gateway URL is invalid."),{code:"IMAGE_GATEWAY_CONFIG_INVALID"});}
 if(base.username||base.password||base.search||base.hash)throw Object.assign(new Error("The image gateway URL must not contain credentials, query parameters or fragments."),{code:"IMAGE_GATEWAY_CONFIG_INVALID"});
 const local=loopbacks.has(base.hostname.toLowerCase());
 if(base.protocol!=="https:"&&!local)throw Object.assign(new Error("Non-local image gateways must use HTTPS."),{code:"IMAGE_GATEWAY_INSECURE_URL"});
 if(!local&&process.env.IMAGE_GATEWAY_ALLOW_REMOTE!=="true")throw Object.assign(new Error("Remote image gateways are disabled. Verify provider pricing and explicitly enable remote access on the server."),{code:"IMAGE_GATEWAY_REMOTE_DISABLED"});
 const prefix=base.pathname.endsWith("/")?base.pathname:base.pathname+"/";
 const endpoint=new URL(prefix+"images/generations",base.origin);
 const timeoutMs=Math.max(1000,Math.min(300000,Number(process.env.IMAGE_GATEWAY_TIMEOUT_MS)||180000));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const headers={"content-type":"application/json"};
 const key=String(process.env.IMAGE_GATEWAY_API_KEY||"").trim();if(key)headers.authorization="Bearer "+key;
 const allowedSizes=new Set(["512x512","1024x1024","1536x1024","1024x1536"]);
 const allowedQualities=new Set(["low","medium","high"]);
 const request={model,prompt:String(prompt||"").slice(0,20000),size:allowedSizes.has(size)?size:"1024x1024",quality:allowedQualities.has(quality)?quality:"medium",n:1,response_format:"b64_json"};
 if(!request.prompt.trim()){clearTimeout(timer);throw Object.assign(new Error("Image generation requires a non-empty prompt."),{code:"PROMPT_REQUIRED"});}
 try{
  let response;
  try{response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(request),signal:controller.signal,redirect:"error"});}
  catch(error){if(error?.name==="AbortError")throw Object.assign(new Error("Image gateway request timed out."),{code:"IMAGE_GATEWAY_TIMEOUT"});throw Object.assign(new Error("Image gateway could not be reached."),{code:"IMAGE_GATEWAY_UNAVAILABLE"});}
  if(response.status===429)throw Object.assign(new Error("Image gateway rate limit reached."),{code:"IMAGE_GATEWAY_RATE_LIMITED"});
  if(response.status>=500)throw Object.assign(new Error("Image gateway returned a temporary server error ("+response.status+")."),{code:"IMAGE_GATEWAY_SERVER_ERROR"});
  if(!response.ok)throw Object.assign(new Error("Image gateway rejected the request ("+response.status+")."),{code:"IMAGE_GATEWAY_REQUEST_REJECTED"});
  const declaredLength=Number(response.headers.get("content-length")||0);
  if(declaredLength>75*1024*1024)throw Object.assign(new Error("Image gateway response exceeds the 75 MiB transport limit."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});
  let raw;try{raw=await response.text();}catch{throw Object.assign(new Error("Image gateway returned an unreadable response."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});}
  if(Buffer.byteLength(raw,"utf8")>75*1024*1024)throw Object.assign(new Error("Image gateway response exceeds the 75 MiB transport limit."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});
  let payload;try{payload=JSON.parse(raw);}catch{throw Object.assign(new Error("Image gateway returned an invalid response."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});}
  const encoded=payload?.data?.[0]?.b64_json;
  if(typeof encoded!=="string"||encoded.length===0||encoded.length>70*1024*1024)throw Object.assign(new Error("Image gateway did not return a supported base64 image payload."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Object.assign(new Error("Image gateway returned malformed base64 data."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});
  const buffer=Buffer.from(encoded,"base64");
  if(buffer.length===0||buffer.length>50*1024*1024||buffer.toString("base64").replace(/=+$/,"")!==encoded.replace(/=+$/,""))throw Object.assign(new Error("Image output failed binary validation or exceeds the 50 MiB limit."),{code:"IMAGE_GATEWAY_INVALID_RESPONSE"});
  const usage=payload.usage?{inputTokens:Number(payload.usage.prompt_tokens)||0,outputTokens:Number(payload.usage.completion_tokens)||0,totalTokens:Number(payload.usage.total_tokens)||0}:null;
  return {buffer,model:String(payload.model||model),usage};
 }finally{clearTimeout(timer);}
}
