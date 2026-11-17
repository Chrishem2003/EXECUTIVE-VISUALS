import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executableAvailable } from "./media.mjs";
import { createCloudTimelineApi } from "./cloud-timeline-api.mjs";
import { createCloudMediaWorker } from "./cloud-media-worker.mjs";
import { createCloudTimelineWorker } from "./cloud-timeline-worker.mjs";
import { createProviderAwareCloudVideoWorkerComposition } from "./cloud-video-provider-worker-composition.mjs";
import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudVideoSubmissionLedger } from "./cloud-video-submissions.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createGoogleVideoInteractionRepository } from "./google-video-interaction-repository.mjs";
import { createGoogleOmniWorkerDependencies } from "./google-omni-worker-dependencies.mjs";
import { createCloudAssetRepository } from "./cloud-assets.mjs";
import { createCloudStorage } from "./cloud-storage.mjs";
import { createCloudPublicationCleanupWorker } from "./cloud-publication-cleanup-worker.mjs";
import { createGoogleGeminiFilesComposition } from "./google-gemini-files-composition.mjs";
import { createGoogleGeminiFilesRepository } from "./google-gemini-files-repository.mjs";
import { createGoogleGeminiFilesRetentionWorker } from "./google-gemini-files-retention-worker.mjs";
import { createGoogleGeminiFilesRecoveryWorker } from "./google-gemini-files-recovery-worker.mjs";
import { createGoogleGeminiGcsMirrorBootstrap } from "./google-gemini-gcs-mirror-bootstrap.mjs";

const truth=(value)=>value==="true";
const integer=(value,fallback,min,max,label)=>{const parsed=value===undefined||value===""?fallback:Number(value);if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw new Error(label+" is outside the supported range.");return parsed;};

