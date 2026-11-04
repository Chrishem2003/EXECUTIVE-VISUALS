const fail = (message, code) => Object.assign(new Error(message), { code });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function jobInput(job) {
  const value = job?.input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("Cloud video job input must be a JSON object.", "VIDEO_JOB_INPUT_INVALID");
  }
  return value;
}

/**
 * Hosted executor using only the Postgres submission ledger. Provider POSTs
 * are one-shot; ambiguous outcomes are returned as reconciliation work.
 */
export async function executeCloudVideoGenerationJob({
  job,
  workerId,
  ledger,
  adapter,
  ingestOutputs,
  resolveActualCost,
  signal,
  sleep = wait,
  maxPolls = 120,
  pollIntervalMs
} = {}) {
  if (!job?.id || !job?.owner_id || job.job_type !== "video.generate" ||
      typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw fail("Cloud video executor requires an owned leased video.generate job.", "VIDEO_JOB_INVALID");
  }
  if (!ledger || typeof ledger.prepare !== "function" || typeof ledger.begin !== "function" ||
      typeof ledger.record !== "function" || typeof ledger.markUnknown !== "function") {
    throw new Error("Cloud video executor requires the Postgres submission ledger.");
  }
  if (!adapter || adapter.provider !== "runway" || typeof adapter.submit !== "function" || typeof adapter.getStatus !== "function") {
    throw fail("A supported remote video adapter is required.", "VIDEO_ADAPTER_UNAVAILABLE");
  }
  if (typeof ingestOutputs !== "function" || typeof resolveActualCost !== "function") {
    throw fail("Private output ingestion and authoritative cost resolution are mandatory.", "VIDEO_EXECUTION_GATES_MISSING");
  }
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 1000) throw new Error("Video polling limit is invalid.");

  const input = jobInput(job);
  if (input.provider !== adapter.provider || input.model !== adapter.model ||
      typeof input.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw fail("Cloud video job provider, model or request hash is inconsistent.", "VIDEO_JOB_INPUT_MISMATCH");
  }
  if (signal?.aborted) throw fail("Cloud video job was cancelled before execution.", "VIDEO_JOB_CANCELLED");

  const prepared = await ledger.prepare({
    jobId: job.id, ownerId: job.owner_id, provider: input.provider,
    model: input.model, requestHash: input.requestHash
  });
  let state = prepared.state;
  let providerTaskId = prepared.provider_task_id || null;
  if (state === "unknown" || state === "submitting") {
    throw fail("Provider submission outcome is ambiguous and requires reconciliation.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  }
  if (state !== "prepared" && state !== "submitted") {
    throw fail("Cloud video submission ledger is already terminal.", "VIDEO_SUBMISSION_TERMINAL");
  }

  if (state === "prepared") {
    const began = await ledger.begin(job.id, workerId);
    if (!began) throw fail("Another worker owns the provider submission transition.", "VIDEO_SUBMISSION_IN_PROGRESS");
    let submitted;
    try {
      submitted = await adapter.submit(input);
    } catch (error) {
      try { await ledger.markUnknown(job.id, workerId, error?.code || "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN"); } catch {}
      throw fail("Provider submission outcome is unknown and has been quarantined.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    if (!submitted || typeof submitted.taskId !== "string" || !submitted.taskId.trim()) {
      try { await ledger.markUnknown(job.id, workerId, "PROVIDER_TASK_ID_MISSING"); } catch {}
      throw fail("Provider did not return a durable task ID; reconciliation is required.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    try {
      const recorded = await ledger.record(job.id, workerId, submitted.taskId, { acceptedStatus: submitted.status || "queued" });
      if (!recorded) throw new Error("Provider task ID was not recorded.");
    } catch {
      // The RPC may have committed despite a lost response. The job is held
      // for reconciliation instead of risking a second paid POST.
      throw fail("Provider task ID persistence is uncertain; reconciliation is required.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    providerTaskId = submitted.taskId;
    state = "submitted";
  }

  if (state !== "submitted" || !providerTaskId) {
    throw fail("Cloud video submission has no pollable provider task ID.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  }

  const interval = Math.max(5000, Number(pollIntervalMs || adapter.minimumPollIntervalMs || 5000));
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    if (signal?.aborted) throw fail("Cloud video worker lease was lost.", "VIDEO_WORKER_LEASE_LOST");
    let task;
    try {
      task = await adapter.getStatus(providerTaskId);
    } catch {
      throw fail("Provider status is temporarily unavailable; polling will resume later.", "VIDEO_PROVIDER_POLL_DEFERRED");
    }
    if (task.status === "failed" || task.status === "canceled") {
      throw fail(task.failure || "Video provider task did not complete.", task.failureCode || "VIDEO_PROVIDER_FAILED");
    }
    if (task.status === "succeeded") {
      if (!Array.isArray(task.outputUrls) || task.outputUrls.length < 1 || task.outputUrls.length > 10) {
        throw fail("Provider completed without a bounded output collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
      }
      let cost;
      try { cost = await resolveActualCost({ job, input, task, providerTaskId }); }
      catch { throw fail("Actual provider cost could not be verified; budget remains reserved for review.", "VIDEO_BUDGET_COST_UNRESOLVED"); }
      const approved = job.estimated_cost;
      const reservedAmount = Number(approved?.amount);
      if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0 ||
          typeof cost.currency !== "string" || cost.currency !== approved?.currency ||
          !Number.isFinite(reservedAmount) || cost.amount > reservedAmount ||
          typeof cost.evidenceReference !== "string" || !cost.evidenceReference.trim() || cost.evidenceReference.length > 1000) {
        throw fail("Actual provider cost does not match the approved reservation or lacks evidence.", "VIDEO_BUDGET_COST_UNRESOLVED");
      }
      let ingested;
      try { ingested = await ingestOutputs({ job, input, task, providerTaskId }); }
      catch (error) {
        const cleanupPending = error?.cleanupPending === true;
        const held = fail(
          cleanupPending
            ? "Private output ingestion failed and compensating asset cleanup is pending."
            : "Private output ingestion failed; the completed provider task is held for review.",
          cleanupPending ? "VIDEO_OUTPUT_INGESTION_CLEANUP_PENDING" : "VIDEO_OUTPUT_INGESTION_REQUIRES_REVIEW"
        );
        if (cleanupPending) held.cleanupPending = true;
        throw held;
      }
      if (!ingested || !Array.isArray(ingested.assetIds) || ingested.assetIds.length !== task.outputUrls.length ||
          ingested.assetIds.some(id => typeof id !== "string" || !id.trim())) {
        throw fail("Private output ingestion did not register every output asset.", "VIDEO_OUTPUT_INGESTION_REQUIRES_REVIEW");
      }
      return Object.freeze({
        provider: input.provider,
        model: input.model,
        providerTaskId,
        assetIds: Object.freeze([...ingested.assetIds]),
        usage: ingested.usage || null,
        actualAmount: cost.amount,
        currency: cost.currency,
        costEvidenceReference: cost.evidenceReference
      });
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw fail("Provider returned an unsupported task state.", "VIDEO_PROVIDER_STATUS_INVALID");
    }
    if (attempt + 1 < maxPolls) await sleep(interval);
  }
  throw fail("Video generation is still running; polling will resume on a later lease.", "VIDEO_PROVIDER_POLL_DEFERRED");
}
