import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat, readFile, readdir, utimes, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep, join } from "node:path";

const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const VERSION="waveform-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/i;

function run(executable,args,{timeoutMs=45000,maxOutput=8192}={}){
 return new Promise((resolvePromise,reject)=>{
  const child=spawn(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
  let stdout="",stderr="",settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolvePromise(value);};
  child.stdout.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-maxOutput);});
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-maxOutput);});
  child.on("error",error=>finish(Object.assign(new Error("Waveform media tool could not start."),{code:"WAVEFORM_TOOL_UNAVAILABLE",cause:error})));
  child.on("close",code=>code===0?finish(null,stdout.trim()):finish(Object.assign(new Error("Waveform media processing failed."),{code:"WAVEFORM_PROCESS_FAILED",detail:stderr.slice(-1000)})));
  const timer=setTimeout(()=>{child.kill("SIGKILL");finish(Object.assign(new Error("Waveform media processing timed out."),{code:"WAVEFORM_TIMEOUT"}));},timeoutMs);
 });
}

export function createWaveformCache({mediaRoot,ffmpegPath=process.env.FFMPEG_PATH||"ffmpeg",ffprobePath=process.env.FFPROBE_PATH||"ffprobe",render=null,maxSourceBytes=250*1024*1024,maxDurationSeconds=7200,timeoutMs=45000,maxCacheBytes=512*1024*1024,maxCacheAgeMs=30*24*60*60*1000,maxTempAgeMs=60*60*1000}={}){
 if(typeof mediaRoot!=="string"||!mediaRoot)throw new Error("Waveform cache requires a media root.");
 if(!Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<1||!Number.isFinite(maxDurationSeconds)||maxDurationSeconds<=0||!Number.isSafeInteger(maxCacheBytes)||maxCacheBytes<1||!Number.isFinite(maxCacheAgeMs)||maxCacheAgeMs<0||!Number.isFinite(maxTempAgeMs)||maxTempAgeMs<0)throw new Error("Waveform cache limits are invalid.");
 const root=resolve(mediaRoot),cacheRoot=resolve(root,"derived","waveforms"),pending=new Map();
 const inside=(base,path)=>{const rel=relative(base,path);return rel!==""&&!rel.startsWith(".."+sep)&&rel!==".."&&!isAbsolute(rel);};
 async function prune({preserve=[]}={}){
  await mkdir(cacheRoot,{recursive:true});
  const now=Date.now(),keep=new Set(preserve.map(path=>resolve(path))),entries=[];
  for(const name of await readdir(cacheRoot)){
   if(!/^(?:[a-f0-9]{64}\.png|\.[a-f0-9]{64}\.[0-9]+\.[a-f0-9]+\.tmp\.png)$/i.test(name))continue;
   const path=join(cacheRoot,name),info=await stat(path).catch(()=>null);
   if(!info?.isFile())continue;
   const temporary=name.endsWith(".tmp.png");
   if(temporary){if(now-info.mtimeMs>maxTempAgeMs)await rm(path,{force:true}).catch(()=>{});continue;}
   entries.push({path,size:info.size,mtimeMs:info.mtimeMs});
  }
  let total=entries.reduce((sum,item)=>sum+item.size,0),removed=0;
  entries.sort((a,b)=>a.mtimeMs-b.mtimeMs);
  for(const item of entries){
   const expired=now-item.mtimeMs>maxCacheAgeMs,overBudget=total>maxCacheBytes;
   if((expired||overBudget)&&!keep.has(item.path)){
    await rm(item.path,{force:true});total-=item.size;removed++;
   }
  }
  return{entries:entries.length,bytes:total,removed,maxBytes:maxCacheBytes,maxAgeMs:maxCacheAgeMs};
 }
 async function generate(sourcePath,tempPath){
  const durationText=await run(ffprobePath,["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",sourcePath],{timeoutMs:Math.min(timeoutMs,15000)});
  const duration=Number(durationText);
  if(!Number.isFinite(duration)||duration<=0)throw Object.assign(new Error("Audio duration could not be determined."),{code:"WAVEFORM_INVALID_DURATION"});
  if(duration>maxDurationSeconds)throw Object.assign(new Error("Audio exceeds the 2-hour waveform generation limit."),{code:"WAVEFORM_DURATION_LIMIT"});
  await run(ffmpegPath,["-hide_banner","-loglevel","error","-nostdin","-y","-i",sourcePath,"-t",String(maxDurationSeconds),"-filter_complex","[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1200x80:colors=white:scale=lin:draw=full[wave]","-map","[wave]","-frames:v","1","-f","image2","-vcodec","png",tempPath],{timeoutMs});
 }
 async function get(asset,sourcePathOverride=null){
  if(!asset||typeof asset.id!=="string"||!UUID.test(asset.id)||!SHA.test(String(asset.sha256||"")))throw Object.assign(new Error("Waveform asset identity is invalid."),{code:"WAVEFORM_INVALID_ASSET"});
  if(!String(asset.media_type||asset.mediaType||"").startsWith("audio/"))throw Object.assign(new Error("Waveforms are available only for audio assets."),{code:"WAVEFORM_UNSUPPORTED_MEDIA"});
  const relativePath=asset.storage_path||asset.storagePath;
  if(sourcePathOverride===null&&(typeof relativePath!=="string"||!relativePath))throw Object.assign(new Error("Audio source path is unavailable."),{code:"WAVEFORM_SOURCE_MISSING"});
  const candidatePath=sourcePathOverride===null?resolve(root,relativePath):resolve(String(sourcePathOverride));
  if(!inside(root,candidatePath))throw Object.assign(new Error("Audio source path is outside managed media storage."),{code:"WAVEFORM_INVALID_PATH"});
  const [rootReal,sourcePath]=await Promise.all([realpath(root),realpath(candidatePath).catch(()=>null)]);
  if(!sourcePath||!inside(rootReal,sourcePath))throw Object.assign(new Error("Audio source path resolves outside managed media storage."),{code:"WAVEFORM_INVALID_PATH"});
  const source=await stat(sourcePath).catch(()=>null);
  if(!source?.isFile())throw Object.assign(new Error("Audio source is not available in managed storage."),{code:"WAVEFORM_SOURCE_MISSING"});
  if(source.size>maxSourceBytes||Number(asset.byte_size??asset.size??source.size)>maxSourceBytes)throw Object.assign(new Error("Audio source exceeds the waveform processing size limit."),{code:"WAVEFORM_SIZE_LIMIT"});
  const key=createHash("sha256").update(VERSION+":"+asset.sha256).digest("hex");
  const output=join(cacheRoot,key+".png");
  const cached=await stat(output).catch(()=>null);
  if(cached?.isFile()&&cached.size>PNG.length&&cached.size<=2*1024*1024){
   const bytes=await readFile(output);
   if(bytes.subarray(0,8).equals(PNG)){const now=new Date();await utimes(output,now,now);return output;}
   await rm(output,{force:true});
  }
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
   await prune();
   await mkdir(cacheRoot,{recursive:true});
   const temp=join(cacheRoot,"."+key+"."+process.pid+"."+Math.random().toString(16).slice(2)+".tmp.png");
   try{
    if(render)await render({sourcePath,outputPath:temp,asset});
    else await generate(sourcePath,temp);
    const info=await stat(temp);
    if(!info.isFile()||info.size<=PNG.length||info.size>2*1024*1024)throw Object.assign(new Error("Generated waveform image failed size validation."),{code:"WAVEFORM_INVALID_OUTPUT"});
    const header=await readFile(temp);
    if(!header.subarray(0,8).equals(PNG))throw Object.assign(new Error("Generated waveform is not a PNG image."),{code:"WAVEFORM_INVALID_OUTPUT"});
    await rename(temp,output);
    await prune({preserve:[output]});
    return output;
   }finally{await rm(temp,{force:true}).catch(()=>{});}
  })();
  pending.set(key,task);
  try{return await task;}finally{pending.delete(key);}
 }
 return Object.freeze({get,prune,cacheRoot});
}
