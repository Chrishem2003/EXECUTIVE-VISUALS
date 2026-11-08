import { createFalCloudVideoAdapter } from "./fal-cloud-video-adapter.mjs";
import { createFalBillingCostResolver } from "./fal-billing-cost-resolver.mjs";

/**
 * Bind the FAL async queue adapter and exact per-request billing resolver to
 * the shared private-output ingestion boundary supplied by the worker
 * composition. This registers one exact model only; no model discovery,
 * fallback routing, provider calls or paid work happens during construction.
 *
 * Reference media remains disabled unless the host supplies an authenticated,
 * owner/project-scoped prepareInput resolver.
 */
export function createFalVideoProviderAdapter({
  env = process.env,
  fetchImpl = globalThis.fetch,
  ingestOutputs,
  prepareInput,
  queueClient,
  billingApiKey = env.FAL_BILLING_KEY || env.FAL_KEY
} = {}) {
  const model = String(env.FAL_VIDEO_MODEL || "").trim();
  if (!model) throw new Error("FAL_VIDEO_MODEL must identify one exact FAL endpoint.");
  if (typeof ingestOutputs !== "function") {
    throw new Error("FAL provider registration requires the shared private output ingestor.");
  }
  const resolveActualCost = createFalBillingCostResolver({
    apiKey: billingApiKey,
    fetchImpl
  });
  return createFalCloudVideoAdapter({
    model,
    client: queueClient,
    apiKey: env.FAL_KEY,
    enabled: env.VIDEO_GATEWAY_ENABLED === "true",
    allowRemote: env.VIDEO_GATEWAY_ALLOW_REMOTE === "true",
    fetchImpl,
    prepareInput,
    ingestOutputs,
    resolveActualCost
  });
}
