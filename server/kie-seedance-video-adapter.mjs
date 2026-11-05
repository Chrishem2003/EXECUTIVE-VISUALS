import { createKieSeedanceClient } from "./kie-seedance-client.mjs";

const fail=(message,code="KIE_VIDEO_CONFIGURATION_INVALID")=>Object.assign(new Error(message),{code});
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const RATIOS=new Set(["16:9","9:16","1:1","4:3","3:4","21:9","adaptive"]);
const MODELS=Object.freeze({
 "bytedance/seedance-2":{maxImages:9,maxVideos:3,maxAudios:3,maxDuration:15,minDuration:5,resolutions:new Set(["480p","720p","1080p","4K","2160p"])},
 "bytedance/seedance-2-5":{maxImages:30,maxVideos:10,maxAudios:10,maxDuration:30,minDuration:4,resolutions:new Set(["480p","720p","1080p","4K","2160p"])}
});
function safeUrl(value,label){
 if(typeof value!=="string"||value.length>4096)throw fail(label+" must be a bounded HTTPS URL.","KIE_VIDEO_INPUT_INVALID");
 let url;try{url=new URL(value);}catch{throw fail(label+" URL is invalid.","KIE_VIDEO_INPUT_INVALID");}
 if(url.protocol!=="https:"||url.username||url.password||url.port||url.hash||!url.hostname.includes(".")||url.hostname==="localhost"||url.hostname.endsWith(".local")||url.hostname.endsWith(".internal")||url.hostname.endsWith(".test")||url.hostname.endsWith(".invalid")||/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(url.hostname)||url.hostname.startsWith("["))throw fail(label+" must be a credential-free HTTPS URL.","KIE_VIDEO_INPUT_INVALID");
 return url.toString();
}
function boundedUrls(value,max,label){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>max)throw fail(label+" exceeds the model reference limit.","KIE_VIDEO_INPUT_INVALID");
 return value.map((url,index)=>safeUrl(url,label+" "+(index+1)));
}
function buildInput(input,model){
 if(!plain(input))throw fail("Kie Seedance input must be an object.","KIE_VIDEO_INPUT_INVALID");
 const spec=MODELS[model];
 const prompt=typeof input.prompt==="string"?input.prompt.trim():"";
 if(!prompt||prompt.length>30000)throw fail("Seedance prompt must contain 1–30,000 characters.","KIE_VIDEO_INPUT_INVALID");
 const duration=Number(input.durationSeconds??input.duration??5);
 const minDuration=spec.minDuration;
 if(!Number.isInteger(duration)||duration<minDuration||duration>spec.maxDuration)throw fail("Seedance duration is outside the supported range for the selected model.","KIE_VIDEO_INPUT_INVALID");
 const requestedResolution=String(!input.resolution||input.resolution==="provider_default"?"720p":input.resolution);
 if(!spec.resolutions.has(requestedResolution))throw fail("Seedance resolution is unsupported for the selected model.","KIE_VIDEO_INPUT_INVALID");
 const resolution=requestedResolution==="2160p"?"4K":requestedResolution;
 const aspectRatio=String(input.aspectRatio||input.aspect_ratio||"16:9");
 if(!RATIOS.has(aspectRatio))throw fail("Seedance aspect ratio is unsupported.","KIE_VIDEO_INPUT_INVALID");
 const firstFrameUrl=input.firstFrameUrl?safeUrl(input.firstFrameUrl,"First frame"):null;
 const lastFrameUrl=input.lastFrameUrl?safeUrl(input.lastFrameUrl,"Last frame"):null;
 if(lastFrameUrl&&!firstFrameUrl)throw fail("A last frame requires a first frame.","KIE_VIDEO_INPUT_INVALID");
 const referenceImageUrls=boundedUrls(input.referenceImageUrls,spec.maxImages,"Reference images");
 const referenceVideoUrls=boundedUrls(input.referenceVideoUrls,spec.maxVideos,"Reference videos");
 const referenceAudioUrls=boundedUrls(input.referenceAudioUrls,spec.maxAudios,"Reference audio");
 const referenceVideoDurationSeconds=Number(input.referenceVideoDurationSeconds||0);
 const referenceAudioDurationSeconds=Number(input.referenceAudioDurationSeconds||0);
 if(referenceVideoUrls.length&&(!Number.isFinite(referenceVideoDurationSeconds)||referenceVideoDurationSeconds<=0||referenceVideoDurationSeconds>15))throw fail("Reference videos must include verified total duration of 15 seconds or less.","KIE_VIDEO_INPUT_INVALID");
 if(referenceAudioUrls.length&&(!Number.isFinite(referenceAudioDurationSeconds)||referenceAudioDurationSeconds<=0||referenceAudioDurationSeconds>15))throw fail("Reference audio must include verified total duration of 15 seconds or less.","KIE_VIDEO_INPUT_INVALID");
 const hasReferences=referenceImageUrls.length+referenceVideoUrls.length+referenceAudioUrls.length>0;
 if((firstFrameUrl||lastFrameUrl)&&hasReferences)throw fail("First/last-frame mode is mutually exclusive with multimodal reference mode.","KIE_VIDEO_INPUT_MODE_CONFLICT");
 const generateAudio=typeof input.generateAudio==="boolean"?input.generateAudio:input.audioMode!=="none";
 const returnLastFrame=input.returnLastFrame===true;
 const outputFormat=String(input.outputFormat||"mp4");
 if(!["mp4","mov"].includes(outputFormat))throw fail("Seedance output format must be mp4 or mov.","KIE_VIDEO_INPUT_INVALID");
 return Object.freeze({
  prompt,duration,resolution,aspect_ratio:aspectRatio,generate_audio:generateAudio,
  return_last_frame:returnLastFrame,output_format:outputFormat,web_search:false,nsfw_checker:true,
  ...(firstFrameUrl?{first_frame_url:firstFrameUrl}:{}),
  ...(lastFrameUrl?{last_frame_url:lastFrameUrl}:{}),
  ...(referenceImageUrls.length?{reference_image_urls:referenceImageUrls}:{}),
  ...(referenceVideoUrls.length?{reference_video_urls:referenceVideoUrls}:{}),
  ...(referenceAudioUrls.length?{reference_audio_urls:referenceAudioUrls}:{})
 });
}

