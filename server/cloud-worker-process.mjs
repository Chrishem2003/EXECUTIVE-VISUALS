import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executableAvailable } from "./media.mjs";
import { createCloudTimelineApi } from "./cloud-timeline-api.mjs";
import { createCloudMediaWorker } from "./cloud-media-worker.mjs";
import { createCloudTimelineWorker } from "./cloud-timeline-worker.mjs";
import { createCloudVideoWorkerComposition } from "./cloud-video-worker-composition.mjs";

const truth=(value)=>value==="true";
const integer=(value,fallback,min,max,label)=>{const parsed=value===undefined||value===""?fallback:Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new Error(label+" is outside the supported range.");return parsed;};

export function readCloudWorkerConfig(env=process.env){
 if(!truth(env.CLOUD_WORKER_ENABLED))throw new Error("Cloud worker process is disabled. Set CLOUD_WORKER_ENABLED=true only after the isolated database and private storage are ready.");
 const media=truth(env.CLOUD_MEDIA_WORKER_ENABLED),timeline=truth(env.CLOUD_TIMELINE_WORKER_ENABLED),video=truth(env.CLOUD_VIDEO_WORKER_ENABLED);
 if(!media&&!timeline&&!video)throw new Error("Enable at least one supported cloud worker family.");
 if(video){
  if(env.RUNWAY_VIDEO_ENABLED!=="true"||env.RUNWAY_VIDEO_ALLOW_REMOTE!=="true"||!env.RUNWAY_API_KEY)throw new Error("Cloud video requires explicit Runway remote-execution opt-in and a server-side API key.");
  const hosts=String(env.RUNWAY_VIDEO_OUTPUT_HOSTS||"").split(",").map(host=>host.trim()).filter(Boolean);
  if(hosts.length<1||hosts.length>100||hosts.some(host=>! /^[a-z0-9.-]{1,253}$/i.test(host)||host.startsWith(".")||host.endsWith(".")))throw new Error("Cloud video requires an explicit exact-host RUNWAY_VIDEO_OUTPUT_HOSTS allowlist.");
 }
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Cloud workers require server-side Supabase credentials.");
 const leaseSeconds=integer(env.CLOUD_WORKER_LEASE_SECONDS,90,30,900,"Cloud worker lease duration");
 const heartbeatIntervalMs=integer(env.CLOUD_WORKER_HEARTBEAT_MS,15000,1000,30000,"Cloud worker heartbeat");
 if(heartbeatIntervalMs>=leaseSeconds*1000)throw new Error("Cloud worker heartbeat must be shorter than the lease duration.");
 return Object.freeze({
  media,timeline,video,
  outputHosts:video?Object.freeze(String(env.RUNWAY_VIDEO_OUTPUT_HOSTS).split(",").map(host=>host.trim()).filter(Boolean)):Object.freeze([]),
  pollMs:integer(env.CLOUD_WORKER_POLL_MS,1000,500,10000,"Cloud worker poll interval"),
  leaseSeconds,heartbeatIntervalMs,
  maxBytes:integer(env.CLOUD_WORKER_MAX_BYTES,250*1024*1024,1024,1024*1024*1024,"Cloud worker media limit"),
  tempRoot:resolve(env.CLOUD_WORKER_TEMP_ROOT||tmpdir())
 });
}

