import { createVideoProviderExecutionRouter } from "./video-provider-execution-router.mjs";
import { createCloudVideoWorker } from "./cloud-video-worker.mjs";

/**
 * Compose one durable worker over a fixed, exact-match set of provider/model
 * adapters. Every adapter must own its private ingestion and actual-cost
 * resolver so a model can never inherit another provider's accounting gates.
 *
 * This factory is side-effect free: construction performs no provider or
 * database requests. The supplied queue/ledger are used only when runCycle is
 * called by the host worker process.
 */
export function createProviderAwareCloudVideoWorker({
  workerId,
  queue,
  enqueue,
  ledger,
  adapters,
  customerCredits,
  deferSeconds = 30
} = {}) {
  if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 100) {
    throw new Error("Provider-aware worker requires between 1 and 100 adapters.");
  }
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.ingestOutputs !== "function" ||
        typeof adapter.resolveActualCost !== "function") {
      throw new Error("Every provider adapter must supply private output ingestion and authoritative cost reconciliation.");
    }
  }

  const router = createVideoProviderExecutionRouter({ adapters });
  const worker = createCloudVideoWorker({
    workerId,
    queue,
    enqueue,
    ledger,
    customerCredits,
    resolveAdapter: router.resolveAdapter,
    deferSeconds
  });

  return Object.freeze({
    runCycle: worker.runCycle,
    recoverExpired: worker.recoverExpired,
    listSupported: router.listSupported
  });
}