export function readCloudWorkerConfig(env=process.env){
 if(!truth(env.CLOUD_WORKER_ENABLED))throw new Error("Cloud worker process is disabled. Set CLOUD_WORKER_ENABLED=true only after the isolated database and private storage are ready.");
 const media=truth(env.CLOUD_MEDIA_WORKER_ENABLED),timeline=truth(env.CLOUD_TIMELINE_WORKER_ENABLED),video=truth(env.CLOUD_VIDEO_WORKER_ENABLED),publicationCleanup=truth(env.CLOUD_PUBLICATION_CLEANUP_WORKER_ENABLED),geminiFilesCleanup=truth(env.GOOGLE_GEMINI_FILES_CLEANUP_ENABLED),geminiFilesRecovery=truth(env.GOOGLE_GEMINI_FILES_RECOVERY_ENABLED);
 if(!media&&!timeline&&!video&&!publicationCleanup&&!geminiFilesCleanup&&!geminiFilesRecovery)throw new Error("Enable at least one supported cloud worker family or maintenance task.");
 let googleOmni=false,luma=false;
 if(video){
  if(env.VIDEO_GATEWAY_ENABLED!=="true"||env.VIDEO_GATEWAY_ALLOW_REMOTE!=="true")throw new Error("Cloud video worker requires both explicit remote-execution gates.");
  const falConfigured=Boolean(env.FAL_VIDEO_MODEL&&env.FAL_KEY&&env.FAL_BILLING_KEY);
  const runwayRouterConfigured=env.RUNWAY_MODEL_ROUTER_ENABLED==="true"&&env.RUNWAY_VIDEO_ALLOW_REMOTE==="true"&&
   /^[a-z][a-z0-9_-]{0,63}$/.test(String(env.RUNWAY_VIDEO_ROUTER_CONFIG||""))&&Boolean(env.RUNWAY_API_KEY||env.RUNWAYML_API_SECRET);
  const googleOmniRequested=["GOOGLE_OMNI_VIDEO_ENABLED","GOOGLE_OMNI_VIDEO_ALLOW_REMOTE","GEMINI_OMNI_ENABLED","GEMINI_OMNI_ALLOW_REMOTE","GEMINI_OMNI_PAID_TIER_CONFIRMED","GEMINI_OMNI_WORKER_ENABLED"].some(key=>truth(env[key]));
  googleOmni=env.GOOGLE_OMNI_VIDEO_ENABLED==="true"&&env.GOOGLE_OMNI_VIDEO_ALLOW_REMOTE==="true"&&
   env.GEMINI_OMNI_ENABLED==="true"&&env.GEMINI_OMNI_ALLOW_REMOTE==="true"&&
   env.GEMINI_OMNI_PAID_TIER_CONFIRMED==="true"&&env.GEMINI_OMNI_WORKER_ENABLED==="true"&&
   env.GOOGLE_OMNI_CONNECTION_STATUS==="connected"&&Boolean(env.GEMINI_API_KEY||env.GOOGLE_GEMINI_API_KEY);
  if(googleOmniRequested&&!googleOmni)throw new Error("Google Omni requires all provider, transport, paid-tier, hosted-worker and verified-connection gates plus a server-side API key.");

  // Luma's worker adapter is implemented, but its actual-cost settlement must
  // use the operator's account/contract credit rate—not the public list price.
  const lumaRequested=truth(env.LUMA_VIDEO_ENABLED)||truth(env.LUMA_VIDEO_ALLOW_REMOTE);
  const lumaRate=String(env.LUMA_USD_PER_CREDIT||"").trim();
  const lumaRateValid=/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(lumaRate)&&Number(lumaRate)>0&&Number(lumaRate)<=1000;
  luma=truth(env.LUMA_VIDEO_ENABLED)&&truth(env.LUMA_VIDEO_ALLOW_REMOTE)&&
   Boolean(env.LUMA_AGENTS_API_KEY)&&lumaRateValid;
  if(lumaRequested&&!luma)throw new Error("Luma requires both remote gates, a server-side LUMA_AGENTS_API_KEY and an explicit positive LUMA_USD_PER_CREDIT account/contract rate.");
  const directRunwayModels=String(env.RUNWAY_VIDEO_MODELS||"").split(",").map(value=>value.trim()).filter(Boolean);
  const directRunwayRequested=directRunwayModels.length>0;
  const directRunwayVeoOnly=directRunwayModels.every(model=>model==="veo3.1"||model==="veo3.1_fast");
  const directRunwayConfigured=directRunwayRequested&&directRunwayVeoOnly&&
   env.RUNWAY_VIDEO_ALLOW_REMOTE==="true"&&env.RUNWAY_WORKSPACE_USAGE_ENABLED==="true"&&
   Boolean(env.RUNWAY_API_KEY||env.RUNWAYML_API_SECRET);
  if(directRunwayRequested&&!directRunwayConfigured)throw new Error("Direct Runway Veo requires both remote gates, a server API key and linked-workspace per-generation usage reconciliation; other direct Runway profiles still require a separately integrated task-level resolver.");
  if(!falConfigured&&!runwayRouterConfigured&&!googleOmni&&!luma&&!directRunwayConfigured)throw new Error("Cloud video worker requires a fully configured FAL adapter, an explicitly enabled Runway Model Router with a saved config, gated Google Omni, configured Luma, or verified direct Veo task billing.");
  if(!String(env.CLOUD_VIDEO_OUTPUT_HOSTS||"").trim())throw new Error("Cloud video worker requires an explicit output-host allowlist.");
 }
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Cloud workers require server-side Supabase credentials.");
 const leaseSeconds=integer(env.CLOUD_WORKER_LEASE_SECONDS,90,30,900,"Cloud worker lease duration");
 const heartbeatIntervalMs=integer(env.CLOUD_WORKER_HEARTBEAT_MS,15000,1000,30000,"Cloud worker heartbeat");
 if(heartbeatIntervalMs>=leaseSeconds*1000)throw new Error("Cloud worker heartbeat must be shorter than the lease duration.");
 return Object.freeze({
  media,timeline,video,googleOmni,luma,publicationCleanup,geminiFilesCleanup,geminiFilesRecovery,
  cleanupDryRun:!truth(env.CLOUD_PUBLICATION_CLEANUP_DELETE_ENABLED),
  cleanupConfirmDelete:truth(env.CLOUD_PUBLICATION_CLEANUP_CONFIRM_DELETE),
  cleanupOlderThanMs:integer(env.CLOUD_PUBLICATION_CLEANUP_OLDER_THAN_DAYS,1,1,30,"Publication cleanup age in days")*24*60*60*1000,
  cleanupPublicationLimit:integer(env.CLOUD_PUBLICATION_CLEANUP_PUBLICATION_LIMIT,10,1,50,"Publication cleanup publication limit"),
  cleanupObjectLimit:integer(env.CLOUD_PUBLICATION_CLEANUP_OBJECT_LIMIT,100,1,100,"Publication cleanup object limit"),
  cleanupPollIntervalMs:integer(env.CLOUD_PUBLICATION_CLEANUP_POLL_MS,300000,10000,3600000,"Publication cleanup poll interval"),
  pollMs:integer(env.CLOUD_WORKER_POLL_MS,1000,500,10000,"Cloud worker poll interval"),
  leaseSeconds,heartbeatIntervalMs,
  cleanupIntervalMs:integer(env.CLOUD_STORAGE_CLEANUP_INTERVAL_MS,300000,60000,3600000,"Cloud storage cleanup interval"),
  maxBytes:integer(env.CLOUD_WORKER_MAX_BYTES,250*1024*1024,1024,1024*1024*1024,"Cloud worker media limit"),
  tempRoot:resolve(env.CLOUD_WORKER_TEMP_ROOT||tmpdir())
 });
}

