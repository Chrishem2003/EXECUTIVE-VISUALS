const SCHEMA = "executive_visuals";
const RPC = Object.freeze({
  prepare: "prepare_video_generation_submission",
  begin: "begin_video_generation_submission_v2",
  record: "record_video_generation_submission_v2",
  unknown: "mark_video_generation_submission_unknown_v2",
  get: "get_video_generation_submission",
  reconcile: "reconcile_unknown_video_generation_submission",
  finish: "finish_video_generation_submission_v2"
});

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud video ledger URL must be a valid absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud video ledger URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

export function createCloudVideoSubmissionLedger({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud video ledger requires server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud video ledger requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cloud video ledger timeout must be between 1000 and 120000 milliseconds.");
  const base = endpoint(url);

  async function call(name, args) {
    if (!Object.values(RPC).includes(name)) throw new Error("Unsupported cloud video ledger operation.");
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
        catch { throw new Error("Cloud video ledger returned a non-JSON response (HTTP " + response.status + ")."); }
      }
      if (!response.ok) {
        const message = typeof parsed?.message === "string" ? parsed.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300) : "Cloud video ledger request failed.";
        const error = new Error(message);
        error.code = "CLOUD_VIDEO_LEDGER_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud video ledger request timed out.");
        timeout.code = "CLOUD_VIDEO_LEDGER_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  function required(value, name, max = 256) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(name + " is required and must be bounded.");
    return value;
  }
  function leaseToken(value) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("A valid worker lease token is required."); return value; }
  function booleanResult(value, operation) {
    if (typeof value !== "boolean") throw new Error("Cloud video ledger " + operation + " returned an invalid result.");
    return value;
  }

  return Object.freeze({
    async prepare({ jobId, ownerId, provider, model, requestHash } = {}) {
      required(jobId, "Job ID"); required(ownerId, "Owner ID"); required(provider, "Provider", 100); required(model, "Model", 160);
      if (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("Request hash must be a lowercase SHA-256 digest.");
      const rows = await call(RPC.prepare, { p_job_id: jobId, p_owner_id: ownerId, p_provider: provider, p_model: model, p_request_hash: requestHash });
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.job_id !== jobId || rows[0]?.owner_id !== ownerId || rows[0]?.request_hash !== requestHash) {
        throw new Error("Cloud video ledger prepare returned an invalid or mismatched record.");
      }
      return rows[0];
    },
    async begin(jobId, workerId, token) {
      required(jobId, "Job ID"); required(workerId, "Worker ID", 128);
      return booleanResult(await call(RPC.begin, { p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken(token) }), "begin");
    },
    async record(jobId, workerId, providerTaskId, metadata = {}, token) {
      required(jobId, "Job ID"); required(workerId, "Worker ID", 128); required(providerTaskId, "Provider task ID");
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Submission metadata must be an object.");
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 8000) throw new Error("Submission metadata exceeds the 8000-byte limit.");
      return booleanResult(await call(RPC.record, { p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken(token), p_provider_task_id: providerTaskId, p_metadata: metadata }), "record");
    },
    async markUnknown(jobId, workerId, errorCode = "VIDEO_SUBMISSION_AMBIGUOUS", token) {
      required(jobId, "Job ID"); required(workerId, "Worker ID", 128); required(errorCode, "Error code", 100);
      return booleanResult(await call(RPC.unknown, { p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken(token), p_error_code: errorCode }), "mark unknown");
    },
    async reconcileUnknown(jobId, providerTaskId, evidenceReference, metadata = {}) {
      required(jobId, "Job ID"); required(providerTaskId, "Provider task ID"); required(evidenceReference, "Evidence reference", 1000);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Submission metadata must be an object.");
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 8000) throw new Error("Submission metadata exceeds the 8000-byte limit.");
      return booleanResult(await call(RPC.reconcile, { p_job_id: jobId, p_provider_task_id: providerTaskId, p_evidence_reference: evidenceReference, p_metadata: metadata }), "reconcile");
    },
    async finish(jobId, workerId, state, metadata = {}, token) {
      required(jobId, "Job ID"); required(workerId, "Worker ID", 128);
      if (!["succeeded", "failed", "cancelled"].includes(state)) throw new Error("Submission terminal state must be succeeded, failed or cancelled.");
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Submission metadata must be an object.");
      if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 8000) throw new Error("Submission metadata exceeds the 8000-byte limit.");
      return booleanResult(await call(RPC.finish, { p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken(token), p_state: state, p_metadata: metadata }), "finish");
    },
    async get(jobId) {
      required(jobId, "Job ID");
      const rows = await call(RPC.get, { p_job_id: jobId });
      if (!Array.isArray(rows) || rows.length > 1 || (rows[0] && rows[0].job_id !== jobId)) throw new Error("Cloud video ledger get returned an invalid result.");
      return rows[0] || null;
    }
  });
}