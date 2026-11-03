const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED",
  "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "VIDEO_GATEWAY_TIMEOUT", "VIDEO_GATEWAY_UNAVAILABLE",
  "VIDEO_GATEWAY_RATE_LIMITED", "VIDEO_GATEWAY_SERVER_ERROR",
  "IMAGE_GATEWAY_TIMEOUT", "IMAGE_GATEWAY_UNAVAILABLE",
  "IMAGE_GATEWAY_RATE_LIMITED", "IMAGE_GATEWAY_SERVER_ERROR"
]);

export function isRetryableCloudJobError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (["CLOUD_QUEUE_TIMEOUT", "CLOUD_STORAGE_TIMEOUT", "CLOUD_MEDIA_TIMEOUT", "MEDIA_TIMEOUT"].includes(code)) return true;
  if (TRANSIENT_SYSTEM_CODES.has(code)) return true;
  const retryableStatuses = [408, 425, 429, 500, 502, 503, 504];
  if (retryableStatuses.includes(Number(error?.status))) return true;
  const knownHttpFamily = code.startsWith("CLOUD_QUEUE_HTTP_") || code.startsWith("CLOUD_STORAGE_HTTP_");
  const codeStatus = Number(code.slice(code.lastIndexOf("_") + 1));
  return knownHttpFamily && retryableStatuses.includes(codeStatus);
}

