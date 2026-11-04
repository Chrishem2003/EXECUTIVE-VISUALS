import { estimateVideoGenerationCost } from "./video-generation-cost-estimator.mjs";
const SCHEMA = "executive_visuals";
const RPC = Object.freeze({
  enqueue: "enqueue_video_generation_job",
  finish: "finish_video_generation_job",
  defer: "defer_video_generation_job",
  quarantine: "quarantine_video_generation_job",
  resume: "resume_reconciled_video_generation_job",
  recover: "recover_expired_video_generation_jobs"
});

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud video enqueue URL must be a valid absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud video enqueue URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

export function createCloudVideoEnqueue({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud video enqueue requires server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud video enqueue requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cloud video enqueue timeout must be between 1000 and 120000 milliseconds.");
  const base = endpoint(url);

  async function call(name, args) {
    if (!Object.values(RPC).includes(name)) throw new Error("Unsupported cloud video enqueue operation.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: "Bearer " + serviceRoleKey,
          "content-type": "application/json",
          "accept-profile": SCHEMA,
          "content-profile": SCHEMA,
          accept: "application/json"
        },
        body: JSON.stringify(args),
        signal: controller.signal
      });
      const body = await response.text();
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); }
        catch { throw new Error("Cloud video enqueue returned a non-JSON response (HTTP " + response.status + ")."); }
      }
      if (!response.ok) {
        const message = typeof parsed?.message === "string" ? parsed.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300) : "Cloud video enqueue request failed.";
        const error = new Error(message);
        error.code = "CLOUD_VIDEO_ENQUEUE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud video enqueue request timed out.");
        timeout.code = "CLOUD_VIDEO_ENQUEUE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  function required(value, name, max = 256) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(name + " is required and must be bounded.");
    return value;
  }

  return Object.freeze({
    async enqueue({
      ownerId, projectId = null, idempotencyKey, provider, model, requestHash,
      input, budgetApprovalId, reservedAmount, currency
    } = {}) {
      required(ownerId, "Owner ID");
      if (projectId !== null) required(projectId, "Project ID");
      required(idempotencyKey, "Idempotency key", 180);
      required(provider, "Provider", 100);
      required(model, "Model", 160);
      required(budgetApprovalId, "Budget approval ID");
      if (!/^[A-Za-z0-9._:-]{1,180}$/.test(idempotencyKey)) throw new Error("Idempotency key has an invalid format.");
      if (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("Request hash must be a lowercase SHA-256 digest.");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Video generation input must be an object.");
      if (input.provider !== provider || input.model !== model || input.requestHash !== requestHash ||
          (input.projectId || null) !== projectId) throw new Error("Video generation input does not match its enqueue scope.");
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32000) throw new Error("Video generation input exceeds the 32000-byte limit.");
      if (typeof reservedAmount !== "number" || !Number.isFinite(reservedAmount) || reservedAmount <= 0 || reservedAmount > 100000000) {
        throw new Error("Reserved amount must be a positive bounded number.");
      }
      if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter uppercase code.");
      if (provider === "runway" && model === "gen4.5") {
        const estimate = estimateVideoGenerationCost({
          provider, model, durationSeconds: input.durationSeconds,
          outputFormat: input.outputFormat || "mp4"
        });
        if (currency !== estimate.currency) throw new Error("Runway Gen-4.5 budget approvals must use USD.");
        if (reservedAmount < estimate.amount) {
          const error = new Error("Budget reservation is below the verified Runway Gen-4.5 price estimate.");
          error.code = "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE";
          error.estimate = estimate;
          throw error;
        }
      }
      const rows = await call(RPC.enqueue, {
        p_owner_id: ownerId, p_project_id: projectId, p_idempotency_key: idempotencyKey,
        p_provider: provider, p_model: model, p_request_hash: requestHash, p_input: input,
        p_budget_approval_id: budgetApprovalId, p_reserved_amount: reservedAmount, p_currency: currency
      });
      if (!Array.isArray(rows) || rows.length !== 1 ||
          typeof rows[0]?.job_id !== "string" ||
          !["queued","submitted","processing","reviewing","succeeded","partial","failed","cancelled","blocked","needs_input","expired"].includes(rows[0]?.job_status) ||
          typeof rows[0]?.idempotent_replay !== "boolean" ||
          typeof rows[0]?.budget_reservation_id !== "string") {
        throw new Error("Cloud video enqueue returned an invalid job/reservation result.");
      }
      return Object.freeze({
        jobId: rows[0].job_id,
        status: rows[0].job_status,
        idempotentReplay: rows[0].idempotent_replay,
        budgetReservationId: rows[0].budget_reservation_id
      });
    },
    async defer({ jobId, workerId, delaySeconds = 30, reasonCode = "VIDEO_PROVIDER_POLL_DEFERRED" } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 900) throw new Error("Defer delay must be between 5 and 900 seconds.");
      if (typeof reasonCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(reasonCode)) throw new Error("Defer reason code is invalid.");
      const result = await call(RPC.defer, {
        p_job_id: jobId, p_worker_id: workerId, p_delay_seconds: delaySeconds, p_reason_code: reasonCode
      });
      if (typeof result !== "boolean") throw new Error("Cloud video defer returned an invalid result.");
      return result;
    },
    async quarantine({ jobId, workerId, reasonCode = "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION" } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (typeof reasonCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(reasonCode)) throw new Error("Quarantine reason code is invalid.");
      const result = await call(RPC.quarantine, {
        p_job_id: jobId, p_worker_id: workerId, p_reason_code: reasonCode
      });
      if (typeof result !== "boolean") throw new Error("Cloud video quarantine returned an invalid result.");
      return result;
    },
    async recoverExpiredVideo(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Video recovery limit must be between 1 and 1000.");
      const result = await call(RPC.recover, { p_limit: limit });
      if (!Number.isInteger(result) || result < 0) throw new Error("Cloud video recovery returned an invalid count.");
      return result;
    },
    async resumeReconciled({ jobId, ownerId, evidenceReference } = {}) {
      required(jobId, "Job ID");
      required(ownerId, "Owner ID");
      required(evidenceReference, "Evidence reference", 1000);
      const result = await call(RPC.resume, {
        p_job_id: jobId, p_owner_id: ownerId, p_evidence_reference: evidenceReference
      });
      if (typeof result !== "boolean") throw new Error("Cloud video resume returned an invalid result.");
      return result;
    },
    async finish({ jobId, workerId, status, output = null, error = null, actualAmount = null } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (!["succeeded", "partial", "failed", "cancelled"].includes(status)) throw new Error("Video job status must be terminal.");
      for (const [label, value] of [["output", output], ["error", error]]) {
        if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Job " + label + " must be an object or null.");
        if (value !== null && Buffer.byteLength(JSON.stringify(value), "utf8") > (label === "output" ? 32000 : 8000)) throw new Error("Job " + label + " exceeds its size limit.");
      }
      if (["succeeded", "partial"].includes(status)) {
        if (typeof actualAmount !== "number" || !Number.isFinite(actualAmount) || actualAmount < 0 || actualAmount > 100000000) {
          throw new Error("Successful video jobs require a non-negative bounded actual amount.");
        }
      } else if (actualAmount !== null) {
        throw new Error("Failed or cancelled video jobs must release their reservation without an actual amount.");
      }
      const result = await call(RPC.finish, {
        p_job_id: jobId, p_worker_id: workerId, p_status: status,
        p_output: output, p_error: error, p_actual_amount: actualAmount
      });
      if (typeof result !== "boolean") throw new Error("Cloud video job finalization returned an invalid result.");
      return result;
    }
  });
}
