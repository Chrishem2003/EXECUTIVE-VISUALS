import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executableAvailable } from "./media.mjs";
import { createCloudTimelineApi } from "./cloud-timeline-api.mjs";
import { createCloudMediaWorker } from "./cloud-media-worker.mjs";
import { createCloudTimelineWorker } from "./cloud-timeline-worker.mjs";

const truth=(value)=>value==="true";
const integer=(value,fallback,min,max,label)=>{const parsed=value===undefined||value===""?fallback:Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new Error(label+" is outside the supported range.");return parsed;};

export function readCloudWorkerConfig(env=process.env){
 if(!truth(env.CLOUD_WORKER_ENABLED))throw new Error("Cloud worker process is disabled. Set CLOUD_WORKER_ENABLED=true only after the isolated database and private storage are ready.");
 const media=truth(env.CLOUD_MEDIA_WORKER_ENABLED),timeline=truth(env.CLOUD_TIMELINE_WORKER_ENABLED);
 if(!media&&!timeline)throw new Error("Enable at least one supported cloud worker family.");
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Cloud workers require server-side Supabase credentials.");
 const leaseSeconds=integer(env.CLOUD_WORKER_LEASE_SECONDS,90,30,900,"Cloud worker lease duration");
 const heartbeatIntervalMs=integer(env.CLOUD_WORKER_HEARTBEAT_MS,15000,1000,30000,"Cloud worker heartbeat");
 if(heartbeatIntervalMs>=leaseSeconds*1000)throw new Error("Cloud worker heartbeat must be shorter than the lease duration.");
 return Object.freeze({
  media,timeline,
  pollMs:integer(env.CLOUD_WORKER_POLL_MS,1000,500,10000,"Cloud worker poll interval"),
  leaseSeconds,heartbeatIntervalMs,
  maxBytes:integer(env.CLOUD_WORKER_MAX_BYTES,250*1024*1024,1024,1024*1024*1024,"Cloud worker media limit"),
  tempRoot:resolve(env.CLOUD_WORKER_TEMP_ROOT||tmpdir())
 });
}