export async function runCloudWorkerCycle({
  queue,
  workerId,
  execute,
  leaseSeconds = 90,
  heartbeatIntervalMs = 15000,
  onProgress = () => {},
  onEvent = () => {},
  signal: shutdownSignal
}) {
  if (!queue || typeof queue.claim !== "function" || typeof queue.renew !== "function" || typeof queue.finish !== "function") {
    throw new Error("Cloud worker requires a compatible queue adapter.");
  }
  if (typeof execute !== "function") throw new Error("Cloud worker requires an execution function.");
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) throw new Error("Cloud worker ID is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Cloud worker lease duration is invalid.");
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new Error("Heartbeat interval must be at least one second and shorter than the lease.");
  }

  const job = await queue.claim(workerId, leaseSeconds);
  if (!job) return { claimed: false };
  const controller = new AbortController();
  const abortForShutdown = () => controller.abort(shutdownSignal.reason);
  shutdownSignal?.addEventListener("abort", abortForShutdown, { once: true });
  if (shutdownSignal?.aborted) abortForShutdown();
  if (controller.signal.aborted) {
    shutdownSignal?.removeEventListener("abort", abortForShutdown);
    return { claimed: true, finished: false, reason: "worker_stopping", jobId: job.id };
  }
  let leaseLost = false;
  let userCancelled = false;
  let heartbeatPending = false;
  let heartbeatError = null;
  let progressError = null;
  let progressTask = Promise.resolve();
  let lastReportedProgress = 0;
  let heartbeatTask = Promise.resolve();
  onEvent({ type: "job.started", jobId: job.id, workerId });

  const heartbeat = setInterval(async () => {
    if (heartbeatPending || leaseLost || controller.signal.aborted) return;
    heartbeatPending = true;
    heartbeatTask = (async () => {
      try {
        const renewed = await queue.renew(job.id, workerId, leaseSeconds);
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error("Worker lease is no longer valid."));
          onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
        } else if (typeof queue.checkCancellation === "function") {
          const cancellation = await queue.checkCancellation(job.id, workerId);
          if (!cancellation.leaseValid) {
            leaseLost = true;
            controller.abort(new Error("Worker lease is no longer valid."));
            onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
          } else if (cancellation.cancelRequested) {
            userCancelled = true;
            controller.abort(Object.assign(new Error("The project requested cancellation."), { code: "JOB_CANCELLED_BY_USER" }));
            onEvent({ type: "job.cancel_requested", jobId: job.id, workerId });
          }
        }
      } catch (error) {
        heartbeatError = error;
        leaseLost = true;
        controller.abort(new Error("Worker could not renew its execution lease."));
        onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      } finally {
        heartbeatPending = false;
      }
    })();
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  async function finishCancellation() {
    const details = { code: "JOB_CANCELLED_BY_USER", message: "The job was cancelled by an authorized project editor.", retryable: false };
    const finished = await queue.finish(job.id, workerId, "cancelled", null, details);
    if (!finished) {
      leaseLost = true;
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    onEvent({ type: "job.cancelled", jobId: job.id, workerId });
    return { claimed: true, finished: true, status: "cancelled", jobId: job.id, error: details };
  }

  try {
    const output = await execute({
      job,
      signal: controller.signal,
      onProgress(value) {
        if (leaseLost || controller.signal.aborted) return;
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Worker progress must be between 0 and 100.");
        const progress = Math.max(lastReportedProgress, value);
        if (progress === lastReportedProgress) return;
        lastReportedProgress = progress;
        onProgress({ jobId: job.id, workerId, progress });
        if (typeof queue.reportProgress === "function") {
          progressTask = progressTask.then(async () => {
            if (controller.signal.aborted || leaseLost) return;
            const accepted = await queue.reportProgress(job.id, workerId, progress);
            if (!accepted) {
              leaseLost = true;
              controller.abort(new Error("Worker lease is no longer valid for progress reporting."));
              onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
            }
          }).catch(error => {
            progressError = error;
            leaseLost = true;
            controller.abort(new Error("Worker could not persist job progress."));
            onEvent({ type: "job.progress_error", jobId: job.id, workerId });
          });
        }
      }
    });
    // Stop scheduling heartbeats and settle any in-flight renewal before the
    // terminal transition. Otherwise a late renewal can race a successful finish.
    clearInterval(heartbeat);
    await Promise.all([heartbeatTask, progressTask]);
    if (userCancelled) return await finishCancellation();
    if (leaseLost || controller.signal.aborted) {
      return { claimed: true, finished: false, reason: shutdownSignal?.aborted ? "worker_stopping" : "lease_lost", jobId: job.id };
    }
    if (output !== null && (typeof output !== "object" || Array.isArray(output))) {
      throw new Error("Cloud worker output must be an object or null.");
    }
    const finished = await queue.finish(job.id, workerId, "succeeded", output ?? {}, null);
    if (!finished) {
      if (typeof queue.checkCancellation === "function") {
        const cancellation = await queue.checkCancellation(job.id, workerId);
        if (cancellation.leaseValid && cancellation.cancelRequested) {
          userCancelled = true;
          return await finishCancellation();
        }
      }
      leaseLost = true;
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    onEvent({ type: "job.succeeded", jobId: job.id, workerId });
    return { claimed: true, finished: true, status: "succeeded", jobId: job.id, output: output ?? {} };
  } catch (error) {
    clearInterval(heartbeat);
    await heartbeatTask;
    if (userCancelled) return await finishCancellation();
    if (leaseLost || controller.signal.aborted) {
      return { claimed: true, finished: false, reason: shutdownSignal?.aborted ? "worker_stopping" : "lease_lost", jobId: job.id };
    }
    const retryable = isRetryableCloudJobError(error);
    const details = {
      code: typeof error?.code === "string" ? error.code.slice(0, 100) : "CLOUD_JOB_FAILED",
      message: String(error?.message || "Cloud job execution failed.").slice(0, 500),
      retryable
    };
    if (retryable && typeof queue.retry === "function") {
      const scheduled = await queue.retry(job.id, workerId, details);
      if (!scheduled.accepted || scheduled.status === "lease_lost") {
        leaseLost = true;
        onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
        return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
      }
      if (scheduled.status === "queued") {
        onEvent({ type: "job.retry_scheduled", jobId: job.id, workerId, delaySeconds: scheduled.delaySeconds, attempt: scheduled.attempt, maxAttempts: scheduled.maxAttempts, error: details });
        return { claimed: true, finished: true, status: "queued", retryScheduled: true, retryAfterSeconds: scheduled.delaySeconds, jobId: job.id, error: details };
      }
      if (scheduled.status === "cancelled") {
        const cancellation = { code: "JOB_CANCELLED_BY_USER", message: "The job was cancelled by an authorized project editor.", retryable: false };
        onEvent({ type: "job.cancelled", jobId: job.id, workerId });
        return { claimed: true, finished: true, status: "cancelled", jobId: job.id, error: cancellation };
      }
      onEvent({ type: "job.failed", jobId: job.id, workerId, error: { ...details, retryable: false, retryExhausted: true } });
      return { claimed: true, finished: true, status: "failed", jobId: job.id, error: { ...details, retryable: false, retryExhausted: true } };
    }
    const finished = await queue.finish(job.id, workerId, "failed", null, details);
    if (!finished) {
      leaseLost = true;
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    onEvent({ type: "job.failed", jobId: job.id, workerId, error: details });
    return { claimed: true, finished: true, status: "failed", jobId: job.id, error: details };
  } finally {
    clearInterval(heartbeat);
    shutdownSignal?.removeEventListener("abort", abortForShutdown);
    if (heartbeatError) onEvent({ type: "job.heartbeat_error", jobId: job.id, workerId });
    if (progressError) onEvent({ type: "job.progress_error", jobId: job.id, workerId });
  }
}