export function createKieSeedanceVideoAdapter({
 model=process.env.KIE_SEEDANCE_MODEL||"bytedance/seedance-2",
 apiKey=process.env.KIE_API_KEY,
 enabled=process.env.VIDEO_GATEWAY_ENABLED==="true",
 allowRemote=process.env.KIE_VIDEO_ALLOW_REMOTE==="true",
 fetchImpl=globalThis.fetch,
 client,
 prepareInput,
 ingestOutputs,
 resolveActualCost
}={}){
 if(!MODELS[model])throw fail("Kie Seedance adapter supports only exact registered Seedance model IDs.","KIE_MODEL_UNSUPPORTED");
 if(typeof ingestOutputs!=="function"||typeof resolveActualCost!=="function")throw fail("Kie Seedance requires private output ingestion and an authoritative task-level cost resolver.","KIE_EXECUTION_GATES_MISSING");
 const selectedClient=client||createKieSeedanceClient({apiKey,model,fetchImpl});
 if(!selectedClient||selectedClient.model!==model||typeof selectedClient.submit!=="function"||typeof selectedClient.getStatus!=="function")throw fail("Kie Seedance client does not match the exact registered model.","KIE_CLIENT_INVALID");
 const assertEnabled=()=>{
  if(enabled!==true)throw fail("Video generation is disabled by server configuration.","VIDEO_GATEWAY_DISABLED");
  if(allowRemote!==true)throw fail("Kie remote video execution is disabled.","KIE_VIDEO_REMOTE_DISABLED");
 };
 return Object.freeze({
  provider:"kie",model,minimumPollIntervalMs:selectedClient.minimumPollIntervalMs||5000,
  async prepareInput(input,context){
   assertEnabled();
   if(!plain(input)||input.provider!=="kie"||input.model!==model)throw fail("Kie job provider/model identity does not match the registered adapter.","VIDEO_JOB_INPUT_MISMATCH");
   const hasPrivateReferences=Boolean(input.firstFrameAssetId||input.lastFrameAssetId||input.startFrameAssetId||input.endFrameAssetId||input.firstFrameUrl||input.lastFrameUrl||input.startFrame||input.endFrame)||
    ["referenceAssetIds","referenceImageAssetIds","referenceVideoAssetIds","referenceAudioAssetIds","referenceImageUrls","referenceVideoUrls","referenceAudioUrls"].some(key=>Array.isArray(input[key])&&input[key].length>0);
   if(hasPrivateReferences&&typeof prepareInput!=="function")throw fail("Kie reference assets require an authenticated owner/project-scoped resolver.","KIE_VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
   const resolved=typeof prepareInput==="function"?await prepareInput(input,context):input;
   if(!plain(resolved)||resolved.provider!=="kie"||resolved.model!==model)throw fail("Kie private input resolver returned an invalid or mismatched payload.","KIE_VIDEO_INPUT_INVALID");
   return Object.freeze({provider:"kie",model,payload:buildInput(resolved,model)});
  },
  async submit(prepared){
   assertEnabled();
   if(!plain(prepared)||prepared.provider!=="kie"||prepared.model!==model||!plain(prepared.payload))throw fail("Kie prepared payload does not match the exact registered model.","VIDEO_JOB_INPUT_MISMATCH");
   return selectedClient.submit(prepared.payload);
  },
  async getStatus(providerTaskId){
   assertEnabled();
   return selectedClient.getStatus(providerTaskId);
  },
  async ingestOutputs(args){return ingestOutputs({...args,provider:"kie",model});},
  async resolveActualCost(args){return resolveActualCost({...args,provider:"kie",model,creditsConsumed:args?.task?.creditsConsumed??args?.task?.usage?.creditsConsumed??null});}
 });
}
