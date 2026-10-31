import { addJobEvent, json } from "./db.mjs";

const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function recoverExpiredJobs(db, timestamp = new Date().toISOString()) {
  const expired = db.prepare(
    "SELECT id,owner_id,attempt_count,max_attempts FROM jobs WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)"
  ).all(timestamp);
  let recovered = 0;
  for (const job of expired) {
    const retryable = job.attempt_count < job.max_attempts;
    const status = retryable ? "queued" : "failed";
    const retryDelayMs = retryable ? Math.min(60000, 1000 * Math.pow(2, Math.max(0, job.attempt_count - 1))) : 0;
    const availableAt = retryable ? iso(Date.parse(timestamp) + retryDelayMs) : null;
    const details = {
      code: "WORKER_LEASE_EXPIRED",
      message: "The worker stopped renewing its execution lease before the job finished.",
      retryable,
      retryDelayMs
    };
    const changed = db.prepare(
      "UPDATE jobs SET status=?,error_json=?,updated_at=?,completed_at=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE id=? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)"
    ).run(status, json(details), timestamp, retryable ? null : timestamp, availableAt, job.id, timestamp);
    if (changed.changes !== 1) continue;
    addJobEvent(db, job.id, job.owner_id, retryable ? "job.lease_expired_retry" : "job.lease_expired_failed", details);
    recovered++;
  }
  return recovered;
}

export function claimNextJob(db, workerId, leaseMs = 90000, timestamp = new Date().toISOString()) {
  const candidate = db.prepare(
    "SELECT id FROM jobs WHERE status='queued' AND (available_at IS NULL OR available_at<=?) ORDER BY created_at ASC LIMIT 1"
  ).get(timestamp);
  if (!candidate) return null;
  const expires = iso(Date.parse(timestamp) + leaseMs);
  const claimed = db.prepare(
    "UPDATE jobs SET status='running',progress=5,attempt_count=attempt_count+1,started_at=COALESCE(started_at,?),updated_at=?,lease_owner=?,lease_expires_at=?,lease_heartbeat_at=? WHERE id=? AND status='queued' AND (available_at IS NULL OR available_at<=?)"
  ).run(timestamp, timestamp, workerId, expires, timestamp, candidate.id, timestamp);
  if (claimed.changes !== 1) return null;
  return db.prepare("SELECT * FROM jobs WHERE id=? AND lease_owner=? AND status='running'").get(candidate.id, workerId) || null;
}

export function renewJobLease(db, jobId, workerId, leaseMs = 90000, timestamp = new Date().toISOString()) {
  const expires = iso(Date.parse(timestamp) + leaseMs);
  const result = db.prepare(
    "UPDATE jobs SET lease_expires_at=?,lease_heartbeat_at=? WHERE id=? AND status='running' AND lease_owner=?"
  ).run(expires, timestamp, jobId, workerId);
  return result.changes === 1;
}

export function releaseJobLease(db, jobId, workerId) {
  return db.prepare(
    "UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE id=? AND lease_owner=?"
  ).run(jobId, workerId).changes === 1;
}
