import { createNeonPostgresPool } from "./neon-postgres-pool.mjs";
import { createNeonPostgresQueue } from "./neon-postgres-queue.mjs";
import { createNeonVideoSubmissionLedger } from "./neon-postgres-video-submissions.mjs";
import { createNeonVideoFinancials } from "./neon-postgres-video-financials.mjs";
import { createNeonVideoEnqueue } from "./neon-postgres-video-enqueue.mjs";
import { createNeonVideoGenerationRepositories } from "./neon-postgres-video-approvals.mjs";
import { createNeonObjectStorage } from "./neon-object-storage.mjs";
import { createNeonCloudVideoWorker } from "./neon-cloud-video-worker.mjs";
import { createCloudVideoWorkerProcess } from "./cloud-video-worker-process.mjs";

/**
 * Compose the isolated Neon adapters without changing the active Supabase
 * runtime. Construction is opt-in and performs no database or storage I/O.
 * Call checkReadiness explicitly when an operator is ready to probe staging.
 */
export async function createNeonStagingRuntime({
  env = process.env,
  Pool,
  pool: suppliedPool,
  storage: suppliedStorage = null,
  storageOptions = {},
  includeStorage = false,
  quoteCustomerCredits = null,
  workerAdapters = null,
  workerAuthorizeJob = null,
  workerId = null,
  workerProcessOptions = {}
} = {}) {
  if (env.NEON_STAGING_RUNTIME_ENABLED !== "true") {
    throw new Error("Neon staging runtime is disabled; set NEON_STAGING_RUNTIME_ENABLED=true only for the isolated staging worker.");
  }
  if (env.NEON_STAGING_BRANCH_NAME !== "executive-visuals-staging") {
    throw new Error("Neon runtime requires the explicitly named executive-visuals-staging branch.");
  }
  if (env.SUPABASE_URL && env.NEON_DATABASE_URL && env.NEON_DATABASE_URL === env.SUPABASE_URL) {
    throw new Error("Neon staging database URL must not reuse the Supabase API URL.");
  }

  const pool = suppliedPool || await createNeonPostgresPool({
    connectionString: env.NEON_DATABASE_URL,
    Pool,
    max: Number(env.NEON_POSTGRES_POOL_MAX || 3),
    applicationName: "executive-visuals-neon-staging"
  });
  let storage = suppliedStorage;
  try {
    if (includeStorage && !storage) storage = createNeonObjectStorage(storageOptions);
    const queue = createNeonPostgresQueue({ pool });
    const submissions = createNeonVideoSubmissionLedger({ pool });
    const financials = createNeonVideoFinancials({ pool });
    const videoEnqueue = createNeonVideoEnqueue({ pool });
    const videoApprovals = typeof quoteCustomerCredits === "function"
      ? createNeonVideoGenerationRepositories({ pool, videoEnqueue, quoteCustomerCredits })
      : null;
    const workerRequested = workerAdapters !== null || workerAuthorizeJob !== null || workerId !== null;
    if (workerRequested && (!Array.isArray(workerAdapters) || workerAdapters.length < 1 ||
        typeof workerAuthorizeJob !== "function" || typeof workerId !== "string" || !workerId.trim())) {
      throw new Error("Neon video worker composition requires adapters, an authorization callback and a worker ID together.");
    }
    if (workerRequested && (!includeStorage || typeof storage?.checkReadiness !== "function")) {
      throw new Error("Neon video worker composition requires explicitly configured private object storage with a readiness probe.");
    }
    const workerRuntime = { backend: "neon-postgres", branch: "executive-visuals-staging",
      queue, submissions, financials, customerCredits: financials };
    const videoWorker = workerRequested
      ? createNeonCloudVideoWorker({ runtime: workerRuntime, workerId, adapters: workerAdapters,
          authorizeJob: workerAuthorizeJob, env })
      : null;
    const workerProcess = videoWorker
      ? createCloudVideoWorkerProcess({ worker: videoWorker, ...workerProcessOptions })
      : null;
    let closed = false;

    return Object.freeze({
      backend: "neon-postgres",
      branch: "executive-visuals-staging",
      queue,
      submissions,
      financials,
      videoEnqueue,
      videoApprovals,
      customerCredits: financials,
      storage,
      async checkReadiness() {
        if (closed) throw new Error("Neon staging runtime is closed.");
        const [queueStatus, financialStatus, enqueueStatus, approvalStatus, storageStatus] = await Promise.all([
          queue.checkReadiness(),
          financials.checkReadiness(),
          videoEnqueue.checkReadiness(),
          videoApprovals ? videoApprovals.approvals.checkReadiness() : Promise.resolve(null),
          storage?.checkReadiness ? storage.checkReadiness() : Promise.resolve(null)
        ]);
        return Object.freeze({
          backend: "neon-postgres",
          branch: "executive-visuals-staging",
          ready: queueStatus.ready === true && financialStatus.ready === true && enqueueStatus.ready === true &&
            (!storage || storageStatus?.ready === true),
          applicationDispatchReady: queueStatus.ready === true && financialStatus.ready === true && enqueueStatus.ready === true && approvalStatus?.ready === true &&
            (!storage || storageStatus?.ready === true),
          queue: queueStatus,
          financials: financialStatus,
          videoEnqueue: enqueueStatus,
          videoApprovals: approvalStatus || { configured: false, ready: false },
          storage: storageStatus
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        if (typeof pool.end === "function") await pool.end();
      }
    });
  } catch (error) {
    if (!suppliedPool && typeof pool.end === "function") {
      try { await pool.end(); } catch {}
    }
    throw error;
  }
}
