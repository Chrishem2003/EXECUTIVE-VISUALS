import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createCloudTimelineService } from "./cloud-timeline-service.mjs";
import { createCloudTimelineExecutor } from "./cloud-timeline-executor.mjs";
import { renderCloudTimeline } from "./cloud-ffmpeg-timeline-renderer.mjs";
import { runCloudWorkerCycle } from "./cloud-worker.mjs";

const TIMELINE_JOB_TYPES=Object.freeze(["timeline.render"]);

/**
 * Explicit timeline worker assembly. Uses the cloud-materialized FFmpeg
 * renderer by default; callers may inject a compatible renderer for testing.
 */
export function createCloudTimelineWorker({
  workerId,queue,timelineService,timelines,assets,mediaIO,renderTimeline=renderCloudTimeline,
  url,serviceRoleKey,fetchImpl,tempRoot,maxBytes,maxOutputBytes,timeoutMs
}={}){
  if(typeof workerId!=="string"||!workerId.trim()||workerId.length>128)throw new Error("Cloud timeline worker ID must contain between 1 and 128 characters.");
  const cloudQueue=queue||createCloudQueue({url,serviceRoleKey,fetchImpl});
  const service=timelineService||createCloudTimelineService({url,serviceRoleKey,fetchImpl,maxBytes});
  const timelineRepository=timelines||service.timelines;
  const assetRepository=assets||service.assets;
  const io=mediaIO||createCloudMediaAssetIO({assets:assetRepository,fetchImpl,tempRoot,maxBytes,timeoutMs});
  const execute=createCloudTimelineExecutor({timelines:timelineRepository,mediaIO:io,renderTimeline,tempRoot,maxOutputBytes:maxOutputBytes??maxBytes??250*1024*1024});
  const timelineQueue=Object.freeze({
    claim:(id,leaseSeconds)=>cloudQueue.claim(id,leaseSeconds,TIMELINE_JOB_TYPES),
    renew:(...args)=>cloudQueue.renew(...args),
    finish:(...args)=>cloudQueue.finish(...args),
    recover:(...args)=>cloudQueue.recover(...args),
    assertLease:(...args)=>cloudQueue.assertLease(...args),
    cancellationRequested:(...args)=>cloudQueue.cancellationRequested(...args)
  });
  return Object.freeze({
    workerId,
    runCycle(options={}){return runCloudWorkerCycle({
      queue:timelineQueue,workerId,execute,
      leaseSeconds:options.leaseSeconds??90,
      heartbeatIntervalMs:options.heartbeatIntervalMs??15000,
      signal:options.signal,
      onProgress:options.onProgress??(()=>{}),
      onEvent:options.onEvent??(()=>{})
    });},
    recoverExpired(limit=100){return cloudQueue.recover(limit);},
    reconcileStorageCleanup(limit=20){
      return typeof assetRepository.reconcilePendingStorageCleanup==="function"
        ? assetRepository.reconcilePendingStorageCleanup({limit})
        : Promise.resolve({examined:0,removed:0,results:[]});
    }
  });
}
