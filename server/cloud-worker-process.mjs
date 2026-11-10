import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executableAvailable } from "./media.mjs";
import { createCloudTimelineApi } from "./cloud-timeline-api.mjs";
import { createCloudMediaWorker } from "./cloud-media-worker.mjs";
import { createCloudTimelineWorker } from "./cloud-timeline-worker.mjs";
import { createCloudVideoGenerationWorker } from "./cloud-video-generation-worker.mjs";

const truth=(value)=>value==="true";
const integer=(value,fallback,min,max,label)=>{const parsed=value===undefined||value===""?fallback:Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new Error(label+" is outside the supported range.");return parsed;};

export function readCloudWorkerConfig(env=process.env){
 if(!truth(env.CLOUD_WORKER_ENABLED))throw new Error("Cloud worker process is disabled. Set CLOUD_WORKER_ENABLED=true only after the isolated database and private storage are ready.");
 const media=truth(env.CLOUD_MEDIA_WORKER_ENABLED),timeline=truth(env.CLOUD_TIMELINE_WORKER_ENABLED),video=truth(env.CLOUD_VIDEO_GENERATION_WORKER_ENABLED);
 if(!media&&!timeline&&!video)throw new Error("Enable at least one supported cloud worker family.");
 if(video&&(!truth(env.VIDEO_GATEWAY_ENABLED)||!truth(env.VIDEO_GATEWAY_ALLOW_REMOTE)||!String(env.RUNWAYML_API_SECRET||"").trim()))throw new Error("Cloud video generation requires VIDEO_GATEWAY_ENABLED=true, VIDEO_GATEWAY_ALLOW_REMOTE=true and a server-side RUNWAYML_API_SECRET.");
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Cloud workers require server-side Supabase credentials.");
 const leaseSeconds=integer(env.CLOUD_WORKER_LEASE_SECONDS,90,30,900,"Cloud worker lease duration");
 const heartbeatIntervalMs=integer(env.CLOUD_WORKER_HEARTBEAT_MS,15000,1000,30000,"Cloud worker heartbeat");
 if(heartbeatIntervalMs>=leaseSeconds*1000)throw new Error("Cloud worker heartbeat must be shorter than the lease duration.");
 return Object.freeze({
  media,timeline,video,
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
  try{
   const count=await workers[0].recoverExpired(100);
   if(count)onLog({kind:"recovery",count});
   if(typeof workers[0].reconcileStorageCleanup==="function"){
    const cleanup=await workers[0].reconcileStorageCleanup(20);
    if(cleanup?.examined)onLog({kind:"storage_cleanup",...cleanup});
   }
  }catch(error){onError(error);}
 }
 return Object.freeze({
  async start(){
   if(!stopped)throw new Error("Cloud worker supervisor is already running.");
   stopped=false;
   await recover();
   // A termination signal may arrive while startup recovery is awaiting the
   // database. Do not create timers or claim work after stop() wins that race.
   if(stopped)return;
   // Start the first poll without blocking process startup on a long render.
   // This lets the process install SIGINT/SIGTERM handlers before a job can
   // occupy the worker for its full execution duration.
   void cycle();
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
 if((config.media||config.timeline)&&(!executableAvailable("ffmpeg")||!executableAvailable("ffprobe")))throw new Error("Cloud media workers require FFmpeg and FFprobe on PATH.");
 const cloudCredentials={url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY};
 const readiness=createCloudTimelineApi({...cloudCredentials,maxUploadBytes:config.maxBytes});
 await readiness.checkReadiness();
 const workers=[];
 if(config.media)workers.push(createCloudMediaWorker({workerId:"media-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes}));
 if(config.timeline)workers.push(createCloudTimelineWorker({workerId:"timeline-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes,maxOutputBytes:config.maxBytes}));
 if(config.video)workers.push(createCloudVideoGenerationWorker({workerId:"video-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes,timeoutMs:30000}));
 const supervisor=createCloudWorkerSupervisor({
  workers,leaseSeconds:config.leaseSeconds,heartbeatIntervalMs:config.heartbeatIntervalMs,pollMs:config.pollMs,
  onLog:event=>process.stdout.write(JSON.stringify(event)+"\n"),
  onError:error=>process.stderr.write(JSON.stringify({kind:"worker_error",code:error?.code||"WORKER_ERROR",message:String(error?.message||"Worker cycle failed.").slice(0,500)})+"\n")
 });
 let shuttingDown=false;
 const shutdown=async()=>{
  if(shuttingDown)return;
  shuttingDown=true;
  await supervisor.stop();
 };
 // Install handlers before start(): startup recovery and the first poll must
 // not leave a window where termination bypasses graceful shutdown.
 process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
 try{await supervisor.start();}
 catch(error){process.removeListener("SIGINT",shutdown);process.removeListener("SIGTERM",shutdown);throw error;}
 return supervisor;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 startCloudWorkerProcess().catch(error=>{process.stderr.write("Cloud worker startup failed: "+String(error.message||error)+"\n");process.exitCode=1;});
}
