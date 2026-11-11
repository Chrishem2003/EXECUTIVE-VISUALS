import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createCloudVideoGenerationRepositories } from "./cloud-video-generation-repositories.mjs";
import { createCloudVideoGenerationExecutor } from "./cloud-video-generation-executor.mjs";
import { getRunwayVideoTask, cancelRunwayVideoTask } from "./runway-video-gateway.mjs";
import { getFalVideoTask, cancelFalVideoTask } from "./fal-video-gateway.mjs";
import { runCloudWorkerCycle } from "./cloud-worker.mjs";

const VIDEO_JOB_TYPES=Object.freeze(["video.generate.shot"]);

/** Explicit opt-in cloud video worker. Importing this module makes no provider calls. */
export function createCloudVideoGenerationWorker({
 workerId,queue,assetService,mediaIO,repositories,execute,url,serviceRoleKey,fetchImpl,tempRoot,maxBytes,timeoutMs,
 submitTask,getTask,downloadOutput,pollIntervalMs,cancellationAdapters
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
  recover:(...args)=>cloudQueue.recover(...args),
  assertLease:(...args)=>cloudQueue.assertLease(...args)
 });
 async function reconcilePendingCancellations(limit=20){
  if(typeof repos.tasks?.claimCancellationPending!=="function")return {examined:0,confirmed:0,pending:0,errors:[]};
  const pending=await repos.tasks.claimCancellationPending(workerId,limit),results=[];
  for(const task of pending){
   try{
    if(!task.providerTaskId){
     if(task.state==="reserved"){
      await repos.tasks.markCancelled(task.id,{providerStatus:"NOT_SUBMITTED"});
      results.push({taskId:task.id,status:"cancelled"});continue;
     }
     throw Object.assign(new Error("Provider submission outcome is uncertain; cancellation remains pending until the task identifier can be reconciled."),{code:"VIDEO_TASK_CANCELLATION_PENDING"});
    }
    const defaults={fal:{poll:getFalVideoTask,cancel:cancelFalVideoTask},runway:{poll:getRunwayVideoTask,cancel:cancelRunwayVideoTask}};
   const adapter=(cancellationAdapters||defaults)[task.provider];
    if(!adapter)throw Object.assign(new Error("No cancellation reconciler is registered for this provider."),{code:"VIDEO_PROVIDER_UNSUPPORTED"});
    const current=await adapter.poll({taskId:task.providerTaskId,model:task.model});
    if(["SUCCEEDED","FAILED","CANCELED","CANCELLED"].includes(current.status)){
     await repos.tasks.markCancelled(task.id,{providerStatus:current.status});
     results.push({taskId:task.id,status:"cancelled",providerStatus:current.status});continue;
    }
    if(!["PENDING","THROTTLED","RUNNING"].includes(current.status))throw Object.assign(new Error("Provider returned an unknown task state during cancellation reconciliation."),{code:"VIDEO_PROVIDER_STATE_INVALID"});
    const outcome=await adapter.cancel({taskId:task.providerTaskId,model:task.model});
    if(outcome.status==="CANCELLATION_REQUESTED"){
     // Keep the reconciliation lease until expiry to avoid repeatedly polling
     // a provider that has accepted but not yet completed cancellation.
     results.push({taskId:task.id,status:"pending"});continue;
    }
    if(!["OK","CANCELLED","NOT_FOUND","ALREADY_COMPLETED"].includes(outcome.status))throw Object.assign(new Error("Provider returned an unknown cancellation result."),{code:"VIDEO_TASK_CANCELLATION_PENDING"});
    await repos.tasks.markCancelled(task.id,{providerStatus:outcome.status});
    results.push({taskId:task.id,status:"cancelled",providerStatus:outcome.status});
   }catch(error){
    results.push({taskId:task.id,status:"error",code:String(error?.code||"VIDEO_CANCELLATION_RECONCILIATION_FAILED").slice(0,80)});
   }
  }
  return {examined:results.length,confirmed:results.filter(x=>x.status==="cancelled").length,pending:results.filter(x=>x.status==="pending").length,errors:results.filter(x=>x.status==="error")};
 }
 return Object.freeze({
  workerId,
  runCycle(options={}){return runCloudWorkerCycle({queue:videoQueue,workerId,execute:executor,
   leaseSeconds:options.leaseSeconds??90,heartbeatIntervalMs:options.heartbeatIntervalMs??15000,signal:options.signal,
   onProgress:options.onProgress??(()=>{}),onEvent:options.onEvent??(()=>{})});},
  recoverExpired(limit=100){return cloudQueue.recover(limit);},
  reconcilePendingCancellations,
  reconcileStorageCleanup(limit=20){
   return typeof cloudAssets.assets.reconcilePendingStorageCleanup==="function"
    ?cloudAssets.assets.reconcilePendingStorageCleanup({limit})
    :Promise.resolve({examined:0,removed:0,results:[]});
  }
 });
}