export function createCloudWorkerSupervisor({workers,maintenanceTasks=[],maintenanceIntervalMs=300000,leaseSeconds=90,heartbeatIntervalMs=15000,pollMs=1000,recoveryIntervalMs=60000,onLog=()=>{},onError=()=>{}}={}){
 if(!Array.isArray(workers)||workers.some(worker=>typeof worker?.runCycle!=="function"||typeof worker?.recoverExpired!=="function"))throw new Error("Cloud worker supervisor requires compatible worker families.");
 if(!Number.isInteger(pollMs)||pollMs<500||pollMs>10000)throw new Error("Cloud worker poll interval is invalid.");
 if(!Number.isInteger(recoveryIntervalMs)||recoveryIntervalMs<10000||recoveryIntervalMs>300000)throw new Error("Cloud worker recovery interval is invalid.");
 if(!Array.isArray(maintenanceTasks)||maintenanceTasks.some(task=>typeof task!=="function"))throw new Error("Cloud worker maintenance tasks must be functions.");
 if(!Number.isInteger(maintenanceIntervalMs)||maintenanceIntervalMs<60000||maintenanceIntervalMs>3600000)throw new Error("Cloud worker maintenance interval is invalid.");
 if(workers.length===0&&maintenanceTasks.length===0)throw new Error("Cloud worker supervisor requires at least one worker family or maintenance task.");
 let stopped=true,timer=null,recoveryTimer=null,maintenanceTimer=null,active=null,activeMaintenance=null,busy=false,maintenanceBusy=false;
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
 async function maintain(){
  if(stopped||maintenanceBusy||maintenanceTasks.length===0)return{skipped:true};
  maintenanceBusy=true;
  activeMaintenance=(async()=>{
   const settled=await Promise.allSettled(maintenanceTasks.map(task=>task()));
   return settled.map((item,index)=>{
    if(item.status==="rejected"){onError(item.reason);return null;}
    onLog({kind:"maintenance",taskIndex:index,result:item.value});
    return item.value;
   });
  })();
  try{return await activeMaintenance;}finally{activeMaintenance=null;maintenanceBusy=false;}
 }
 async function recover(){
  if(stopped)return;
  const settled=await Promise.allSettled(workers.map(worker=>worker.recoverExpired(100)));
  for(const item of settled){
   if(item.status==="rejected")onError(item.reason);
   else if(item.value)onLog({kind:"recovery",count:item.value});
  }
 }
 return Object.freeze({
  async start(){
   if(!stopped)throw new Error("Cloud worker supervisor is already running.");
   stopped=false;
   await recover();
   await maintain();
   await cycle();
   timer=setInterval(()=>{void cycle();},pollMs);timer.unref?.();
   recoveryTimer=setInterval(()=>{void recover();},recoveryIntervalMs);recoveryTimer.unref?.();
   if(maintenanceTasks.length){maintenanceTimer=setInterval(()=>{void maintain();},maintenanceIntervalMs);maintenanceTimer.unref?.();}
   onLog({kind:"started",workerFamilies:workers.length,pollMs,leaseSeconds,maintenanceTasks:maintenanceTasks.length,maintenanceIntervalMs});
  },
  async stop(){
   if(stopped)return;
   stopped=true;
   if(timer)clearInterval(timer);if(recoveryTimer)clearInterval(recoveryTimer);if(maintenanceTimer)clearInterval(maintenanceTimer);
   timer=null;recoveryTimer=null;maintenanceTimer=null;
   if(active)await active.catch(()=>{});
   if(activeMaintenance)await activeMaintenance.catch(()=>{});
   onLog({kind:"stopped"});
  },
  async runOnce(){return cycle();}
 });
}

