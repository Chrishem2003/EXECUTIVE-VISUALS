const SCHEMA = "executive_visuals";
const RPC = new Set(["claim_next_job_v2","renew_job_lease_v2","recover_expired_jobs","finish_job_v2","assert_job_lease_v2"]);
const LEASE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      const rows = await call("claim_next_job_v2", args);
      if (rows === null || rows === undefined) return null;
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("Cloud queue claim returned an invalid result.");
      const row = rows[0] || null;
      if (row && (row.status !== "processing" || row.lease_owner !== workerId || !row.lease_expires_at || !row.id || !LEASE_TOKEN.test(row.lease_token || ""))) {
        throw new Error("Cloud queue returned a job without a valid worker lease.");
      }
      return row;
    },
    async renew(jobId, workerId, leaseSeconds = 90, leaseToken) {
      if (!jobId || !workerId || !LEASE_TOKEN.test(leaseToken || "")) throw new Error("Job ID, worker ID and a valid lease token are required to renew a lease.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Lease duration must be between 15 and 900 seconds.");
      return (await call("renew_job_lease_v2", { p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken, p_lease_seconds: leaseSeconds })) === true;
    },
    async assertLease(jobId, workerId, leaseToken) {
      if (!jobId || !workerId || !LEASE_TOKEN.test(leaseToken || "")) throw new Error("Job ID, worker ID and a valid lease token are required to verify a lease.");
      return (await call("assert_job_lease_v2", { p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken })) === true;
    },
    async recover(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Recovery limit must be between 1 and 1000.");
      const result = await call("recover_expired_jobs", { p_limit: limit });
      if (!Number.isInteger(result) || result < 0) throw new Error("Cloud queue recovery returned an invalid count.");
      return result;
    },
    async finish(jobId, workerId, status, output = null, error = null, leaseToken) {
      if (!jobId || !workerId || !LEASE_TOKEN.test(leaseToken || "")) throw new Error("Job ID, worker ID and a valid lease token are required to finish a job.");
      if (!["succeeded","partial","failed","cancelled"].includes(status)) throw new Error("Invalid terminal job status.");
      for (const [label, value] of [["output", output], ["error", error]]) {
        if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("Job " + label + " must be an object or null.");
      }
      return (await call("finish_job_v2", {
        p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken, p_status: status,
        p_output: output, p_error: error
      })) === true;
    }
  });
}