export function createCloudWorkerSupervisor({workers,leaseSeconds=90,heartbeatIntervalMs=15000,pollMs=1000,recoveryIntervalMs=60000,onLog=()=>{},onError=()=>{}}={}){
 if(!Array.isArray(workers)||workers.length<1||workers.some(worker=>typeof worker?.runCycle!=="function"||typeof worker?.recoverExpired!=="function"))throw new Error("Cloud worker supervisor requires one or more compatible worker families.");
 if(!Number.isInteger(pollMs)||pollMs<500||pollMs>10000)throw new Error("Cloud worker poll interval is invalid.");
 if(!Number.isInteger(recoveryIntervalMs)||recoveryIntervalMs<10000||recoveryIntervalMs>300000)throw new Error("Cloud worker recovery interval is invalid.");
 let stopped=true,timer=null,recoveryTimer=null,active=null,busy=false;
 async function cycle(){
  if(stopped||busy)return{skipped:true};
  busy=true;
  active=(async()=>{
   const settled=await Promise.allSettled(workers.map(worker=>worker.runCycle({leaseSeconds,heartbeatIntervalMs,onEvent:event=>onLog({kind:"event",...event})})));
   const results=settled.map((item,index)=>{
    if(item.status==="rejected"){onError(item.reason);return null;}
    if(item.value?.claimed)onLog({kind:"cycle",result:item.value,workerIndex:index});
    return item.value;
   });
   return results;
  })();
  try{return await active;}finally{active=null;busy=false;}
 }
 async function recover(){
  if(stopped)return;
  const settled=await Promise.allSettled(workers.map(worker=>worker.recoverExpired(100)));
  let total=0;
  for(const item of settled){
   if(item.status==="rejected"){onError(item.reason);continue;}
   if(Number.isInteger(item.value)&&item.value>0)total+=item.value;
  }
  if(total)onLog({kind:"recovery",count:total});
 }
 return Object.freeze({
  async start(){
   if(!stopped)throw new Error("Cloud worker supervisor is already running.");
   stopped=false;
   await recover();
   await cycle();
   timer=setInterval(()=>{void cycle();},pollMs);timer.unref?.();
   recoveryTimer=setInterval(()=>{void recover();},recoveryIntervalMs);recoveryTimer.unref?.();
   onLog({kind:"started",workerFamilies:workers.length,pollMs,leaseSeconds});
  },
  async stop(){
   if(stopped)return;
   stopped=true;
   if(timer)clearInterval(timer);if(recoveryTimer)clearInterval(recoveryTimer);
   timer=null;recoveryTimer=null;
   if(active)await active.catch(()=>{});
   onLog({kind:"stopped"});
  },
  async runOnce(){return cycle();}
 });
}

export async function startCloudWorkerProcess(env=process.env){
 const config=readCloudWorkerConfig(env);
 if((config.media||config.timeline)&&!executableAvailable("ffmpeg"))throw new Error("Cloud media and timeline workers require FFmpeg on PATH.");
 if((config.media||config.timeline||config.video)&&!executableAvailable("ffprobe"))throw new Error("Cloud workers require FFprobe on PATH.");
 const cloudCredentials={url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY};
 const readiness=createCloudTimelineApi({...cloudCredentials,maxUploadBytes:config.maxBytes});
 await readiness.checkReadiness();
 const workers=[];
 if(config.media)workers.push(createCloudMediaWorker({workerId:"media-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes}));
 if(config.timeline)workers.push(createCloudTimelineWorker({workerId:"timeline-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes,maxOutputBytes:config.maxBytes}));
 if(config.video)workers.push(createCloudVideoWorkerComposition({
  env,workerId:"video-"+randomUUID(),tempRoot:config.tempRoot,maxBytes:config.maxBytes,outputHosts:config.outputHosts
 }));
 const supervisor=createCloudWorkerSupervisor({
  workers,leaseSeconds:config.leaseSeconds,heartbeatIntervalMs:config.heartbeatIntervalMs,pollMs:config.pollMs,
  onLog:event=>process.stdout.write(JSON.stringify(event)+"\n"),
  onError:error=>process.stderr.write(JSON.stringify({kind:"worker_error",code:error?.code||"WORKER_ERROR",message:String(error?.message||"Worker cycle failed.").slice(0,500)})+"\n")
 });
 await supervisor.start();
 const shutdown=async()=>{await supervisor.stop();process.exit(0);};
 process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
 return supervisor;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 startCloudWorkerProcess().catch(error=>{process.stderr.write("Cloud worker startup failed: "+String(error.message||error)+"\n");process.exitCode=1;});
}