export async function createGoogleGeminiGcsMirrorRecoveryMaintenanceTask({
 env=process.env,cloudCredentials={},fetchImpl=globalThis.fetch,
 createBootstrap=createGoogleGeminiGcsMirrorBootstrap,maxBytes=250*1024*1024
}={}){
 if(typeof createBootstrap!=="function")throw new TypeError("GCS recovery bootstrap factory is required.");
 const bootstrap=await createBootstrap({env,fetchImpl});
 if(typeof bootstrap?.checkIdentity!=="function"||typeof bootstrap?.createService!=="function"){
  throw new Error("GCS mirror bootstrap must expose identity verification and a service factory.");
 }
 const identity=await bootstrap.checkIdentity();
 if(identity?.ready!==true)throw new Error("GCS mirror workload identity verification did not confirm readiness.");
 const service=bootstrap.createService({...cloudCredentials,env,fetchImpl,maxBytes});
 if(!service||typeof service.recoverMirrorAttempts!=="function"){
  throw new Error("GCS mirror service must expose recoverMirrorAttempts.");
 }
 return Object.freeze({run:()=>service.recoverMirrorAttempts({limit:100})});
}

export async function startCloudWorkerProcess(env=process.env){
 const config=readCloudWorkerConfig(env);
 if((config.media||config.timeline||config.video)&&(!executableAvailable("ffmpeg")||!executableAvailable("ffprobe")) )throw new Error("Cloud media workers require FFmpeg and FFprobe on PATH.");
 const cloudCredentials={url:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY};
 if(config.media||config.timeline||config.video){const readiness=createCloudTimelineApi({...cloudCredentials,maxUploadBytes:config.maxBytes,env});await readiness.checkReadiness();}
 const workers=[];
 if(config.media)workers.push(createCloudMediaWorker({workerId:"media-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes}));
 if(config.timeline)workers.push(createCloudTimelineWorker({workerId:"timeline-"+randomUUID(),...cloudCredentials,tempRoot:config.tempRoot,maxBytes:config.maxBytes,maxOutputBytes:config.maxBytes}));
 if(config.video){
  let providerDependencies={};
  if(config.googleOmni){
   const googleAssets=createCloudAssetService({...cloudCredentials,maxBytes:config.maxBytes});
   const googleFiles=createGoogleGeminiFilesComposition({...cloudCredentials,env,fetchImpl:globalThis.fetch,maxBytes:config.maxBytes});
   const googleQueue=createCloudQueue(cloudCredentials);
   const googleLedger=createCloudVideoSubmissionLedger(cloudCredentials);
   const googleInteractions=createGoogleVideoInteractionRepository({...cloudCredentials,timeoutMs:30000});
   const googlePolicy=createGoogleOmniWorkerDependencies({
    ...cloudCredentials,env,fetchImpl:globalThis.fetch,queue:googleQueue,ledger:googleLedger,
    interactions:googleInteractions,assets:googleAssets.assets,filesGateway:googleFiles
   });
   providerDependencies={
    googleOmniAssertApprovedSubmission:googlePolicy.assertApprovedSubmission,
    googleOmniAuthorizeInteraction:googlePolicy.authorizeInteraction,
    googleOmniPreparePlan:googlePolicy.preparePlan,
    googleOmniAssertConnection:googlePolicy.assertConnection,
    googleOmniInteractions:googleInteractions
   };
  }
  workers.push(createProviderAwareCloudVideoWorkerComposition({
   workerId:"video-"+randomUUID(),...cloudCredentials,env,providerDependencies,
   allowedOutputHosts:String(env.CLOUD_VIDEO_OUTPUT_HOSTS).split(",").map(value=>value.trim()).filter(Boolean),
   timeoutMs:integer(env.CLOUD_VIDEO_PROVIDER_TIMEOUT_MS,30000,1000,120000,"Cloud video provider timeout"),
   maxBytesPerOutput:config.maxBytes,maxTotalBytes:config.maxBytes
  }));
 }
 if(config.publicationCleanup){
  const cleanupWorker=createCloudPublicationCleanupWorker({
   ...cloudCredentials,
   olderThanMs:config.cleanupOlderThanMs,
   publicationLimit:config.cleanupPublicationLimit,
   objectLimit:config.cleanupObjectLimit,
   pollIntervalMs:config.cleanupPollIntervalMs,
   dryRun:config.cleanupDryRun,
   confirmDelete:config.cleanupConfirmDelete,
   allowDelete:truth(env.CLOUD_PUBLICATION_CLEANUP_DELETE_ENABLED),
   onLog:event=>process.stdout.write(JSON.stringify(event)+"\\n")
  });
  await cleanupWorker.checkReadiness();
  workers.push(cleanupWorker);
 }
 const storage=createCloudStorage({...cloudCredentials,maxBytes:config.maxBytes});
 const assetRepository=createCloudAssetRepository({...cloudCredentials,storage,authorize:async()=>false});
 const maintenanceTasks=[async()=>assetRepository.reconcilePendingStorageCleanup({limit:100})];
 const gcsMirrorRecoveryEnabled=truth(env.GEMINI_GCS_MIRROR_RECOVERY_ENABLED);
 if(gcsMirrorRecoveryEnabled){
  const task=await createGoogleGeminiGcsMirrorRecoveryMaintenanceTask({
   env,cloudCredentials,fetchImpl:globalThis.fetch,maxBytes:config.maxBytes
  });
  maintenanceTasks.push(()=>task.run());
 }
 const geminiFilesCleanupEnabled=truth(env.GOOGLE_GEMINI_FILES_CLEANUP_ENABLED);
 const geminiFilesRecoveryEnabled=truth(env.GOOGLE_GEMINI_FILES_RECOVERY_ENABLED);
 if(geminiFilesCleanupEnabled||geminiFilesRecoveryEnabled){
  if(!String(env.GEMINI_API_KEY||env.GOOGLE_GEMINI_API_KEY||"").trim()){
   throw new Error("Gemini Files maintenance requires a server-side Gemini API key.");
  }
  const filesRepository=createGoogleGeminiFilesRepository({...cloudCredentials,fetchImpl:globalThis.fetch});
  const filesGateway=createGoogleGeminiFilesComposition({
   ...cloudCredentials,env,fetchImpl:globalThis.fetch,repository:filesRepository,maxBytes:config.maxBytes
  });
  if(geminiFilesCleanupEnabled){
   const cleanupWorker=createGoogleGeminiFilesRetentionWorker({repository:filesRepository,gateway:filesGateway});
   maintenanceTasks.push(()=>cleanupWorker.run({limit:100}));
  }
  if(geminiFilesRecoveryEnabled){
   const recoveryWorker=createGoogleGeminiFilesRecoveryWorker({repository:filesRepository,gateway:filesGateway});
   maintenanceTasks.push(()=>recoveryWorker.run({limit:100}));
  }
 }
 const supervisor=createCloudWorkerSupervisor({
  workers,maintenanceTasks,maintenanceIntervalMs:config.cleanupIntervalMs,
  leaseSeconds:config.leaseSeconds,heartbeatIntervalMs:config.heartbeatIntervalMs,pollMs:config.pollMs,
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
