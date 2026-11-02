const fail=(message,code)=>Object.assign(new Error(message),{code});
const loopbacks=new Set(["localhost","127.0.0.1","::1","[::1]"]);
const MAX_AUDIO_BYTES=50*1024*1024;
export async function generateVoice({text,voice,format="mp3",speed=1}={}){
 if(process.env.VOICE_GATEWAY_ENABLED!=="true")throw fail("Voice generation is disabled by server configuration.","VOICE_GATEWAY_DISABLED");
 const rawUrl=String(process.env.VOICE_GATEWAY_URL||"").trim(),model=String(process.env.VOICE_GATEWAY_MODEL||"").trim();
 if(!rawUrl||!model)throw fail("Configure the server-side voice gateway URL and model before running this node.","VOICE_GATEWAY_CONFIG_INVALID");
 let base;try{base=new URL(rawUrl)}catch{throw fail("The configured voice gateway URL is invalid.","VOICE_GATEWAY_CONFIG_INVALID")}
 if(base.username||base.password||base.search||base.hash)throw fail("The voice gateway URL must not contain credentials, query parameters or fragments.","VOICE_GATEWAY_CONFIG_INVALID");
 const local=loopbacks.has(base.hostname.toLowerCase());
 if(base.protocol!=="https:"&&!local)throw fail("Non-local voice gateways must use HTTPS.","VOICE_GATEWAY_INSECURE_URL");
 if(!local&&process.env.VOICE_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote voice gateways are disabled. Verify provider pricing and explicitly enable remote access on the server.","VOICE_GATEWAY_REMOTE_DISABLED");
 const prefix=base.pathname.endsWith("/")?base.pathname:base.pathname+"/";
 const endpoint=new URL(prefix+"audio/speech",base.origin);
 const script=String(text||"").trim().slice(0,12000);
 if(!script)throw fail("Voice generation requires a non-empty script.","SCRIPT_REQUIRED");
 const voiceName=String(voice||process.env.VOICE_GATEWAY_VOICE||"alloy").trim().slice(0,100);
 if(!/^[a-zA-Z0-9_.-]+$/.test(voiceName))throw fail("The configured voice identifier is invalid.","VOICE_GATEWAY_CONFIG_INVALID");
 const outputFormat=["mp3","wav","flac","ogg"].includes(format)?format:"mp3";
 const timeoutMs=Math.max(1000,Math.min(300000,Number(process.env.VOICE_GATEWAY_TIMEOUT_MS)||120000));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const headers={"content-type":"application/json"};
 const key=String(process.env.VOICE_GATEWAY_API_KEY||"").trim();if(key)headers.authorization="Bearer "+key;
 try{
  let response;try{response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify({model,input:script,voice:voiceName,response_format:outputFormat,speed:Math.max(0.5,Math.min(2,Number(speed)||1))}),signal:controller.signal,redirect:"error"})}
  catch(error){throw fail(error?.name==="AbortError"?"Voice gateway request timed out.":"Voice gateway could not be reached.",error?.name==="AbortError"?"VOICE_GATEWAY_TIMEOUT":"VOICE_GATEWAY_UNAVAILABLE")}
  if(response.status===429)throw fail("Voice gateway rate limit reached.","VOICE_GATEWAY_RATE_LIMITED");
  if(response.status>=500)throw fail("Voice gateway returned a temporary server error.","VOICE_GATEWAY_SERVER_ERROR");
  if(!response.ok)throw fail("Voice gateway rejected the request ("+response.status+").","VOICE_GATEWAY_REQUEST_REJECTED");
  const declared=Number(response.headers.get("content-length")||0);
  if(declared>MAX_AUDIO_BYTES)throw fail("Generated audio exceeds the 50 MiB limit.","VOICE_GATEWAY_INVALID_RESPONSE");
  if(!response.body?.getReader)throw fail("Voice gateway response cannot be streamed safely.","VOICE_GATEWAY_INVALID_RESPONSE");
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_AUDIO_BYTES){await reader.cancel().catch(()=>{});throw fail("Generated audio exceeds the 50 MiB limit.","VOICE_GATEWAY_INVALID_RESPONSE")}chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}
  const buffer=Buffer.concat(chunks,total);
  if(!buffer.length)throw fail("Voice gateway returned empty audio.","VOICE_GATEWAY_INVALID_RESPONSE");
  const type=String(response.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
  const signature=buffer.length>=12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WAVE"
   ?"wav":buffer.length>=3&&buffer[0]===0x49&&buffer[1]===0x44&&buffer[2]===0x33||buffer.length>=2&&buffer[0]===0xff&&(buffer[1]&0xe0)===0xe0
   ?"mp3":buffer.length>=4&&buffer.toString("ascii",0,4)==="fLaC"?"flac":buffer.length>=4&&buffer.toString("ascii",0,4)==="OggS"?"ogg":null;
  const allowed={"audio/mpeg":"mp3","audio/mp3":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/flac":"flac","audio/ogg":"ogg","application/octet-stream":outputFormat};
  if(!signature||!(signature===allowed[type]||type==="application/octet-stream"&&signature===outputFormat))throw fail("Voice gateway returned an unsupported or mismatched audio format.","VOICE_GATEWAY_INVALID_RESPONSE");
  const mimeType=signature==="mp3"?"audio/mpeg":signature==="wav"?"audio/wav":signature==="flac"?"audio/flac":"audio/ogg";
  return {buffer,model,voice:voiceName,mimeType,format:signature,usage:null};
 }finally{clearTimeout(timer)}
}


