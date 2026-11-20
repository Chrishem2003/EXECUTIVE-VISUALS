import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNeonStagingRuntime } from "./neon-staging-runtime.mjs";
import { createNeonStagingProviderAdapters } from "./neon-staging-provider-adapters.mjs";

function boundedInteger(value, fallback, min, max, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(label + " must be an integer between " + min + " and " + max + ".");
  }
  return parsed;
}

/**
 * Dedicated Render background-worker entrypoint for isolated Neon staging.
 * It never creates resources or applies migrations. The selected Neon branch,
 * private bucket, credentials, provider and remote-execution gates must
 * already exist and pass readiness before the worker loop starts.
 */
export async function startNeonStagingWorkerProcess({
  env = process.env,
  fetchImpl = globalThis.fetch,
  Pool,
  processRef = process,
  workerId = "neon-staging-" + randomUUID(),
  createProviderAdapters = createNeonStagingProviderAdapters,
  createRuntime = createNeonStagingRuntime
} = {}) {
  if (env.NEON_STAGING_WORKER_PROCESS_ENABLED !== "true") {
    throw new Error("Neon staging background worker is disabled; set NEON_STAGING_WORKER_PROCESS_ENABLED=true only on the isolated staging worker service.");
  }
  if (env.NEON_STAGING_RUNTIME_ENABLED !== "true" ||
      env.NEON_STAGING_BRANCH_NAME !== "executive-visuals-staging") {
    throw new Error("Neon staging worker requires the explicitly enabled executive-visuals-staging runtime.");
  }

  const provider = createProviderAdapters({ env, fetchImpl });
  if (!provider || !Array.isArray(provider.adapters) || provider.adapters.length < 1 ||
      !provider.storage || typeof provider.authorizeJob !== "function") {
    throw new Error("Neon staging provider registry returned an incomplete adapter, storage or authorization contract.");
  }
  let runtime = null;
  let closed = false;
  let shutdownPromise = null;
  const listeners = [];
  try {
    runtime = await createRuntime({
      env, Pool, storage: provider.storage, includeStorage: true,
      workerAdapters: provider.adapters,
      workerAuthorizeJob: provider.authorizeJob,
      workerId,
      workerProcessOptions: {
        idlePollMs: boundedInteger(env.NEON_WORKER_IDLE_POLL_MS, 1500, 10, 60000, "NEON_WORKER_IDLE_POLL_MS"),
        activePollMs: boundedInteger(env.NEON_WORKER_ACTIVE_POLL_MS, 100, 10, 10000, "NEON_WORKER_ACTIVE_POLL_MS"),
        recoveryIntervalMs: boundedInteger(env.NEON_WORKER_RECOVERY_INTERVAL_MS, 60000, 1000, 86400000, "NEON_WORKER_RECOVERY_INTERVAL_MS"),
        recoveryLimit: boundedInteger(env.NEON_WORKER_RECOVERY_LIMIT, 100, 1, 1000, "NEON_WORKER_RECOVERY_LIMIT")
      }
    });
    const readiness = await runtime.checkReadiness();
    if (readiness?.workerReady !== true || readiness?.storage?.ready !== true) {
      throw new Error("Neon staging worker startup blocked: PostgreSQL, financial ledger, queue and private storage must all be ready.");
    }
    const started = await runtime.startVideoWorker();
    if (started?.started !== true && started?.reason !== "already_running") {
      throw new Error("Neon staging worker process did not confirm startup.");
    }

    const close = () => {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      shutdownPromise = (async () => {
        for (const [event, handler] of listeners) processRef?.removeListener?.(event, handler);
        await runtime.close();
      })();
      return shutdownPromise;
    };
    if (processRef?.once) {
      for (const event of ["SIGINT", "SIGTERM"]) {
        const handler = () => {
          close().catch(error => {
            processRef.stderr?.write?.("Neon staging worker shutdown failed: " + String(error?.message || error) + "\n");
            processRef.exitCode = 1;
          });
        };
        listeners.push([event, handler]);
        processRef.once(event, handler);
      }
    }
    processRef?.stdout?.write?.("Neon staging worker started: " + JSON.stringify({
      workerId, branch: readiness.branch, adapters: provider.adapters.map(adapter => adapter.provider + ":" + adapter.model)
    }) + "\n");
    return Object.freeze({ runtime, readiness, workerId, close, isClosed: () => closed });
  } catch (error) {
    if (runtime && typeof runtime.close === "function") {
      try { await runtime.close(); } catch {}
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startNeonStagingWorkerProcess().catch(error => {
    process.stderr.write("Neon staging worker failed to start: " + String(error?.message || error) + "\n");
    process.exitCode = 1;
  });
}
