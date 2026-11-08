export async function runCloudWorkerCycle({
  queue,
  workerId,
  execute,
  leaseSeconds = 90,
  heartbeatIntervalMs = 15000,
  signal,
  onProgress = () => {},
  onEvent = () => {}
}) {
  if (!queue || typeof queue.claim !== "function" || typeof queue.renew !== "function" || typeof queue.finish !== "function" || typeof queue.assertLease !== "function") {
    throw new Error("Cloud worker requires a compatible queue adapter.");
  }
  if (typeof execute !== "function") throw new Error("Cloud worker requires an execution function.");
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) throw new Error("Cloud worker ID is invalid.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Cloud worker lease duration is invalid.");
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1000 || heartbeatIntervalMs >= leaseSeconds * 1000) {
    throw new Error("Heartbeat interval must be at least one second and shorter than the lease.");
  }
  if (signal && typeof signal.addEventListener !== "function") throw new Error("Cloud worker shutdown signal is invalid.");
  if (signal?.aborted) return { claimed: false, skipped: true, reason: "shutdown" };

  const job = await queue.claim(workerId, leaseSeconds);
  if (!job) return { claimed: false };
  if (typeof job.lease_token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.lease_token)) {
    throw new Error("Cloud worker claim is missing a valid per-attempt lease fencing token.");
  }
  const controller = new AbortController();
  const abortForShutdown = () => controller.abort(new Error("Worker shutdown requested."));
  signal?.addEventListener("abort", abortForShutdown, { once: true });
  if (signal?.aborted) abortForShutdown();
  let leaseLost = false;
  let heartbeatPending = false;
  let heartbeatError = null;
  let heartbeatStopped = false;
  let heartbeatInFlight = Promise.resolve();
  async function assertLease() {
    if (leaseLost) throw Object.assign(new Error("Worker lease is no longer valid."), { code: "CLOUD_WORKER_LEASE_LOST" });
    try {
      const valid = await queue.assertLease(job.id, workerId, job.lease_token);
      if (!valid) throw new Error("Worker lease is no longer valid.");
      return true;
    } catch {
      leaseLost = true;
      controller.abort(new Error("Worker lease could not be verified."));
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      throw Object.assign(new Error("Worker lease verification failed; side effects are blocked."), { code: "CLOUD_WORKER_LEASE_LOST" });
    }
  }
  onEvent({ type: "job.started", jobId: job.id, workerId });

  const finishCancelled = async () => {
    await stopHeartbeat();
    const details = { code: "WORKER_SHUTDOWN", message: "Worker shutdown requested; the job was cancelled for recovery." };
    try {
      if (leaseLost) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
      await assertLease();
      const finished = await queue.finish(job.id, workerId, "cancelled", null, details, job.lease_token);
      if (!finished) {
        leaseLost = true;
        onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
        return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
      }
      onEvent({ type: "job.cancelled", jobId: job.id, workerId, reason: "worker_shutdown" });
      return { claimed: true, finished: true, status: "cancelled", reason: "worker_shutdown", jobId: job.id };
    } catch (error) {
      if (leaseLost) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
      onEvent({ type: "job.cancel_finish_failed", jobId: job.id, workerId, code: typeof error?.code === "string" ? error.code : "CANCEL_FINISH_FAILED" });
      return { claimed: true, finished: false, reason: "cancel_finish_failed", jobId: job.id };
    }
  };

  const heartbeat = setInterval(() => {
    if (heartbeatPending || heartbeatStopped || leaseLost || controller.signal.aborted) return;
    heartbeatPending = true;
    heartbeatInFlight = (async () => {
      try {
        const renewed = await queue.renew(job.id, workerId, leaseSeconds, job.lease_token);
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
    })();
  }, heartbeatIntervalMs);
  heartbeat.unref?.();
  async function stopHeartbeat() {
    if (!heartbeatStopped) {
      heartbeatStopped = true;
      clearInterval(heartbeat);
    }
    await heartbeatInFlight;
  }

  try {
    if (controller.signal.aborted) return await finishCancelled();
    const output = await execute({
      job,
      signal: controller.signal,
      assertLease,
      onProgress(value) {
        if (leaseLost || controller.signal.aborted) return;
        if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Worker progress must be between 0 and 100.");
        onProgress({ jobId: job.id, workerId, progress: value });
      }
    });
    await stopHeartbeat();
    if (!leaseLost && !controller.signal.aborted) {
      try { await assertLease(); } catch { /* lease loss blocks publication and terminal writes */ }
    }
    if (leaseLost) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    if (controller.signal.aborted) return await finishCancelled();
    if (output !== null && (typeof output !== "object" || Array.isArray(output))) {
      throw new Error("Cloud worker output must be an object or null.");
    }
    const finished = await queue.finish(job.id, workerId, "succeeded", output ?? {}, null, job.lease_token);
    if (!finished) {
      leaseLost = true;
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    onEvent({ type: "job.succeeded", jobId: job.id, workerId });
    return { claimed: true, finished: true, status: "succeeded", jobId: job.id, output: output ?? {} };
  } catch (error) {
    await stopHeartbeat();
    if (leaseLost) return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    if (controller.signal.aborted) return await finishCancelled();
    try { await assertLease(); } catch { return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id }; }
    const details = {
      code: typeof error?.code === "string" ? error.code.slice(0, 100) : "CLOUD_JOB_FAILED",
      message: String(error?.message || "Cloud job execution failed.").slice(0, 500)
    };
    const finished = await queue.finish(job.id, workerId, "failed", null, details, job.lease_token);
    if (!finished) {
      leaseLost = true;
      onEvent({ type: "job.lease_lost", jobId: job.id, workerId });
      return { claimed: true, finished: false, reason: "lease_lost", jobId: job.id };
    }
    onEvent({ type: "job.failed", jobId: job.id, workerId, error: details });
    return { claimed: true, finished: true, status: "failed", jobId: job.id, error: details };
  } finally {
    await stopHeartbeat();
    signal?.removeEventListener("abort", abortForShutdown);
    if (heartbeatError) onEvent({ type: "job.heartbeat_error", jobId: job.id, workerId });
  }
}