export function createCloudWorkerSupervisor({workers,leaseSeconds=90,heartbeatIntervalMs=15000,pollMs=1000,recoveryIntervalMs=60000,healthIntervalMs=60000,onLog=()=>{},onError=()=>{}}={}){
 if(!Array.isArray(workers)||workers.length<1||workers.some(worker=>typeof worker?.runCycle!=="function"||typeof worker?.recoverExpired!=="function"))throw new Error("Cloud worker supervisor requires one or more compatible worker families.");
 if(!Number.isInteger(pollMs)||pollMs<500||pollMs>10000)throw new Error("Cloud worker poll interval is invalid.");
 if(!Number.isInteger(recoveryIntervalMs)||recoveryIntervalMs<10000||recoveryIntervalMs>300000)throw new Error("Cloud worker recovery interval is invalid.");
 if(!Number.isInteger(healthIntervalMs)||healthIntervalMs<10000||healthIntervalMs>300000)throw new Error("Cloud worker health interval is invalid.");
 let stopped=true,timer=null,recoveryTimer=null,healthTimer=null,active=null,busy=false,recoveryActive=null,recoveryBusy=false,cycleController=null;
 const metrics={startedAt:null,lastCycleAt:null,lastRecoveryAt:null,cycles:0,jobsClaimed:0,recoveredJobs:0,cycleErrors:0,recoveryErrors:0,lastErrorAt:null,lastErrorCode:null};
 function snapshot(){return Object.freeze({status:stopped?"stopped":"running",workerFamilies:workers.length,pollMs,leaseSeconds,heartbeatIntervalMs,...metrics,activeCycle:busy,recoveryInProgress:recoveryBusy});}
 function recordError(error,kind){
  metrics.lastErrorAt=new Date().toISOString();
  metrics.lastErrorCode=typeof error?.code==="string"?error.code.slice(0,100):kind.toUpperCase()+"_ERROR";
  if(kind==="cycle")metrics.cycleErrors++;else metrics.recoveryErrors++;
  onError(error);
 }
 async function cycle(){
  if(stopped||busy)return{skipped:true};
  busy=true;cycleController=new AbortController();
  const shutdownSignal=cycleController.signal;
  active=(async()=>{
   const settled=await Promise.allSettled(workers.map(worker=>worker.runCycle({leaseSeconds,heartbeatIntervalMs,signal:shutdownSignal,onEvent:event=>onLog({kind:"event",...event})})));
   const results=settled.map((item,index)=>{
    if(item.status==="rejected"){recordError(item.reason,"cycle");return null;}
    if(item.value?.claimed){metrics.jobsClaimed++;onLog({kind:"cycle",result:item.value,workerIndex:index});}
    return item.value;
   });
   return results;
  })();
  try{return await active;}finally{metrics.cycles++;metrics.lastCycleAt=new Date().toISOString();active=null;busy=false;cycleController=null;}
 }
 async function recover(){
  if(stopped||recoveryBusy)return{skipped:true};
  recoveryBusy=true;
  recoveryActive=(async()=>{
   const settled=await Promise.allSettled(workers.map(worker=>worker.recoverExpired(100)));
   settled.forEach((item,index)=>{
    if(item.status==="rejected"){recordError(item.reason,"recovery");return;}
    if(Number.isInteger(item.value)&&item.value>0){metrics.recoveredJobs+=item.value;onLog({kind:"recovery",count:item.value,workerIndex:index});}
   });
  })();
  try{return await recoveryActive;}finally{metrics.lastRecoveryAt=new Date().toISOString();recoveryActive=null;recoveryBusy=false;}
 }
 return Object.freeze({
  async start(){
   if(!stopped)throw new Error("Cloud worker supervisor is already running.");
   stopped=false;metrics.startedAt=new Date().toISOString();
   await recover();
   if(stopped)return;
   await cycle();
   if(stopped)return;
   timer=setInterval(()=>{void cycle();},pollMs);timer.unref?.();
   recoveryTimer=setInterval(()=>{void recover();},recoveryIntervalMs);recoveryTimer.unref?.();
   healthTimer=setInterval(()=>onLog({kind:"health",snapshot:snapshot()}),healthIntervalMs);healthTimer.unref?.();
   onLog({kind:"started",snapshot:snapshot()});
  },
  async stop(){
   if(stopped)return;
   stopped=true;
   if(timer)clearInterval(timer);if(recoveryTimer)clearInterval(recoveryTimer);if(healthTimer)clearInterval(healthTimer);
   cycleController?.abort(new Error("Cloud worker supervisor is stopping."));
   timer=null;recoveryTimer=null;healthTimer=null;
   if(active)await active.catch(()=>{});
   if(recoveryActive)await recoveryActive.catch(()=>{});
   onLog({kind:"stopped",snapshot:snapshot()});
  },
  async runOnce(){return cycle();},
  snapshot
 });
}

export function registerCloudWorkerShutdownHandlers(supervisor,processLike=process,exit=(code)=>processLike.exit(code)){
 let shutdownPromise=null;
 const shutdown=()=>{
  if(shutdownPromise)return shutdownPromise;
  shutdownPromise=(async()=>{await supervisor.stop();exit(0);})();
  return shutdownPromise;
 };
 processLike.once("SIGINT",shutdown);
 processLike.once("SIGTERM",shutdown);
 return ()=>{processLike.removeListener("SIGINT",shutdown);processLike.removeListener("SIGTERM",shutdown);};
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
 const supervisor=createCloudWorkerSupervisor({
  workers,leaseSeconds:config.leaseSeconds,heartbeatIntervalMs:config.heartbeatIntervalMs,pollMs:config.pollMs,
  onLog:event=>process.stdout.write(JSON.stringify(event)+"\n"),
  onError:error=>process.stderr.write(JSON.stringify({kind:"worker_error",code:error?.code||"WORKER_ERROR",message:String(error?.message||"Worker cycle failed.").slice(0,500)})+"\n")
 });
 const unregisterShutdown=registerCloudWorkerShutdownHandlers(supervisor);
 try {
  // Install handlers before recovery/first-cycle awaits so an OS signal during
  // startup still cancels the worker lifecycle instead of orphaning a child.
  await supervisor.start();
  return supervisor;
 } catch(error) {
  unregisterShutdown();
  throw error;
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 startCloudWorkerProcess().catch(error=>{process.stderr.write("Cloud worker startup failed: "+String(error.message||error)+"\n");process.exitCode=1;});
}
