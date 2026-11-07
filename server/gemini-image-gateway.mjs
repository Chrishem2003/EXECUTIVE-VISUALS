const API_BASE="https://generativelanguage.googleapis.com/v1/models/";
const MODEL="gemini-3-pro-image";
const MODEL_PROFILES=Object.freeze({
 "gemini-3-pro-image":Object.freeze({label:"Nano Banana Pro · Gemini 3 Pro Image",resolutions:["1K","2K","4K"]}),
 "gemini-3.1-flash-image":Object.freeze({label:"Nano Banana 2 · Gemini 3.1 Flash Image",resolutions:["1K","2K","4K"]})
});
const MAX_IMAGE_BYTES=50*1024*1024;
const fail=(message,code)=>Object.assign(new Error(message),{code});
export function listGeminiImageModels(){return Object.entries(MODEL_PROFILES).map(([id,profile])=>({id,label:profile.label,aspectRatios:["1:1","3:2","2:3"],resolutions:[...profile.resolutions],inputModes:["text-to-image","image-to-image"],readiness:"adapter-supported; paid API key and remote opt-in required"}));}
export function buildGeminiImageRequest({model=MODEL,prompt,size="1024x1024",quality="medium",referenceImageDataUrl=""}={}){
 const profile=MODEL_PROFILES[String(model||"").trim()];
 if(!profile)throw fail("Select a verified Gemini image model.","IMAGE_GATEWAY_UNSUPPORTED_MODEL");
 const text=typeof prompt==="string"?prompt.trim():"";
 if(!text||text.length>12000)throw fail("Gemini image prompts must contain 1 to 12000 characters.","IMAGE_GATEWAY_INVALID_INPUT");
 const dimensions={"1024x1024":"1:1","1536x1024":"3:2","1024x1536":"2:3"};
 const aspectRatio=dimensions[size]||"1:1";
 const imageSize=quality==="high"?"2K":"1K";
 if(!profile.resolutions.includes(imageSize))throw fail("The selected image quality is not supported by this model.","IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
 const parts=[{text}];
 if(referenceImageDataUrl){
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(referenceImageDataUrl);
  if(!match)throw fail("Reference image must be a valid PNG, JPEG or WebP data URL.","IMAGE_GATEWAY_INVALID_INPUT");
  const buffer=Buffer.from(match[2],"base64");
  if(!buffer.length||buffer.length>10*1024*1024||buffer.toString("base64").replace(/=+$/,"")!==match[2].replace(/=+$/,""))throw fail("Reference image is invalid or exceeds 10 MiB.","IMAGE_GATEWAY_INVALID_INPUT");
  parts.push({inline_data:{mime_type:match[1],data:match[2]}});
 }
 return {model,body:{contents:[{role:"user",parts}],generationConfig:{responseModalities:["IMAGE"],imageConfig:{aspectRatio,imageSize}}}};
}
export async function generateGeminiImage({prompt,size="1024x1024",quality="medium",referenceImageDataUrl="",model=process.env.GEMINI_IMAGE_MODEL||MODEL,fetchImpl=fetch}={}){
 if(process.env.IMAGE_GATEWAY_ENABLED!=="true")throw fail("Image generation is disabled by server configuration.","IMAGE_GATEWAY_DISABLED");
 if(process.env.IMAGE_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote image generation is disabled. Review provider pricing and explicitly enable remote access on the server.","IMAGE_GATEWAY_REMOTE_DISABLED");
 const key=String(process.env.GEMINI_API_KEY||"").trim();
 if(!key)throw fail("Configure GEMINI_API_KEY on the server before using a Gemini image model.","IMAGE_GATEWAY_CONFIG_INVALID");
 const selected=String(model||process.env.GEMINI_IMAGE_MODEL||MODEL).trim();
 if(!MODEL_PROFILES[selected])throw fail("The configured Gemini image model is not in the verified adapter catalogue.","IMAGE_GATEWAY_UNSUPPORTED_MODEL");
 const request=buildGeminiImageRequest({model:selected,prompt,size,quality,referenceImageDataUrl});
 const timeoutMs=Math.max(1000,Math.min(300000,Number(process.env.IMAGE_GATEWAY_TIMEOUT_MS)||180000));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  let response;
  try{response=await fetchImpl(API_BASE+encodeURIComponent(selected)+":generateContent",{method:"POST",headers:{"x-goog-api-key":key,"content-type":"application/json"},body:JSON.stringify(request.body),signal:controller.signal,redirect:"error"});}
  catch(error){throw fail(error?.name==="AbortError"?"Gemini image request timed out.":"Gemini image API could not be reached.",error?.name==="AbortError"?"IMAGE_GATEWAY_TIMEOUT":"IMAGE_GATEWAY_UNAVAILABLE");}
  const raw=await response.text();
  if(Buffer.byteLength(raw)>75*1024*1024)throw fail("Gemini image response exceeds the 75 MiB transport limit.","IMAGE_GATEWAY_INVALID_RESPONSE");
  let payload;try{payload=raw?JSON.parse(raw):{};}catch{throw fail("Gemini image API returned invalid JSON.","IMAGE_GATEWAY_INVALID_RESPONSE");}
  if(response.status===429)throw fail("Gemini image API rate limit reached.","IMAGE_GATEWAY_RATE_LIMITED");
  if(response.status>=500)throw fail("Gemini image API returned a temporary server error.","IMAGE_GATEWAY_SERVER_ERROR");
  if(!response.ok)throw fail("Gemini image API rejected the request ("+response.status+").","IMAGE_GATEWAY_REQUEST_REJECTED");
  const parts=payload?.candidates?.flatMap(candidate=>candidate?.content?.parts||[])||[];
  const imagePart=parts.find(part=>part?.inlineData?.data||part?.inline_data?.data);
  const encoded=imagePart?.inlineData?.data||imagePart?.inline_data?.data;
  const mimeType=imagePart?.inlineData?.mimeType||imagePart?.inline_data?.mime_type||"image/png";
  if(typeof encoded!=="string"||!encoded||encoded.length>70*1024*1024||!/^image\/(png|jpeg|webp)$/.test(mimeType))throw fail("Gemini did not return a supported image payload.","IMAGE_GATEWAY_INVALID_RESPONSE");
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw fail("Gemini returned malformed image data.","IMAGE_GATEWAY_INVALID_RESPONSE");
  const buffer=Buffer.from(encoded,"base64");
  if(!buffer.length||buffer.length>MAX_IMAGE_BYTES||buffer.toString("base64").replace(/=+$/,"")!==encoded.replace(/=+$/,""))throw fail("Generated image failed binary validation or exceeds the 50 MiB limit.","IMAGE_GATEWAY_INVALID_RESPONSE");
  const usage=payload.usageMetadata?{inputTokens:Number(payload.usageMetadata.promptTokenCount)||0,outputTokens:Number(payload.usageMetadata.candidatesTokenCount)||0,totalTokens:Number(payload.usageMetadata.totalTokenCount)||0}:null;
  return {buffer,model:selected,usage};
 }finally{clearTimeout(timer);}
}
