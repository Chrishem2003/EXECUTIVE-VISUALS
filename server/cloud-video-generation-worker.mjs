import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createCloudVideoGenerationRepositories } from "./cloud-video-generation-repositories.mjs";
import { createCloudVideoGenerationExecutor } from "./cloud-video-generation-executor.mjs";
import { runCloudWorkerCycle } from "./cloud-worker.mjs";

const VIDEO_JOB_TYPES=Object.freeze(["video.generate.shot"]);

/** Explicit opt-in cloud video worker. Importing this module makes no provider calls. */
export function createCloudVideoGenerationWorker({
 workerId,queue,assetService,mediaIO,repositories,execute,url,serviceRoleKey,fetchImpl,tempRoot,maxBytes,timeoutMs,
 submitTask,getTask,downloadOutput,pollIntervalMs
}={}){
 if(typeof workerId!=="string"||!workerId.trim()||workerId.length>128)throw new Error("Cloud video worker ID must contain between 1 and 128 characters.");
 const cloudQueue=queue||createCloudQueue({url,serviceRoleKey,fetchImpl});
 const cloudAssets=assetService||createCloudAssetService({url,serviceRoleKey,fetchImpl,maxBytes});
 const io=mediaIO||createCloudMediaAssetIO({assets:cloudAssets.assets,fetchImpl,tempRoot,maxBytes,timeoutMs});
 const repos=repositories||createCloudVideoGenerationRepositories({url,serviceRoleKey,fetchImpl,timeoutMs});
 const executor=execute||createCloudVideoGenerationExecutor({approvals:repos.approvals,tasks:repos.tasks,mediaIO:io,submitTask,getTask,downloadOutput,pollIntervalMs});
 const videoQueue=Object.freeze({
  claim:(id,leaseSeconds)=>cloudQueue.claim(id,leaseSeconds,VIDEO_JOB_TYPES),
  renew:(...args)=>cloudQueue.renew(...args),
  finish:(...args)=>cloudQueue.finish(...args),
  recover:(...args)=>cloudQueue.recover(...args)
 });
 return Object.freeze({
  workerId,
  runCycle(options={}){return runCloudWorkerCycle({queue:videoQueue,workerId,execute:executor,
   leaseSeconds:options.leaseSeconds??90,heartbeatIntervalMs:options.heartbeatIntervalMs??15000,
   onProgress:options.onProgress??(()=>{}),onEvent:options.onEvent??(()=>{})});},
  recoverExpired(limit=100){return cloudQueue.recover(limit);},
  reconcileStorageCleanup(limit=20){
   return typeof cloudAssets.assets.reconcilePendingStorageCleanup==="function"
    ?cloudAssets.assets.reconcilePendingStorageCleanup({limit})
    :Promise.resolve({examined:0,removed:0,results:[]});
  }
 });
}
