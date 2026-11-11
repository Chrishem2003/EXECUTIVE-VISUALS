export async function runCloudWorkerCycle({
  queue,
  workerId,
  execute,
  leaseSeconds = 90,
  heartbeatIntervalMs = 15000,
  onProgress = () => {},
  onEvent = () => {}
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
  let leaseLost = false;
  let heartbeatPending = false;
  let heartbeatError = null;
  onEvent({ type: "job.started", jobId: job.id, workerId });

  const heartbeat = setInterval(async () => {
    if (heartbeatPending || leaseLost || controller.signal.aborted) return;
    heartbeatPending = true;
    try {
      const renewed = await queue.renew(job.id, workerId, leaseSeconds);
      if (!renewed) {
        leaseLost = true;
        controller.abort(new Error("Worker lease is no longer valid."));
        onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      }
    } catch (error) {
      heartbeatError = error;
      leaseLost = true;
      controller.abort(new Error("Worker could not renew its execution lease."));
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
    } finally {
      heartbeatPending = false;
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    const output = await execute({
      job,
      signal: controller.signal,
      onProgress(value) {
        if (leaseLost || controller.signal.aborted) return;
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Worker progress must be between 0 and 100.");
        onProgress({ jobId: job.id, workerId, progress: value });
      }
    });
    if (leaseLost || controller.signal.aborted) {
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    if (output !== null && (typeof output !== "object" || Array.isArray(output))) {
      throw new Error("Cloud worker output must be an object or null.");
    }
    const finished = await queue.finish(job.id, workerId, "succeeded", output ?? {}, null);
    if (!finished) {
      leaseLost = true;
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    onEvent({ type: "job.succeeded", jobId: job.id, workerId });
    return { claimed: true, finished: true, status: "succeeded", jobId: job.id, output: output ?? {} };
  } catch (error) {
    if (leaseLost || controller.signal.aborted) {
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    const details = {
      code: typeof error?.code === "string" ? error.code.slice(0, 100) : "CLOUD_JOB_FAILED",
      message: String(error?.message || "Cloud job execution failed.").slice(0, 500)
    };
    if(error?.certification?.schemaVersion===1&&Array.isArray(error.certification.checks)){
      details.deliveryCertification=error.certification;
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
    if (heartbeatError) onEvent({ type: "job.heartbeat_error", jobId: job.id, workerId });
  }
}
