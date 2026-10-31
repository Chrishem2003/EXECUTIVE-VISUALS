import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import { createCloudMediaAssetIO } from "./cloud-media-io.mjs";
import { createCloudMediaExecutor } from "./cloud-media-executor.mjs";
import { runCloudWorkerCycle } from "./cloud-worker.mjs";

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

  return Object.freeze({
    workerId,
    async runCycle(options = {}) {
      return runCloudWorkerCycle({
        queue: cloudQueue,
        workerId,
        execute: executor,
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
