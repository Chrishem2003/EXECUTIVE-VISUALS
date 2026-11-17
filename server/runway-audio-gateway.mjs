import { uploadRunwayEphemeralAsset } from "./runway-video-gateway.mjs";

const API="https://api.dev.runwayml.com/v1";
const VERSION="2024-11-06";
const MAX_AUDIO_BYTES=200*1024*1024;
const MAX_OUTPUT_BYTES=100*1024*1024;
const fail=(message,code)=>Object.assign(new Error(message),{code});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function config(){
 if(process.env.RUNWAY_AUDIO_ENABLED!=="true")throw fail("Runway audio processing is disabled by server configuration.","RUNWAY_AUDIO_DISABLED");
 if(process.env.RUNWAY_AUDIO_ALLOW_REMOTE!=="true")throw fail("Remote audio processing requires explicit administrator opt-in after reviewing provider pricing and data handling.","RUNWAY_AUDIO_REMOTE_DISABLED");
 const key=String(process.env.RUNWAYML_API_SECRET||"").trim();
 if(!key)throw fail("Configure RUNWAYML_API_SECRET on the server before using Runway audio processing.","RUNWAY_AUDIO_CONFIG_INVALID");
 return {authorization:"Bearer "+key,"content-type":"application/json","X-Runway-Version":VERSION};
}
async function jsonRequest(url,{method="GET",headers,body,fetchImpl=fetch}={}){
 let response;try{response=await fetchImpl(url,{method,headers,body:body?JSON.stringify(body):undefined,redirect:"error",signal:AbortSignal.timeout(30000)});}catch(error){throw fail(error?.name==="TimeoutError"?"Runway audio request timed out.":"Runway audio API could not be reached.","RUNWAY_AUDIO_UNAVAILABLE");}
 if(response.status===429)throw fail("Runway audio rate limit reached.","RUNWAY_AUDIO_RATE_LIMITED");
 if(response.status>=500)throw fail("Runway audio API returned a temporary server error.","RUNWAY_AUDIO_SERVER_ERROR");
 if(!response.ok)throw fail("Runway audio API rejected the request ("+response.status+").","RUNWAY_AUDIO_REQUEST_REJECTED");
 let payload;try{payload=await response.json();}catch{throw fail("Runway audio API returned invalid JSON.","RUNWAY_AUDIO_INVALID_RESPONSE");}
 return payload;
}
function safeAudioUrl(value){
 let url;try{url=new URL(value);}catch{throw fail("Runway audio task returned an invalid output URL.","RUNWAY_AUDIO_INVALID_RESPONSE");}
 if(url.protocol!=="https:"||!url.hostname.endsWith(".cloudfront.net")||url.username||url.password||url.port||url.hash)throw fail("Runway audio task returned an untrusted output host.","RUNWAY_AUDIO_INVALID_RESPONSE");
 return url;
}
async function downloadAudio(url,{fetchImpl=fetch}={}){
 const safe=safeAudioUrl(url);let response;
 try{response=await fetchImpl(safe,{redirect:"error",signal:AbortSignal.timeout(60000)});}catch{throw fail("Runway audio output could not be downloaded safely.","RUNWAY_AUDIO_UNAVAILABLE");}
 if(!response.ok)throw fail("Runway audio output download failed.","RUNWAY_AUDIO_INVALID_RESPONSE");
 const size=Number(response.headers.get("content-length")||0);
 if(size>MAX_OUTPUT_BYTES)throw fail("Runway audio output exceeds the 100 MiB limit.","RUNWAY_AUDIO_INVALID_RESPONSE");
 if(!response.body?.getReader)throw fail("Runway audio output cannot be streamed safely.","RUNWAY_AUDIO_INVALID_RESPONSE");
 const reader=response.body.getReader(),chunks=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_OUTPUT_BYTES){await reader.cancel().catch(()=>{});throw fail("Runway audio output exceeds the 100 MiB limit.","RUNWAY_AUDIO_INVALID_RESPONSE");}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 const buffer=Buffer.concat(chunks,total);
 if(buffer.length<128)throw fail("Runway returned an empty or invalid audio output.","RUNWAY_AUDIO_INVALID_RESPONSE");
 return buffer;
}
export function buildRunwayAudioPayload({operation,audioUri,targetLang,disableVoiceCloning=false,dropBackgroundAudio=false,numSpeakers}={}){
 if(typeof audioUri!=="string"||!/^runway:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,4980}$/.test(audioUri))throw fail("Audio input must be an authorized Runway ephemeral upload URI.","RUNWAY_AUDIO_INVALID_INPUT");
 if(operation==="isolate")return {model:"eleven_voice_isolation",audioUri};
 if(operation==="dub"){
  const language=String(targetLang||"").trim().toLowerCase();
  const supported=new Set(["en","hi","pt","zh","es","fr","de","ja","ar","ru","ko","id","it","nl","tr","pl","sv","fil","ms","ro","uk","el","cs","da","fi","bg","hr","sk","ta"]);
  if(!supported.has(language))throw fail("Choose one of the supported Runway dubbing language codes.","RUNWAY_AUDIO_INVALID_INPUT");
  if(numSpeakers!==undefined&&(!Number.isInteger(numSpeakers)||numSpeakers<1||numSpeakers>20))throw fail("Speaker count must be between 1 and 20.","RUNWAY_AUDIO_INVALID_INPUT");
  return {model:"eleven_voice_dubbing",audioUri,targetLang:language,disableVoiceCloning:Boolean(disableVoiceCloning),dropBackgroundAudio:Boolean(dropBackgroundAudio),...(numSpeakers?{numSpeakers}:{})};
 }
 throw fail("Unsupported Runway audio operation.","RUNWAY_AUDIO_INVALID_INPUT");
}
export async function processRunwayAudio({operation,buffer,filename,mimeType,targetLang,disableVoiceCloning=false,dropBackgroundAudio=false,numSpeakers,fetchImpl=fetch,sleepImpl=sleep,timeoutMs=15*60*1000,now=Date.now}={}){
 if(!Buffer.isBuffer(buffer)||buffer.length<512||buffer.length>MAX_AUDIO_BYTES)throw fail("Audio input must be between 512 bytes and 200 MiB.","RUNWAY_AUDIO_INVALID_INPUT");
 const headers=config();
 const uploaded=await uploadRunwayEphemeralAsset({buffer,filename,mimeType,fetchImpl});
 const payload=buildRunwayAudioPayload({operation,audioUri:uploaded.runwayUri,targetLang,disableVoiceCloning,dropBackgroundAudio,numSpeakers});
 const endpoint=operation==="isolate"?"voice_isolation":"voice_dubbing";
 const submitted=await jsonRequest(API+"/"+endpoint,{method:"POST",headers,body:payload,fetchImpl});
 const taskId=String(submitted.id||"");
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId))throw fail("Runway did not return a valid audio task identifier.","RUNWAY_AUDIO_INVALID_RESPONSE");
 const deadline=now()+timeoutMs;let task;
 while(now()<deadline){
  task=await jsonRequest(API+"/tasks/"+encodeURIComponent(taskId),{headers,fetchImpl});
  const status=String(task.status||"").toUpperCase();
  if(status==="SUCCEEDED")break;
  if(["FAILED","CANCELLED","CANCELED"].includes(status))throw fail("Runway audio task "+status.toLowerCase()+": "+String(task.failure||task.error||"No provider details supplied.").slice(0,500),"RUNWAY_AUDIO_JOB_FAILED");
  await sleepImpl(Math.min(5000,Math.max(1000,Number(task.progress)?1000:2500)));
 }
 if(String(task?.status||"").toUpperCase()!=="SUCCEEDED")throw fail("Runway audio task exceeded its execution timeout.","RUNWAY_AUDIO_TIMEOUT");
 const output=Array.isArray(task.output)?task.output[0]:null;
 if(typeof output!=="string")throw fail("Runway audio task completed without an output file.","RUNWAY_AUDIO_INVALID_RESPONSE");
 const result=await downloadAudio(output,{fetchImpl});
 return {buffer:result,model:String(task.model||payload.model),provider:"runway",requestId:taskId,usage:null,estimatedCostCredits:submitted.estimatedCost?.credits??null,mimeType:"audio/mpeg",filename:operation==="dub"?"dubbed-audio.mp3":"isolated-voice.mp3",adapterVersion:"runway-audio-gateway-v1"};
}
