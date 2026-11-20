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
    if (storage && typeof storage.bucket === "string" && storage.bucket !== "executive-visuals-media") {
      throw new Error("Neon staging runtime requires the canonical executive-visuals-media bucket until asset metadata and cleanup contracts support configurable buckets.");
    }
    const queue = createNeonPostgresQueue({ pool });
    const submissions = createNeonVideoSubmissionLedger({ pool });
    const financials = createNeonVideoFinancials({ pool });
    const videoEnqueue = createNeonVideoEnqueue({ pool });
    const videoApprovals = typeof quoteCustomerCredits === "function"
      ? createNeonVideoGenerationRepositories({ pool, videoEnqueue, quoteCustomerCredits })
      : null;
    const workerRequested = workerAdapters !== null || workerAuthorizeJob !== null || workerId !== null;
    if (workerRequested && (!Array.isArray(workerAdapters) || workerAdapters.length < 1 ||
        typeof workerAuthorizeJob !== "function" || typeof workerId !== "string" || !workerId.trim() ||
        typeof quoteCustomerCredits !== "function")) {
      throw new Error("Neon video worker composition requires adapters, authorization, worker identity and the server-side customer-credit quote policy together.");
    }
    if (workerRequested && (!includeStorage || typeof storage?.checkReadiness !== "function")) {
      throw new Error("Neon video worker composition requires explicitly configured private object storage with a readiness probe.");
    }
    const workerRuntime = { backend: "neon-postgres", branch: "executive-visuals-staging",
      queue, submissions, financials, customerCredits: financials };
    const videoWorker = workerRequested
      ? createNeonCloudVideoWorker({ runtime: workerRuntime, workerId, adapters: workerAdapters,
          authorizeJob: workerAuthorizeJob, quoteCustomerCredits, env })
      : null;
    const workerProcess = videoWorker
      ? createCloudVideoWorkerProcess({ ...workerProcessOptions, worker: videoWorker })
      : null;
    let closed = false;
    async function checkReadiness() {
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
        applicationDispatchReady: queueStatus.ready === true && financialStatus.ready === true && enqueueStatus.ready === true &&
          approvalStatus?.ready === true && Boolean(storage?.checkReadiness) && storageStatus?.ready === true,
        workerReady: queueStatus.ready === true && financialStatus.ready === true && enqueueStatus.ready === true &&
          Boolean(videoWorker && workerProcess && storage?.checkReadiness) && storageStatus?.ready === true,
        queue: queueStatus,
        financials: financialStatus,
        videoEnqueue: enqueueStatus,
        videoApprovals: approvalStatus || { configured: false, ready: false },
        storage: storageStatus,
        videoWorker: Object.freeze({
          configured: Boolean(videoWorker),
          supportedAdapters: videoWorker?.listSupported() || [],
          ...(workerProcess?.status() || { running: false, cycles: 0, claimed: 0, finished: 0, recovered: 0, failures: 0, stopRequested: false, lastCycleAt: null, lastRecoveryAt: null, lastErrorCode: null })
        })
      });
    }

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
      videoWorker,
      checkReadiness,
      async startVideoWorker() {
        if (closed) throw new Error("Neon staging runtime is closed.");
        if (!videoWorker || !workerProcess) throw new Error("Neon video worker is not configured.");
        const readiness = await checkReadiness();
        if (readiness.workerReady !== true || readiness.storage?.ready !== true) {
          throw new Error("Neon video worker cannot start until worker, financial and private-storage readiness all pass.");
        }
        return workerProcess.start();
      },
      async stopVideoWorker() {
        if (!workerProcess) return Object.freeze({ stopped: true, configured: false });
        return workerProcess.stop();
      },
      async close() {
        if (closed) return;
        closed = true;
        if (workerProcess) await workerProcess.stop();
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
