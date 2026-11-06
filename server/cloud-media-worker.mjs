import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createCloudMediaExecutor } from "./cloud-media-executor.mjs";
import { runCloudWorkerCycle } from "./cloud-worker.mjs";

const MEDIA_JOB_TYPES = Object.freeze([
  "media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean",
  "media.denoise", "media.color", "media.resize", "media.interpolate",
  "media.upscale", "media.ai-upscale", "media.transcode", "media.proxy"
]);

/**
 * Assemble the cloud queue, private asset boundary and FFmpeg executor into
 * one explicit worker entry point. Construction is opt-in; importing this
 * module never starts a worker or makes a provider request.
 */
export function createCloudMediaWorker({
  workerId,
  queue,
  assetService,
  mediaIO,
  execute,
  url,
  serviceRoleKey,
  fetchImpl,
  tempRoot,
  maxBytes,
  timeoutMs,
  ffmpeg,
  ffprobe
} = {}) {
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw new Error("Cloud media worker ID must contain between 1 and 128 characters.");
  }
  const cloudQueue = queue || createCloudQueue({ url, serviceRoleKey, fetchImpl });
  const cloudAssets = assetService || createCloudAssetService({
    url, serviceRoleKey, fetchImpl, maxBytes
  });
  const io = mediaIO || createCloudMediaAssetIO({
    assets: cloudAssets.assets,
    fetchImpl,
    tempRoot,
    maxBytes,
    timeoutMs
  });
  const executor = execute || createCloudMediaExecutor({
    mediaIO: io,
    tempRoot,
    ffmpeg,
    ffprobe,
    timeoutMs
  });
  // The cloud queue is shared by future worker families. Restrict this worker
  // at claim time so it never leases and fails workflow or other job types.
  const mediaQueue = Object.freeze({
    claim: (id, leaseSeconds) => cloudQueue.claim(id, leaseSeconds, MEDIA_JOB_TYPES),
    renew: (...args) => cloudQueue.renew(...args),
    finish: (...args) => cloudQueue.finish(...args),
    recover: (...args) => cloudQueue.recover(...args)
  });

  const executeWithProbePersistence=async context=>{
    const result=await executor(context);
    if(context.job?.job_type==="media.probe"){
      if(!result?.metadata||typeof result.metadata!=="object"||Array.isArray(result.metadata)){
        throw Object.assign(new Error("Cloud media probe completed without metadata to persist."),{code:"CLOUD_MEDIA_PROBE_METADATA_MISSING"});
      }
      if(typeof cloudAssets.assets?.updateMetadata!=="function"){
        throw Object.assign(new Error("Cloud media probe metadata persistence is unavailable."),{code:"CLOUD_MEDIA_PROBE_PERSISTENCE_UNAVAILABLE"});
      }
      const sourceAssetId=String(context.job.input?.sourceAssetId||"");
      if(!sourceAssetId)throw new Error("Cloud media probe is missing its source asset ID.");
      await cloudAssets.assets.updateMetadata({ownerId:context.job.owner_id,assetId:sourceAssetId,patch:{probe:result.metadata}});
    }
    return result;
  };

  return Object.freeze({
    workerId,
    async runCycle(options = {}) {
      return runCloudWorkerCycle({
        queue: mediaQueue,
        workerId,
        execute: executeWithProbePersistence,
        leaseSeconds: options.leaseSeconds ?? 90,
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15000,
        onProgress: options.onProgress ?? (() => {}),
        onEvent: options.onEvent ?? (() => {})
      });
    },
    recoverExpired(limit = 100) {
      return cloudQueue.recover(limit);
    }
  });
}
