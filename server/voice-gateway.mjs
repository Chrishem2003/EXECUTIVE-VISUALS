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
