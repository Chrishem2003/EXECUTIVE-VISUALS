import { createFalVideoProviderAdapter } from "./fal-video-provider-registration.mjs";
import { createRunwayCloudVideoAdapter } from "./runway-cloud-video-adapter.mjs";
import { createLumaRay32Adapter } from "./luma-ray32-video-adapter.mjs";

const fail = (message, code = "VIDEO_PROVIDER_CONFIGURATION_INVALID") =>
  Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function assertIdentity(input, provider, model) {
  if (!plain(input) || input.provider !== provider || input.model !== model) {
    throw fail("Video job provider/model identity does not match the configured adapter.", "VIDEO_JOB_INPUT_MISMATCH");
  }
}

/**
 * Create only explicitly configured provider adapters for the durable worker.
 *
 * FAL retains its existing global VIDEO_GATEWAY gates and exact FAL_VIDEO_MODEL.
 * Runway and Luma require both global and provider-specific opt-ins. Runway
 * and Luma actual-cost resolvers are injected because published price tables
 * are estimates, not task-level settlement evidence.
 *
 * No provider calls occur during construction. Private reference media must
 * be resolved by owner/project-scoped callbacks before it reaches a provider.
 */
export function createConfiguredVideoProviderAdapters({
  env = process.env,
  fetchImpl = globalThis.fetch,
  ingestOutputs,
  falQueueClient,
  falPrepareInput,
  runwayPrepareInput,
  resolveRunwayActualCost,
  lumaPrepareInput,
  resolveLumaActualCost,
  lumaClient
} = {}) {
  if (!plain(env)) throw fail("Provider configuration environment must be an object.");
  if (typeof fetchImpl !== "function") throw fail("Provider registration requires fetch.");
  if (typeof ingestOutputs !== "function") throw fail("Provider registration requires the private output ingestor.");

  const globalEnabled = env.VIDEO_GATEWAY_ENABLED === "true";
  const globalRemote = env.VIDEO_GATEWAY_ALLOW_REMOTE === "true";
  const adapters = [];

  if (globalEnabled && globalRemote && String(env.FAL_VIDEO_MODEL || "").trim()) {
    adapters.push(createFalVideoProviderAdapter({
      env, fetchImpl, ingestOutputs, prepareInput: falPrepareInput,
      queueClient: falQueueClient
    }));
  }

  if (env.RUNWAY_VIDEO_ENABLED === "true" || env.RUNWAY_VIDEO_ALLOW_REMOTE === "true") {
    if (!globalEnabled || !globalRemote ||
        env.RUNWAY_VIDEO_ENABLED !== "true" || env.RUNWAY_VIDEO_ALLOW_REMOTE !== "true") {
      throw fail("Runway requires VIDEO_GATEWAY_ENABLED, VIDEO_GATEWAY_ALLOW_REMOTE, RUNWAY_VIDEO_ENABLED and RUNWAY_VIDEO_ALLOW_REMOTE to be true.", "RUNWAY_REMOTE_DISABLED");
    }
    if (typeof resolveRunwayActualCost !== "function") {
      throw fail("Runway registration requires an authoritative task-level billing resolver; pricing estimates are not settlement evidence.", "RUNWAY_BILLING_RESOLVER_REQUIRED");
    }
    adapters.push(createRunwayCloudVideoAdapter({
      model: env.RUNWAY_VIDEO_MODEL || "gen4.5",
      apiKey: env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET,
      enabled: globalEnabled,
      allowRemote: true,
      fetchImpl,
      prepareInput: runwayPrepareInput,
      ingestOutputs,
      resolveActualCost: resolveRunwayActualCost
    }));
  }

  if (env.LUMA_VIDEO_ENABLED === "true" || env.LUMA_VIDEO_ALLOW_REMOTE === "true") {
    if (!globalEnabled || !globalRemote ||
        env.LUMA_VIDEO_ENABLED !== "true" || env.LUMA_VIDEO_ALLOW_REMOTE !== "true") {
      throw fail("Luma requires VIDEO_GATEWAY_ENABLED, VIDEO_GATEWAY_ALLOW_REMOTE, LUMA_VIDEO_ENABLED and LUMA_VIDEO_ALLOW_REMOTE to be true.", "LUMA_VIDEO_REMOTE_DISABLED");
    }
    if (typeof resolveLumaActualCost !== "function") {
      throw fail("Luma registration requires authoritative settled-usage reconciliation; published credit prices are estimates only.", "LUMA_BILLING_RESOLVER_REQUIRED");
    }
    const client = lumaClient || createLumaRay32Adapter({
      apiKey: env.LUMA_AGENTS_API_KEY,
      fetchImpl
    });
    if (!client || typeof client.prepareInput !== "function" ||
        typeof client.submit !== "function" || typeof client.getStatus !== "function") {
      throw fail("Luma registration requires a compatible Ray 3.2 client.");
    }
    const model = "ray-3.2";
    const assertEnabled = () => {
      if (!globalEnabled || !globalRemote ||
          env.LUMA_VIDEO_ENABLED !== "true" || env.LUMA_VIDEO_ALLOW_REMOTE !== "true") {
        throw fail("Luma remote video execution is disabled.", "LUMA_VIDEO_REMOTE_DISABLED");
      }
    };
    adapters.push(Object.freeze({
      provider: "luma",
      model,
      minimumPollIntervalMs: client.minimumPollIntervalMs || 5000,
      async prepareInput(input, context) {
        assertIdentity(input, "luma", model);
        const hasReferences = Boolean(input.startFrame || input.endFrame) ||
          (Array.isArray(input.keyframes) && input.keyframes.length > 0) ||
          (Array.isArray(input.referenceAssetIds) && input.referenceAssetIds.length > 0);
        if (hasReferences && typeof lumaPrepareInput !== "function") {
          throw fail("Luma reference media requires an authenticated owner/project-scoped resolver.", "LUMA_VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        }
        const resolved = typeof lumaPrepareInput === "function"
          ? await lumaPrepareInput(input, context)
          : input;
        if (!plain(resolved)) throw fail("Luma input resolver returned an invalid request.", "LUMA_VIDEO_INPUT_INVALID");
        assertIdentity(resolved, "luma", model);
        return Object.freeze({
          provider: "luma",
          model,
          payload: await client.prepareInput(resolved)
        });
      },
      async submit(prepared) {
        assertEnabled();
        if (!plain(prepared) || prepared.provider !== "luma" || prepared.model !== model || !plain(prepared.payload)) {
          throw fail("Luma prepared payload does not match the exact registered model.", "VIDEO_JOB_INPUT_MISMATCH");
        }
        return client.submit(prepared.payload);
      },
      async getStatus(providerTaskId) {
        assertEnabled();
        return client.getStatus(providerTaskId);
      },
      async ingestOutputs(args) {
        return ingestOutputs({ ...args, provider: "luma", model });
      },
      async resolveActualCost(args) {
        return resolveLumaActualCost({ ...args, provider: "luma", model });
      }
    }));
  }

  if (adapters.length === 0) {
    throw fail("No video provider is configured. Set an exact model and explicit provider/global enablement gates.");
  }
  return Object.freeze(adapters);
}
