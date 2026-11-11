const fail = (message, code) => Object.assign(new Error(message), { code });
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
  resolveAdapter,
  ingestOutputs,
  resolveActualCost,
  customerCredits,
  signal
} = {}) {
  if (!job?.id || !job?.owner_id || job.job_type !== "video.generate" ||
      typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw fail("Cloud video executor requires an owned leased video.generate job.", "VIDEO_JOB_INVALID");
  }
  if (!ledger || typeof ledger.prepare !== "function" || typeof ledger.begin !== "function" ||
      typeof ledger.record !== "function" || typeof ledger.markUnknown !== "function") {
    throw new Error("Cloud video executor requires the Postgres submission ledger.");
  }
  if (adapter !== undefined && typeof resolveAdapter === "function") {
    throw fail("Provide either a fixed adapter or an adapter resolver, not both.", "VIDEO_ADAPTER_CONFIGURATION_INVALID");
  }

  const input = jobInput(job);
  let selectedAdapter = adapter;
  if (typeof resolveAdapter === "function") {
    try { selectedAdapter = await resolveAdapter({ provider: input.provider, model: input.model, job }); }
    catch { throw fail("No authorized execution adapter is registered for this provider/model.", "VIDEO_ADAPTER_UNAVAILABLE"); }
  }
  if (!selectedAdapter || typeof selectedAdapter.provider !== "string" || !selectedAdapter.provider.trim() ||
      typeof selectedAdapter.model !== "string" || !selectedAdapter.model.trim() ||
      typeof selectedAdapter.submit !== "function" || typeof selectedAdapter.getStatus !== "function") {
    throw fail("A supported, model-bound remote video adapter is required.", "VIDEO_ADAPTER_UNAVAILABLE");
  }
  if (input.provider !== selectedAdapter.provider || input.model !== selectedAdapter.model ||
      typeof input.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw fail("Cloud video job provider, model or request hash is inconsistent.", "VIDEO_JOB_INPUT_MISMATCH");
  }
  const selectedIngestOutputs = typeof ingestOutputs === "function" ? ingestOutputs : selectedAdapter.ingestOutputs;
  const selectedResolveActualCost = typeof resolveActualCost === "function" ? resolveActualCost : selectedAdapter.resolveActualCost;
  if (typeof selectedIngestOutputs !== "function" || typeof selectedResolveActualCost !== "function") {
    throw fail("Provider-specific private output ingestion and authoritative cost resolution are mandatory.", "VIDEO_EXECUTION_GATES_MISSING");
  }
  if (signal?.aborted) throw fail("Cloud video job was cancelled before execution.", "VIDEO_JOB_CANCELLED");

  const prepared = await ledger.prepare({
    jobId: job.id, ownerId: job.owner_id, provider: input.provider,
    model: input.model, requestHash: input.requestHash
  });
  let state = prepared.state;
  let providerTaskId = prepared.provider_task_id || null;
  let submissionMetadata = prepared.metadata && typeof prepared.metadata === "object" && !Array.isArray(prepared.metadata)
    ? prepared.metadata : {};
  if (state === "unknown" || state === "submitting") {
    throw fail("Provider submission outcome is ambiguous and requires reconciliation.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  }
  if (state !== "prepared" && state !== "submitted") {
    throw fail("Cloud video submission ledger is already terminal.", "VIDEO_SUBMISSION_TERMINAL");
  }

  if (state === "prepared") {
    const providerInput = typeof selectedAdapter.prepareInput === "function"
      ? await selectedAdapter.prepareInput(input, { job })
      : input;
    let preflightQuote = null;
    if (typeof selectedAdapter.preflight === "function") {
      try {
        preflightQuote = await selectedAdapter.preflight(providerInput, { job });
      } catch {
        throw fail("Provider preflight could not establish a safe generation quote; no paid task was submitted.", "VIDEO_PREFLIGHT_REJECTED");
      }
      const reservedAmount = Number(job.estimated_cost?.amount);
      if (!preflightQuote || preflightQuote.billable !== false ||
          typeof preflightQuote.estimatedUsd !== "number" || !Number.isFinite(preflightQuote.estimatedUsd) ||
          preflightQuote.estimatedUsd < 0 || preflightQuote.currency !== job.estimated_cost?.currency ||
          !Number.isFinite(reservedAmount) || preflightQuote.estimatedUsd > reservedAmount ||
          typeof preflightQuote.model !== "string" || !preflightQuote.model.trim()) {
        throw fail("Provider preflight quote is invalid or exceeds the approved reservation; no paid task was submitted.", "VIDEO_PREFLIGHT_REJECTED");
      }
    }
    const began = await ledger.begin(job.id, workerId);
    if (!began) throw fail("Another worker owns the provider submission transition.", "VIDEO_SUBMISSION_IN_PROGRESS");
    let submitted;
    try {
      submitted = await selectedAdapter.submit(providerInput, { job, preflightQuote });
    } catch (error) {
      try { await ledger.markUnknown(job.id, workerId, error?.code || "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN"); } catch {}
      throw fail("Provider submission outcome is unknown and has been quarantined.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    if (!submitted || typeof submitted.taskId !== "string" || !submitted.taskId.trim()) {
      try { await ledger.markUnknown(job.id, workerId, "PROVIDER_TASK_ID_MISSING"); } catch {}
      throw fail("Provider did not return a durable task ID; reconciliation is required.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    let recordMetadata;
    try {
      if (submitted.metadata !== undefined &&
          (!submitted.metadata || typeof submitted.metadata !== "object" || Array.isArray(submitted.metadata))) {
        throw fail("Provider submission metadata must be a JSON object.", "VIDEO_SUBMISSION_METADATA_INVALID");
      }
      const submittedMetadata = submitted.metadata || {};
      const metadataText = JSON.stringify(submittedMetadata);
      if (Buffer.byteLength(metadataText) > 7000) {
        throw fail("Provider submission metadata exceeded the durable ledger limit.", "VIDEO_SUBMISSION_METADATA_INVALID");
      }
      recordMetadata = { acceptedStatus: submitted.status || "queued", ...(preflightQuote ? { preflightQuote: { configId: preflightQuote.configId, model: preflightQuote.model, provider: preflightQuote.provider, estimatedCredits: preflightQuote.estimatedCredits, estimatedUsd: preflightQuote.estimatedUsd, currency: preflightQuote.currency } } : {}), ...submittedMetadata };
      if (Buffer.byteLength(JSON.stringify(recordMetadata)) > 7000) throw fail("Durable provider submission metadata exceeded the ledger limit.", "VIDEO_SUBMISSION_METADATA_INVALID");
      const recorded = await ledger.record(job.id, workerId, submitted.taskId, recordMetadata);
      if (!recorded) throw new Error("Provider task ID was not recorded.");
    } catch {
      // The RPC may have committed despite a lost response. The job is held
      // for reconciliation instead of risking a second paid POST.
      throw fail("Provider task ID persistence is uncertain; reconciliation is required.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    providerTaskId = submitted.taskId;
    submissionMetadata = recordMetadata;
    state = "submitted";
  }

  if (state !== "submitted" || !providerTaskId) {
    throw fail("Cloud video submission has no pollable provider task ID.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  }

  if (signal?.aborted) throw fail("Cloud video worker lease was lost.", "VIDEO_WORKER_LEASE_LOST");
  let task;
  try {
    task = await selectedAdapter.getStatus(providerTaskId, { job, workerId });
  } catch {
    throw fail("Provider status is temporarily unavailable; polling will resume on a later lease.", "VIDEO_PROVIDER_POLL_DEFERRED");
  }
  if (signal?.aborted) throw fail("Cloud video worker lease was lost.", "VIDEO_WORKER_LEASE_LOST");
  if (task.status === "canceled") {
    // Provider cancellation is not proof of a refund. Runway may still charge
    // when cancellation races with a transition to RUNNING, so retain the
    // reservation and require provider billing evidence before settlement.
    throw fail("Provider task is canceled, but its final billable amount is not yet verified; retain the reservation for reconciliation.", "VIDEO_PROVIDER_CANCELLATION_COST_UNRESOLVED");
  }
  if (task.status === "failed") {
    throw fail(task.failure || "Video provider task failed.", task.failureCode || "VIDEO_PROVIDER_FAILED");
  }
  if (task.status !== "succeeded") {
    if (task.status !== "queued" && task.status !== "running") {
      throw fail("Provider returned an unsupported task state.", "VIDEO_PROVIDER_STATUS_INVALID");
    }
    throw fail("Video generation is still running; polling will resume on a later lease.", "VIDEO_PROVIDER_POLL_DEFERRED");
  }
  if (!Array.isArray(task.outputUrls) || task.outputUrls.length < 1 || task.outputUrls.length > 10) {
    throw fail("Provider completed without a bounded output collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
  }
  let cost;
  try { cost = await selectedResolveActualCost({ job, input, task, providerTaskId, submissionMetadata }); }
  catch { throw fail("Actual provider cost could not be verified; budget remains reserved for review.", "VIDEO_BUDGET_COST_UNRESOLVED"); }
  if (signal?.aborted) throw fail("Cloud video worker lease was lost.", "VIDEO_WORKER_LEASE_LOST");
  const approved = job.estimated_cost;
  const reservedAmount = Number(approved?.amount);
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0 ||
      typeof cost.currency !== "string" || cost.currency !== approved?.currency ||
      !Number.isFinite(reservedAmount) || cost.amount > reservedAmount ||
      typeof cost.evidenceReference !== "string" || !cost.evidenceReference.trim() || cost.evidenceReference.length > 1000) {
    throw fail("Actual provider cost does not match the approved reservation or lacks evidence.", "VIDEO_BUDGET_COST_UNRESOLVED");
  }
  let customerCreditSettlement = null;
  if (input.workflowQuoteId) {
    if (!customerCredits || typeof customerCredits.settleJob !== "function") {
      throw fail("Workflow generation completed without a customer-credit settlement service.", "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNAVAILABLE");
    }
    if (!Number.isSafeInteger(cost.actualCredits) || cost.actualCredits < 0 || cost.actualCredits > 1000000000) {
      throw fail("Provider cost evidence did not include an authoritative integer customer-credit amount.", "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED");
    }
    try {
      customerCreditSettlement = await customerCredits.settleJob({
        jobId: job.id,
        ownerId: job.owner_id,
        provider: input.provider,
        actualCredits: cost.actualCredits,
        evidence: {
          provider: input.provider,
          evidenceType: "provider_task_receipt",
          evidenceId: providerTaskId,
          evidenceReference: cost.evidenceReference
        }
      });
    } catch {
      throw fail("Provider cost is known but customer-credit settlement could not be durably confirmed; job requires reconciliation.", "VIDEO_CUSTOMER_CREDIT_SETTLEMENT_UNRESOLVED");
    }
  }
  let ingested;
  try { ingested = await selectedIngestOutputs({ job, input, task, providerTaskId }); }
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
  if (signal?.aborted) throw fail("Cloud video worker lease was lost.", "VIDEO_WORKER_LEASE_LOST");
  if (!ingested || !Array.isArray(ingested.assetIds) || ingested.assetIds.length !== task.outputUrls.length ||
      ingested.assetIds.some(id => typeof id !== "string" || !id.trim())) {
    throw fail("Private output ingestion did not register every output asset.", "VIDEO_OUTPUT_INGESTION_REQUIRES_REVIEW");
  }
  return Object.freeze({
    provider: input.provider,
    model: typeof cost.model === "string" && cost.model.trim() ? cost.model : input.model,
    providerTaskId,
    assetIds: Object.freeze([...ingested.assetIds]),
    usage: ingested.usage || null,
    actualAmount: cost.amount,
    currency: cost.currency,
    costEvidenceReference: cost.evidenceReference,
    customerCreditSettlement
  });
}
