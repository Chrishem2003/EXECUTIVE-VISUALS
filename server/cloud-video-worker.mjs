import { executeCloudVideoGenerationJob } from "./cloud-video-generation-executor.mjs";

const QUARANTINE_CODES = new Set([
  "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION",
  "VIDEO_PREFLIGHT_REJECTED",
  "VIDEO_SUBMISSION_IN_PROGRESS",
  "VIDEO_SUBMISSION_TERMINAL",
  "VIDEO_BUDGET_COST_UNRESOLVED",
  "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNAVAILABLE",
  "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED",
  "VIDEO_OUTPUT_INGESTION_REQUIRES_REVIEW",
  "VIDEO_OUTPUT_INGESTION_CLEANUP_PENDING",
  "VIDEO_OUTPUT_COLLECTION_INVALID",
  "VIDEO_OUTPUT_MEDIA_INVALID",
  "VIDEO_OUTPUT_URL_REJECTED",
  "VIDEO_OUTPUT_DOWNLOAD_INVALID",
  "VIDEO_OUTPUT_ASSET_REGISTRATION_INVALID",
  "VIDEO_PROVIDER_STATUS_INVALID",
  "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED"
]);

export async function runCloudVideoWorkerCycle({
  queue,
  enqueue,
  workerId,
  execute,
  leaseSeconds = 90,
  heartbeatIntervalMs = 15000,
  deferSeconds = 30,
  onEvent = () => {}
} = {}) {
  if (!queue || typeof queue.claim !== "function" || typeof queue.renew !== "function") {
    throw new Error("Cloud video worker requires a lease-aware cloud queue.");
  }
  if (!enqueue || typeof enqueue.finish !== "function" || typeof enqueue.defer !== "function" ||
      typeof enqueue.quarantine !== "function" || typeof enqueue.recoverExpiredVideo !== "function") {
    throw new Error("Cloud video worker requires atomic enqueue/finalization and recovery RPCs.");
  }
  if (typeof execute !== "function") throw new Error("Cloud video worker requires an execution function.");
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) throw new Error("Cloud video worker ID is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900 ||
      !Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new Error("Cloud video worker lease and heartbeat settings are invalid.");
  }
  if (!Number.isInteger(deferSeconds) || deferSeconds < 5 || deferSeconds > 900) throw new Error("Cloud video worker defer interval is invalid.");

  const job = await queue.claim(workerId, leaseSeconds, ["video.generate"]);
  if (!job) return { claimed: false };
  const controller = new AbortController();
  let leaseLost = false;
  let heartbeatPending = false;
  let heartbeatError = null;
  onEvent({ type: "video.job.started", jobId: job.id, workerId });

  const heartbeat = setInterval(async () => {
    if (heartbeatPending || leaseLost || controller.signal.aborted) return;
    heartbeatPending = true;
    try {
      if (!await queue.renew(job.id, workerId, leaseSeconds)) {
        leaseLost = true;
        controller.abort(new Error("Cloud video worker lease was lost."));
        onEvent({ type: "video.job.lease_lost", jobId: job.id, workerId });
      }
    } catch (error) {
      heartbeatError = error;
      leaseLost = true;
      controller.abort(new Error("Cloud video worker could not renew its lease."));
      onEvent({ type: "video.job.lease_lost", jobId: job.id, workerId });
    } finally {
      heartbeatPending = false;
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    const output = await execute({ job, workerId, signal: controller.signal });
    if (leaseLost || controller.signal.aborted) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    if (!output || !Array.isArray(output.assetIds) || typeof output.actualAmount !== "number" ||
        !Number.isFinite(output.actualAmount) || typeof output.currency !== "string") {
      throw Object.assign(new Error("Cloud video executor returned an invalid final result."), { code: "VIDEO_EXECUTOR_RESULT_INVALID" });
    }
    const persistedOutput = {
      provider: output.provider, model: output.model, providerTaskId: output.providerTaskId,
      assetIds: output.assetIds, usage: output.usage || null,
      costEvidenceReference: output.costEvidenceReference,
      customerCreditSettlement: output.customerCreditSettlement || null
    };
    const finished = await enqueue.finish({
      jobId: job.id, workerId, status: "succeeded",
      output: persistedOutput, actualAmount: output.actualAmount
    });
    if (!finished) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    onEvent({ type: "video.job.succeeded", jobId: job.id, workerId, assetCount: output.assetIds.length });
    return { claimed: true, finished: true, status: "succeeded", jobId: job.id, output: persistedOutput };
  } catch (error) {
    if (leaseLost || controller.signal.aborted) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    const code = typeof error?.code === "string" ? error.code.slice(0, 100) : "CLOUD_VIDEO_JOB_FAILED";
    const message = String(error?.message || "Cloud video generation failed.").slice(0, 500);
    if (code === "VIDEO_PROVIDER_POLL_DEFERRED") {
      const deferred = await enqueue.defer({ jobId: job.id, workerId, delaySeconds: deferSeconds, reasonCode: code });
      if (!deferred) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
      onEvent({ type: "video.job.deferred", jobId: job.id, workerId, reasonCode: code });
      return { claimed: true, finished: true, status: "queued", jobId: job.id, reason: code };
    }
    if (QUARANTINE_CODES.has(code)) {
      const quarantined = await enqueue.quarantine({ jobId: job.id, workerId, reasonCode: code });
      if (!quarantined) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
      onEvent({ type: "video.job.needs_input", jobId: job.id, workerId, reasonCode: code });
      return { claimed: true, finished: true, status: "needs_input", jobId: job.id, reason: code };
    }
    const failed = await enqueue.finish({
      jobId: job.id, workerId, status: "failed",
      error: { code, message }
    });
    if (!failed) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    onEvent({ type: "video.job.failed", jobId: job.id, workerId, error: { code, message } });
    return { claimed: true, finished: true, status: "failed", jobId: job.id, error: { code, message } };
  } finally {
    clearInterval(heartbeat);
    if (heartbeatError) onEvent({ type: "video.job.heartbeat_error", jobId: job.id, workerId });
  }
}

export function createCloudVideoWorker({
  workerId,
  queue,
  enqueue,
  ledger,
  adapter,
  resolveAdapter,
  ingestOutputs,
  resolveActualCost,
  customerCredits,
  deferSeconds = 30
} = {}) {
  if (!ledger || (!adapter && typeof resolveAdapter !== "function") ||
      (adapter && typeof resolveAdapter === "function")) {
    throw new Error("Cloud video worker requires a Postgres ledger, provider adapter, private ingestion and cost resolver.");
  }
  return Object.freeze({
    async runCycle({ leaseSeconds = 90, heartbeatIntervalMs = 15000, onEvent = () => {} } = {}) {
      return runCloudVideoWorkerCycle({
        queue, enqueue, workerId, leaseSeconds, heartbeatIntervalMs, deferSeconds, onEvent,
        execute: ({ job, workerId: activeWorker, signal }) => executeCloudVideoGenerationJob({
          job, workerId: activeWorker, ledger, adapter, resolveAdapter, ingestOutputs, resolveActualCost,
          customerCredits, signal
        })
      });
    },
    async recoverExpired(limit = 100) { return enqueue.recoverExpiredVideo(limit); }
  });
}
