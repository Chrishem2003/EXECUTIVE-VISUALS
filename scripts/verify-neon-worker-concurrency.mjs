import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for the disposable PostgreSQL worker concurrency test.");

const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000 });
const ownerId = randomUUID();
const jobType = "test.neon.concurrent";
const key = prefix => "ci-worker-concurrency-" + prefix + "-" + randomUUID();

async function enqueue(idempotencyKey, maxAttempts = 2) {
  const result = await pool.query(
    "select * from executive_visuals.enqueue_job_v1($1::uuid,null,$2,$3::jsonb,$4,$5)",
    [ownerId, jobType, JSON.stringify({ test: "worker-concurrency" }), idempotencyKey, maxAttempts]
  );
  if (!result.rows[0]?.job_id) throw new Error("Disposable queue job was not admitted.");
  return result.rows[0].job_id;
}

async function claimWithIndependentConnection(workerId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "select id,lease_token from executive_visuals.claim_next_job_v2($1,90,$2::text[])",
      [workerId, [jobType]]
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

try {
  // Two independent PostgreSQL sessions must never claim the same queued job.
  const concurrentIds = [await enqueue(key("parallel-a")), await enqueue(key("parallel-b"))];
  const claims = await Promise.all([
    claimWithIndependentConnection("ci-neon-worker-a"),
    claimWithIndependentConnection("ci-neon-worker-b")
  ]);
  const claimedIds = claims.filter(Boolean).map(row => row.id);
  if (claimedIds.length !== 2 || new Set(claimedIds).size !== 2 ||
      claimedIds.some(id => !concurrentIds.includes(id))) {
    throw new Error("Concurrent workers did not receive two distinct fenced jobs.");
  }

  // Expire a lease, recover it, reclaim it, then prove the old fencing token is inert.
  const fencedJobId = await enqueue(key("fencing"));
  const first = await claimWithIndependentConnection("ci-neon-fencing-worker");
  // The two concurrent jobs are already processing, so the next claim is the fencing job.
  if (!first || first.id !== fencedJobId) throw new Error("Could not claim the fencing test job.");
  await pool.query(
    "update executive_visuals.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1::uuid",
    [fencedJobId]
  );
  const recovered = await pool.query("select executive_visuals.recover_expired_jobs(10) as count");
  if (Number(recovered.rows[0]?.count) < 1) throw new Error("Expired worker lease was not recovered.");
  await pool.query("update executive_visuals.jobs set available_at=clock_timestamp() where id=$1::uuid and status='queued'", [fencedJobId]);
  const second = await claimWithIndependentConnection("ci-neon-fencing-worker");
  if (!second || second.id !== fencedJobId || second.lease_token === first.lease_token) {
    throw new Error("Reclaimed job did not receive a fresh fencing token.");
  }
  const staleDefer = await pool.query(
    "select executive_visuals.defer_job_v1($1::uuid,$2,$3::uuid,3600,'{"code":"STALE_CALLBACK"}'::jsonb) as accepted",
    [fencedJobId, "ci-neon-fencing-worker", first.lease_token]
  );
  const staleQuarantine = await pool.query(
    "select executive_visuals.quarantine_job_v1($1::uuid,$2,$3::uuid,'{"code":"STALE_CALLBACK"}'::jsonb) as accepted",
    [fencedJobId, "ci-neon-fencing-worker", first.lease_token]
  );
  if (staleDefer.rows[0]?.accepted !== false || staleQuarantine.rows[0]?.accepted !== false) {
    throw new Error("A stale worker callback changed a reclaimed job.");
  }
  const validDefer = await pool.query(
    "select executive_visuals.defer_job_v1($1::uuid,$2,$3::uuid,5,'{"code":"CI_VALID_DEFER"}'::jsonb) as accepted",
    [fencedJobId, "ci-neon-fencing-worker", second.lease_token]
  );
  if (validDefer.rows[0]?.accepted !== true) throw new Error("Current lease could not defer its own job.");

  // A job at its retry ceiling must become terminal after lease expiry.
  const exhaustedId = await enqueue(key("retry-ceiling"), 1);
  const exhaustedClaim = await claimWithIndependentConnection("ci-neon-retry-worker");
  if (!exhaustedClaim || exhaustedClaim.id !== exhaustedId) throw new Error("Could not claim retry-ceiling job.");
  await pool.query(
    "update executive_visuals.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1::uuid",
    [exhaustedId]
  );
  await pool.query("select executive_visuals.recover_expired_jobs(10)");
  const terminal = await pool.query("select status,attempt_count from executive_visuals.jobs where id=$1::uuid", [exhaustedId]);
  if (terminal.rows[0]?.status !== "failed" || Number(terminal.rows[0]?.attempt_count) !== 1) {
    throw new Error("Retry ceiling did not terminate the expired job.");
  }

  process.stdout.write("NEON_WORKER_CONCURRENCY_POSTGRES_OK\n");
} finally {
  await pool.end();
}
