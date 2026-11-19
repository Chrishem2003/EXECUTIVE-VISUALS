const SCHEMA = "executive_visuals";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_TOKEN = UUID;
const fail = (message, code) => Object.assign(new Error(message), { code });

function objectOrNull(value, label) {
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error(label + " must be an object or null.");
  if (value && Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) throw new Error(label + " exceeds the 1 MiB limit.");
}

export function createNeonPostgresQueue({ pool, schema = SCHEMA } = {}) {
  if (!pool || typeof pool.query !== "function") throw new Error("Neon PostgreSQL queue requires a pg-compatible pool.");
  if (schema !== SCHEMA) throw new Error("Neon queue schema must be executive_visuals.");
  async function query(text, values = []) {
    try { return await pool.query(text, values); }
    catch (error) {
      const safe = fail(String(error?.message || "Neon PostgreSQL queue request failed.").slice(0, 300), "NEON_QUEUE_DATABASE_ERROR");
      safe.sqlState = typeof error?.code === "string" ? error.code : null;
      throw safe;
    }
  }
  function required(value, label, max = 256) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(label + " is required and must be bounded.");
    return value;
  }
  return Object.freeze({
    async enqueue({ ownerId, projectId = null, jobType, input, idempotencyKey = null, maxAttempts = 2 } = {}) {
      if (!UUID.test(String(ownerId || "")) || (projectId !== null && !UUID.test(String(projectId)))) throw new Error("Queue owner and optional project IDs must be UUIDs.");
      required(jobType, "Job type", 128);
      objectOrNull(input, "Job input");
      if (!input || Buffer.byteLength(JSON.stringify(input), "utf8") > 1024 * 1024) throw new Error("Job input must be an object no larger than 1 MiB.");
      if (idempotencyKey !== null) required(idempotencyKey, "Idempotency key", 200);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Maximum job attempts must be between 1 and 10.");
      const result = await query("select * from executive_visuals.enqueue_job_v1($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6)", [
        ownerId, projectId, jobType, JSON.stringify(input), idempotencyKey, maxAttempts
      ]);
      const row = result.rows?.[0];
      if (!row || !UUID.test(String(row.job_id || "")) || typeof row.status !== "string" || typeof row.replayed !== "boolean") {
        throw fail("Neon queue enqueue returned an invalid receipt.", "NEON_QUEUE_INVALID_RESULT");
      }
      return Object.freeze({ jobId: row.job_id, status: row.status, replayed: row.replayed });
    },
    async defer(jobId, workerId, leaseToken, delaySeconds = 5, error = null) {
      if (!UUID.test(String(jobId || "")) || !UUID.test(String(leaseToken || ""))) throw new Error("Job ID and lease token must be UUIDs.");
      required(workerId, "Worker ID", 128);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new Error("Deferral delay must be between 1 and 86400 seconds.");
      objectOrNull(error, "Job error");
      const result = await query("select executive_visuals.defer_job_v1($1::uuid,$2,$3::uuid,$4,$5::jsonb) as deferred", [
        jobId, workerId, leaseToken, delaySeconds, error === null ? null : JSON.stringify(error)
      ]);
      return result.rows?.[0]?.deferred === true;
    },
    async quarantine(jobId, workerId, leaseToken, error) {
      if (!UUID.test(String(jobId || "")) || !UUID.test(String(leaseToken || ""))) throw new Error("Job ID and lease token must be UUIDs.");
      required(workerId, "Worker ID", 128);
      if (!error || typeof error !== "object" || Array.isArray(error)) throw new Error("Quarantine requires a structured error object.");
      objectOrNull(error, "Quarantine error");
      const result = await query("select executive_visuals.quarantine_job_v1($1::uuid,$2,$3::uuid,$4::jsonb) as quarantined", [
        jobId, workerId, leaseToken, JSON.stringify(error)
      ]);
      return result.rows?.[0]?.quarantined === true;
    },
    async claim(workerId, leaseSeconds = 90, jobTypes = null) {
      required(workerId, "Worker ID", 128);
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Lease duration must be between 15 and 900 seconds.");
      if (jobTypes !== null && (!Array.isArray(jobTypes) || jobTypes.length < 1 || jobTypes.length > 100 || jobTypes.some(x => typeof x !== "string" || !x.trim() || x.length > 128) || new Set(jobTypes).size !== jobTypes.length)) throw new Error("Job type filters must be unique, non-empty strings.");
      const result = await query("select * from executive_visuals.claim_next_job_v2($1,$2,$3::text[])", [workerId, leaseSeconds, jobTypes]);
      if (!Array.isArray(result.rows) || result.rows.length > 1) throw fail("Neon queue claim returned an invalid result.", "NEON_QUEUE_INVALID_RESULT");
      const row = result.rows[0] || null;
      if (row && (row.status !== "processing" || row.lease_owner !== workerId || !row.lease_expires_at || !UUID.test(String(row.id)) || !LEASE_TOKEN.test(String(row.lease_token || "")))) throw fail("Neon queue returned a job without a valid fenced lease.", "NEON_QUEUE_INVALID_LEASE");
      return row;
    },
    async renew(jobId, workerId, leaseSeconds = 90, leaseToken) {
      if (!UUID.test(String(jobId || "")) || !UUID.test(String(leaseToken || ""))) throw new Error("Job ID and lease token must be UUIDs.");
      required(workerId, "Worker ID", 128);
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 900) throw new Error("Lease duration must be between 15 and 900 seconds.");
      const result = await query("select executive_visuals.renew_job_lease_v2($1::uuid,$2,$3::uuid,$4) as renewed", [jobId, workerId, leaseToken, leaseSeconds]);
      return result.rows?.[0]?.renewed === true;
    },
    async assertLease(jobId, workerId, leaseToken) {
      if (!UUID.test(String(jobId || "")) || !UUID.test(String(leaseToken || ""))) throw new Error("Job ID and lease token must be UUIDs.");
      required(workerId, "Worker ID", 128);
      const result = await query("select executive_visuals.assert_job_lease_v2($1::uuid,$2,$3::uuid) as valid", [jobId, workerId, leaseToken]);
      return result.rows?.[0]?.valid === true;
    },
    async cancellationRequested(jobId, workerId, leaseToken) {
      if (!UUID.test(String(jobId || "")) || !UUID.test(String(leaseToken || ""))) throw new Error("Job ID and lease token must be UUIDs.");
      required(workerId, "Worker ID", 128);
      const result = await query("select cancel_requested_at from executive_visuals.jobs where id=$1::uuid and status='processing' and lease_owner=$2 and lease_token=$3::uuid and lease_expires_at>clock_timestamp()", [jobId, workerId, leaseToken]);
      if (!result.rows?.length) return false;
      return result.rows[0].cancel_requested_at !== null && result.rows[0].cancel_requested_at !== undefined;
    },
    async recover(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Recovery limit must be between 1 and 1000.");
      const result = await query("select executive_visuals.recover_expired_jobs($1) as recovered", [limit]);
      const count = Number(result.rows?.[0]?.recovered);
      if (!Number.isInteger(count) || count < 0) throw fail("Neon queue recovery returned an invalid count.", "NEON_QUEUE_INVALID_RESULT");
      return count;
    },
    async finish(jobId, workerId, status, output = null, error = null, leaseToken) {
      if (!UUID.test(String(jobId || "")) || !UUID.test(String(leaseToken || ""))) throw new Error("Job ID and lease token must be UUIDs.");
      required(workerId, "Worker ID", 128);
      if (!["succeeded", "partial", "failed", "cancelled"].includes(status)) throw new Error("Invalid terminal job status.");
      objectOrNull(output, "Job output"); objectOrNull(error, "Job error");
      const result = await query("select executive_visuals.finish_job_v2($1::uuid,$2,$3::uuid,$4,$5::jsonb,$6::jsonb) as finished", [jobId, workerId, leaseToken, status, output === null ? null : JSON.stringify(output), error === null ? null : JSON.stringify(error)]);
      return result.rows?.[0]?.finished === true;
    },
    async checkReadiness() {
      const result = await query("select current_database() as database_name, current_schema() as schema_name, to_regclass('executive_visuals.jobs') is not null as jobs_ready, to_regclass('executive_visuals.job_events') is not null as events_ready");
      const row = result.rows?.[0];
      return { backend: "neon-postgres", configured: true, ready: row?.jobs_ready === true && row?.events_ready === true, durableAcrossDeploys: true, database: row?.database_name || null };
    },
    async close() { if (typeof pool.end === "function") await pool.end(); }
  });
}
