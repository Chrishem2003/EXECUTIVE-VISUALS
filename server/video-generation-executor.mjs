import { createVideoSubmissionLedger } from "./video-generation-submissions.mjs";

const fail = (message, code) => Object.assign(new Error(message), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseJobInput(job) {
  try {
    const value = JSON.parse(job?.input_json || "");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw fail("Queued video job contains invalid request data.", "VIDEO_JOB_INPUT_INVALID");
  }
}

/**
 * Executes one already-leased video.generate job.
 *
 * Provider submission is deliberately one-shot. If the POST outcome is
 * ambiguous, the durable submission ledger quarantines it; lease retries
 * resume polling only after a task ID is known and never repeat the POST.
 * Output ingestion is an injected trust boundary and must use private,
 * allowlisted storage ingestion plus media validation before returning.
 */
export async function executeVideoGenerationJob({
  db,
  job,
  adapter,
  ingestOutputs,
  sleep = delay,
  maxPolls = 120,
  pollIntervalMs,
  onProgress = () => {},
  onEvent = () => {}
} = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("Video executor requires the application database.");
  if (!job || job.job_type !== "video.generate" || !job.id || !job.owner_id) {
    throw fail("Video executor requires an owned video.generate job.", "VIDEO_JOB_INVALID");
  }
  if (!adapter || adapter.provider !== "runway" || typeof adapter.submit !== "function" || typeof adapter.getStatus !== "function") {
    throw fail("A supported video provider adapter is required.", "VIDEO_ADAPTER_UNAVAILABLE");
  }
  if (typeof ingestOutputs !== "function") {
    throw fail("Secure private output ingestion is not configured; video execution remains unavailable.", "VIDEO_OUTPUT_INGESTION_UNAVAILABLE");
  }
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 1000) throw new Error("Video polling limit is invalid.");

  const input = parseJobInput(job);
  const requestHash = input.requestHash;
  const ledger = createVideoSubmissionLedger({ db });
  const prepared = ledger.prepare({
    jobId: job.id,
    ownerId: job.owner_id,
    provider: input.provider,
    model: input.model,
    requestHash
  });
  let submission = prepared.submission;
  if (submission.state === "unknown" || submission.state === "submitting") {
    throw fail("Provider submission outcome is ambiguous and requires reconciliation; it will not be resubmitted.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
  }
  if (["succeeded", "failed", "cancelled"].includes(submission.state)) {
    if (submission.state === "succeeded") return submission.metadata.result;
    throw fail("The provider submission is already terminal: " + submission.state + ".", "VIDEO_PROVIDER_TERMINAL");
  }

  if (submission.state === "prepared") {
    const begun = ledger.beginSubmission(job.id);
    if (!begun.started) {
      throw fail("Another worker already began this provider submission.", "VIDEO_SUBMISSION_IN_PROGRESS");
    }
    onEvent({ type: "video.provider_submission_started", jobId: job.id, provider: input.provider, model: input.model });
    let task;
    try {
      task = await adapter.submit(input);
    } catch (error) {
      // A transport error can occur after provider acceptance. Never retry
      // the POST automatically, even for a nominally transient failure.
      ledger.markUnknown(job.id, error?.code || "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN");
      throw fail("Provider submission outcome is unknown; operator reconciliation is required.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    if (!task?.taskId) {
      ledger.markUnknown(job.id, "PROVIDER_TASK_ID_MISSING");
      throw fail("Provider did not return a task ID; submission is quarantined.", "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    }
    submission = ledger.recordSubmitted(job.id, task.taskId, { acceptedStatus: task.status });
  }

  if (submission.state !== "submitted" || !submission.providerTaskId) {
    throw fail("Video provider task is not in a pollable state.", "VIDEO_SUBMISSION_STATE_INVALID");
  }

  const interval = Math.max(5000, Number(pollIntervalMs || adapter.minimumPollIntervalMs || 5000));
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const task = await adapter.getStatus(submission.providerTaskId);
    onProgress(Math.min(90, 10 + Math.floor((attempt / maxPolls) * 80)));
    onEvent({ type: "video.provider_task_status", jobId: job.id, taskId: submission.providerTaskId, status: task.status });
    if (task.status === "failed" || task.status === "canceled") {
      ledger.markTerminal(job.id, task.status === "failed" ? "failed" : "cancelled", {
        providerFailureCode: task.failureCode || null,
        providerFailure: task.failure || null
      });
      throw fail(task.failure || "Video provider task did not complete.", task.failureCode || "VIDEO_PROVIDER_FAILED");
    }
    if (task.status === "succeeded") {
      if (!Array.isArray(task.outputUrls) || task.outputUrls.length < 1 || task.outputUrls.length > 10) {
        throw fail("Provider completed without a bounded set of output URLs.", "VIDEO_PROVIDER_OUTPUT_INVALID");
      }
      const result = await ingestOutputs({ job, input, task, submission });
      if (!result || !Array.isArray(result.assetIds) || result.assetIds.length !== task.outputUrls.length ||
          result.assetIds.some(id => typeof id !== "string" || !id.trim())) {
        throw fail("Secure output ingestion did not return one registered asset ID per provider output.", "VIDEO_OUTPUT_INGESTION_INVALID");
      }
      const finalResult = Object.freeze({
        provider: input.provider,
        model: input.model,
        providerTaskId: submission.providerTaskId,
        assetIds: Object.freeze([...result.assetIds]),
        usage: result.usage || null
      });
      ledger.markTerminal(job.id, "succeeded", { result: finalResult });
      onProgress(95);
      return finalResult;
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw fail("Provider returned an unsupported task state.", "VIDEO_PROVIDER_STATUS_INVALID");
    }
    if (attempt + 1 < maxPolls) await sleep(interval);
  }
  // The provider task ID is durable, so the local queue may retry this job
  // safely: the next attempt resumes polling and does not submit again.
  throw fail("Video generation is still running; resume polling on the next leased attempt.", "VIDEO_PROVIDER_POLL_DEFERRED");
}