/**
 * Transcribe an existing, owner-authorized audio asset through the same
 * server-side speech gateway used for narration. Transcript text is returned
 * to the workflow executor and persisted in its immutable node-run output.
 */
export async function transcribeVoice({buffer,mimeType,filename="source-audio",language}={}){
 if(process.env.VOICE_TRANSCRIPTION_ENABLED!=="true")throw fail("Audio transcription is disabled by server configuration.","VOICE_TRANSCRIPTION_DISABLED");
 if(process.env.VOICE_GATEWAY_ENABLED!=="true")throw fail("The speech gateway is disabled by server configuration.","VOICE_GATEWAY_DISABLED");
 if(!Buffer.isBuffer(buffer)||buffer.length<4||buffer.length>MAX_AUDIO_BYTES)throw fail("Transcription requires a valid audio asset no larger than 50 MiB.","VOICE_TRANSCRIPTION_INVALID_INPUT");
 const accepted=new Set(["audio/mpeg","audio/mp3","audio/wav","audio/x-wav","audio/flac","audio/ogg","audio/mp4","audio/aac","audio/webm"]);
 if(!accepted.has(String(mimeType||"").toLowerCase()))throw fail("The source asset format is not supported for transcription.","VOICE_TRANSCRIPTION_INVALID_INPUT");
 const signature=buffer.subarray(0,3).toString("ascii")==="ID3"||buffer[0]===0xff&&(buffer[1]&0xe0)===0xe0
  ?"mp3":buffer.length>=12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WAVE"
  ?"wav":buffer.subarray(0,4).toString("ascii")==="fLaC"?"flac":buffer.subarray(0,4).toString("ascii")==="OggS"?"ogg"
  :buffer.length>=8&&buffer.toString("ascii",4,8)==="ftyp"?"mp4":buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))?"webm":null;
 if(!signature)throw fail("The source audio failed binary signature validation.","VOICE_TRANSCRIPTION_INVALID_INPUT");
 const rawUrl=String(process.env.VOICE_GATEWAY_URL||"").trim(),model=String(process.env.VOICE_TRANSCRIPTION_MODEL||process.env.VOICE_GATEWAY_MODEL||"").trim();
 if(!rawUrl||!model)throw fail("Configure the server-side transcription gateway URL and model before running this node.","VOICE_GATEWAY_CONFIG_INVALID");
 let base;try{base=new URL(rawUrl)}catch{throw fail("The configured voice gateway URL is invalid.","VOICE_GATEWAY_CONFIG_INVALID")}
 if(base.username||base.password||base.search||base.hash)throw fail("The voice gateway URL must not contain credentials, query parameters or fragments.","VOICE_GATEWAY_CONFIG_INVALID");
 const local=loopbacks.has(base.hostname.toLowerCase());
 if(base.protocol!=="https:"&&!local)throw fail("Non-local voice gateways must use HTTPS.","VOICE_GATEWAY_INSECURE_URL");
 if(!local&&process.env.VOICE_GATEWAY_ALLOW_REMOTE!=="true")throw fail("Remote voice gateways are disabled. Verify provider pricing and explicitly enable remote access on the server.","VOICE_GATEWAY_REMOTE_DISABLED");
 const prefix=base.pathname.endsWith("/")?base.pathname:base.pathname+"/";
 const endpoint=new URL(prefix+"audio/transcriptions",base.origin);
 const timeoutMs=Math.max(1000,Math.min(300000,Number(process.env.VOICE_GATEWAY_TIMEOUT_MS)||120000));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 const form=new FormData();
 const safeFilename=String(filename||"source-audio").replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,100)||"source-audio";
 form.append("file",new Blob([buffer],{type:mimeType}),safeFilename);
 form.append("model",model);
 form.append("response_format","verbose_json");
 if(typeof language==="string"&&/^[a-zA-Z-]{2,12}$/.test(language))form.append("language",language);
 const headers={};const key=String(process.env.VOICE_GATEWAY_API_KEY||"").trim();if(key)headers.authorization="Bearer "+key;
 try{
  let response;try{response=await fetch(endpoint,{method:"POST",headers,body:form,signal:controller.signal,redirect:"error"})}
  catch(error){throw fail(error?.name==="AbortError"?"Transcription request timed out.":"Transcription gateway could not be reached.",error?.name==="AbortError"?"VOICE_TRANSCRIPTION_TIMEOUT":"VOICE_TRANSCRIPTION_UNAVAILABLE")}
  if(response.status===429)throw fail("Transcription gateway rate limit reached.","VOICE_TRANSCRIPTION_RATE_LIMITED");
  if(response.status>=500)throw fail("Transcription gateway returned a temporary server error.","VOICE_TRANSCRIPTION_SERVER_ERROR");
  if(!response.ok)throw fail("Transcription gateway rejected the request ("+response.status+").","VOICE_TRANSCRIPTION_REQUEST_REJECTED");
  const declared=Number(response.headers.get("content-length")||0);
  if(declared>2*1024*1024)throw fail("Transcription response exceeds the 2 MiB limit.","VOICE_TRANSCRIPTION_INVALID_RESPONSE");
  const raw=await response.text();if(Buffer.byteLength(raw,"utf8")>2*1024*1024)throw fail("Transcription response exceeds the 2 MiB limit.","VOICE_TRANSCRIPTION_INVALID_RESPONSE");
  let payload;try{payload=JSON.parse(raw)}catch{throw fail("Transcription gateway returned invalid JSON.","VOICE_TRANSCRIPTION_INVALID_RESPONSE")}
  const text=String(payload.text||"").trim();
  if(!text||text.length>1000000)throw fail("Transcription gateway returned an empty or oversized transcript.","VOICE_TRANSCRIPTION_INVALID_RESPONSE");
  const segments=Array.isArray(payload.segments)?payload.segments.slice(0,20000).map(segment=>({start:Number(segment.start)||0,end:Number(segment.end)||0,text:String(segment.text||"").slice(0,4000)})).filter(segment=>segment.end>=segment.start):[];
  return {text,language:String(payload.language||language||"").slice(0,32),duration:Number.isFinite(Number(payload.duration))?Number(payload.duration):null,segments,model,usage:null};
 }finally{clearTimeout(timer)}
}
