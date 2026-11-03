const SCHEMA = "executive_visuals";
const RPC = new Set(["claim_next_job","renew_job_lease","recover_expired_jobs","recover_expired_jobs_by_type","finish_job","retry_job","report_job_progress","check_job_cancellation"]);

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud queue URL must be a valid absolute URL."); }
  const local = ["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud queue URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

export function createCloudQueue({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud queue requires server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud queue requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cloud queue timeout must be between 1000 and 120000 milliseconds.");
  const base = endpoint(url);

  async function call(name, args) {
    if (!RPC.has(name)) throw new Error("Unsupported cloud queue operation.");
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
        catch { throw new Error("Cloud queue returned a non-JSON response (HTTP " + response.status + ")."); }
      }
      if (!response.ok) {
        const message = typeof parsed?.message === "string" ? parsed.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300) : "Cloud queue request failed.";
        const error = new Error(message);
        error.code = "CLOUD_QUEUE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud queue request timed out.");
        timeout.code = "CLOUD_QUEUE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async claim(workerId, leaseSeconds = 90, jobTypes = null) {
      if (typeof workerId !== "string" || workerId.trim().length < 1 || workerId.length > 128) throw new Error("Worker ID must contain between 1 and 128 characters.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Lease duration must be between 15 and 900 seconds.");
      if (jobTypes !== null && (!Array.isArray(jobTypes) || jobTypes.length < 1 || jobTypes.length > 100 || jobTypes.some(type => typeof type !== "string" || !type.trim() || type.length > 128) || new Set(jobTypes).size !== jobTypes.length)) {
        throw new Error("Job type filters must be a non-empty list of unique, non-empty strings.");
      }
      const args = { p_worker_id: workerId, p_lease_seconds: leaseSeconds };
      if (jobTypes !== null) args.p_job_types = jobTypes;
      const rows = await call("claim_next_job", args);
      if (rows === null || rows === undefined) return null;
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("Cloud queue claim returned an invalid result.");
      const row = rows[0] || null;
      if (row && (row.status !== "processing" || row.lease_owner !== workerId || !row.lease_expires_at || !row.id)) {
        throw new Error("Cloud queue returned a job without a valid worker lease.");
      }
      return row;
    },
    async renew(jobId, workerId, leaseSeconds = 90) {
      if (!jobId || !workerId) throw new Error("Job ID and worker ID are required to renew a lease.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Lease duration must be between 15 and 900 seconds.");
      return (await call("renew_job_lease", { p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: leaseSeconds })) === true;
    },
    async recover(limit = 100, jobTypes = null) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Recovery limit must be between 1 and 1000.");
      if (jobTypes !== null && (!Array.isArray(jobTypes) || jobTypes.length < 1 || jobTypes.length > 100 || jobTypes.some(type => typeof type !== "string" || !type.trim() || type.length > 128) || new Set(jobTypes).size !== jobTypes.length)) {
        throw new Error("Recovery job type filters must be a non-empty list of unique, non-empty strings.");
      }
      const result = jobTypes === null
        ? await call("recover_expired_jobs", { p_limit: limit })
        : await call("recover_expired_jobs_by_type", { p_limit: limit, p_job_types: jobTypes });
      if (!Number.isInteger(result) || result < 0) throw new Error("Cloud queue recovery returned an invalid count.");
      return result;
    },
    async retry(jobId, workerId, error) {
      if (typeof jobId !== "string" || !jobId.trim() || typeof workerId !== "string" || !workerId.trim()) {
        throw new Error("Job ID and worker ID are required to schedule a retry.");
      }
      if (!error || typeof error !== "object" || Array.isArray(error)) {
        throw new Error("Job retry error must be an object.");
      }
      const result = await call("retry_job", { p_job_id: jobId, p_worker_id: workerId, p_error: error });
      if (!result || typeof result !== "object" || Array.isArray(result)
        || typeof result.accepted !== "boolean"
        || !["queued", "failed", "lease_lost", "cancelled"].includes(result.status)
        || typeof result.retryable !== "boolean"
        || !Number.isInteger(result.delaySeconds) || result.delaySeconds < 0
        || !Number.isInteger(result.attempt) || result.attempt < 0
        || !Number.isInteger(result.maxAttempts) || result.maxAttempts < 1
        || result.attempt > result.maxAttempts
        || (result.status === "lease_lost" && (result.accepted || result.retryable || result.delaySeconds !== 0))
        || (result.status === "queued" && (!result.accepted || !result.retryable || result.attempt >= result.maxAttempts))
        || (result.status === "failed" && (!result.accepted || result.retryable || result.delaySeconds !== 0))\n        || (result.status === "cancelled" && (!result.accepted || result.retryable || result.delaySeconds !== 0))) {
        throw new Error("Cloud queue retry returned an invalid result.");
      }
      return result;
    },
    async checkCancellation(jobId, workerId) {
      if (typeof jobId !== "string" || !jobId.trim() || typeof workerId !== "string" || !workerId.trim()) throw new Error("Job ID and worker ID are required to check cancellation.");
      const result = await call("check_job_cancellation", { p_job_id: jobId, p_worker_id: workerId });
      if (!result || typeof result !== "object" || Array.isArray(result)
        || typeof result.leaseValid !== "boolean" || typeof result.cancelRequested !== "boolean"
        || (!result.leaseValid && result.cancelRequested)) {
        throw new Error("Cloud queue cancellation check returned an invalid result.");
      }
      return { leaseValid: result.leaseValid, cancelRequested: result.cancelRequested };
    },
    async reportProgress(jobId, workerId, progress) {
      if (typeof jobId !== "string" || !jobId.trim() || typeof workerId !== "string" || !workerId.trim()) throw new Error("Job ID and worker ID are required to report progress.");
      if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error("Job progress must be between 0 and 100.");
      const result = await call("report_job_progress", { p_job_id: jobId, p_worker_id: workerId, p_progress: progress });
      if (typeof result !== "boolean") throw new Error("Cloud queue progress returned an invalid result.");
      return result;
    },
    async finish(jobId, workerId, status, output = null, error = null) {
      if (!jobId || !workerId) throw new Error("Job ID and worker ID are required to finish a job.");
      if (!["succeeded","partial","failed","cancelled"].includes(status)) throw new Error("Invalid terminal job status.");
      for (const [label, value] of [["output", output], ["error", error]]) {
        if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("Job " + label + " must be an object or null.");
      }
      return (await call("finish_job", {
        p_job_id: jobId, p_worker_id: workerId, p_status: status,
        p_output: output, p_error: error
      })) === true;
    }
  });
}
