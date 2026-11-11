import { createCloudQueue } from "./cloud-queue.mjs";
import { createCloudVideoEnqueue } from "./cloud-video-enqueue.mjs";
import { createCloudVideoSubmissionLedger } from "./cloud-video-submissions.mjs";
import { createCloudCustomerCreditLedger } from "./cloud-customer-credit-ledger.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";
import {
  createFfprobeVideoOutputValidator,
  createPrivateVideoOutputIngestor
} from "./private-video-output-ingestion.mjs";
import { createProviderAwareCloudVideoWorker } from "./cloud-video-provider-worker.mjs";
import { createFalVideoProviderAdapter } from "./fal-video-provider-registration.mjs";
import { createRunwayCloudVideoAdapter } from "./runway-cloud-video-adapter.mjs";
import { createRunwayModelRouterVideoAdapter } from "./runway-model-router-video-adapter.mjs";
import { createRunwaySourceAssetResolver } from "./runway-source-asset-resolver.mjs";
import { createGoogleOmniCloudVideoComposition } from "./google-omni-cloud-video-composition.mjs";
import { createGeminiOmniFlashClient } from "./google-omni-flash-client.mjs";
import { createGoogleVideoInteractionRepository } from "./google-video-interaction-repository.mjs";
import { createGoogleInteractionRetentionPolicy } from "./google-interaction-retention-policy.mjs";

/**
 * Build the provider-aware worker against the existing Supabase queue,
 * submission ledger and private asset repository. Provider construction is
 * injected so each provider can bind its own task-level billing resolver while
 * sharing the same hardened private-output ingestion boundary.
 *
 * This factory is opt-in and side-effect free: constructors do not contact
 * Supabase or a provider. Network activity begins only when runCycle runs.
 */
export function createProviderAwareCloudVideoWorkerComposition({
  workerId,
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createAdapters,
  providerDependencies = {},
  prepareRunwayInput,
  resolveRunwaySourceMetadata,
  resolveRunwayActualCost,
  runwayModels = String(env.RUNWAY_VIDEO_MODELS || "").split(",").map(value => value.trim()).filter(Boolean),
  allowedOutputHosts = [],
  validateMedia,
  ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
  timeoutMs = 15000,
  maxBytesPerOutput = 250 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
  deferSeconds = 30
} = {}) {
  if (env.CLOUD_VIDEO_WORKER_ENABLED !== "true") {
    throw new Error("Provider-aware cloud video worker is disabled; explicit CLOUD_VIDEO_WORKER_ENABLED=true is required.");
  }
  if (env.VIDEO_GATEWAY_ENABLED !== "true" || env.VIDEO_GATEWAY_ALLOW_REMOTE !== "true") {
    throw new Error("Provider-aware remote execution requires VIDEO_GATEWAY_ENABLED=true and VIDEO_GATEWAY_ALLOW_REMOTE=true.");
  }
  if (typeof workerId !== "string" || !workerId.trim() || workerId.length > 128) {
    throw new Error("Provider-aware cloud video worker requires a valid worker ID.");
  }
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Provider-aware cloud video worker requires server-side Supabase credentials and fetch.");
  }
  if (!Array.isArray(allowedOutputHosts) || allowedOutputHosts.length < 1 || allowedOutputHosts.length > 100 ||
      allowedOutputHosts.some(host => typeof host !== "string" || !/^(?:\*\.)?[a-z0-9.-]{1,253}$/i.test(host))) {
    throw new Error("Provider-aware output ingestion requires an explicit bounded hostname allowlist.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Provider-aware cloud video worker timeout is invalid.");
  }
  if (!Array.isArray(runwayModels) || runwayModels.length > 10 ||
      runwayModels.some(model => typeof model !== "string" || !["gen4.5", "aleph2", "magnific_video_upscaler_creative", "ruby"].includes(model)) ||
      new Set(runwayModels).size !== runwayModels.length) {
    throw new Error("Runway model registration must be a unique list of explicitly supported model profiles.");
  }

  const clientOptions = { url, serviceRoleKey, fetchImpl, timeoutMs };
  const queue = createCloudQueue(clientOptions);
  const ledger = createCloudVideoSubmissionLedger(clientOptions);
  const customerCredits = createCloudCustomerCreditLedger(clientOptions);
  const privateAssets = createCloudAssetService({
    ...clientOptions,
    storageTimeoutMs: Math.min(timeoutMs, 30000),
    metadataTimeoutMs: timeoutMs,
    authorizationTimeoutMs: Math.min(timeoutMs, 8000),
    maxBytes: maxBytesPerOutput
  });
  const mediaValidator = validateMedia || createFfprobeVideoOutputValidator({
    ffprobePath,
    timeoutMs: Math.min(timeoutMs, 15000)
  });
  const outputIngestor = createPrivateVideoOutputIngestor({
    assets: privateAssets.assets,
    allowedHosts: allowedOutputHosts,
    validateMedia: mediaValidator,
    timeoutMs: Math.min(timeoutMs, 30000),
    maxBytesPerOutput,
    maxTotalBytes
  });
  const ingestOutputs = args => outputIngestor.ingest(args);
  const sourceResolver = createRunwaySourceAssetResolver({
    assets: privateAssets.assets, fetchImpl, supabaseUrl: url, ffprobePath
  });
  const prepareInput = prepareRunwayInput || sourceResolver.prepare;
  const resolveSourceMetadata = resolveRunwaySourceMetadata || sourceResolver.resolveMetadata;
  const enqueue = createCloudVideoEnqueue({
    ...clientOptions, env, resolveRunwaySourceMetadata: resolveSourceMetadata
  });
  const googleEnabled = env.GOOGLE_OMNI_VIDEO_ENABLED === "true" || env.GOOGLE_OMNI_VIDEO_ALLOW_REMOTE === "true";
  let googleOmniIntegration = providerDependencies.googleOmniIntegration;
  if (googleOmniIntegration && !googleEnabled) throw new Error("Google Omni integration cannot be injected while its explicit provider gates are disabled.");
  if (googleEnabled && (
      env.GOOGLE_OMNI_VIDEO_ENABLED !== "true" ||
      env.GOOGLE_OMNI_VIDEO_ALLOW_REMOTE !== "true" ||
      env.GEMINI_OMNI_ENABLED !== "true" ||
      env.GEMINI_OMNI_ALLOW_REMOTE !== "true"
  )) {
    throw new Error("Google Omni requires both provider registration gates and both Gemini transport gates to be explicitly enabled.");
  }
  if (googleEnabled && !googleOmniIntegration) {
    const {
      googleOmniAssertApprovedSubmission,
      googleOmniAuthorizeInteraction,
      googleOmniPreparePlan,
      googleOmniClient,
      googleOmniInteractions,
      googleOmniRetentionExpiresAt
    } = providerDependencies;
    if (typeof googleOmniAssertApprovedSubmission !== "function" ||
        typeof googleOmniAuthorizeInteraction !== "function" ||
        typeof googleOmniPreparePlan !== "function") {
      throw new Error("Google Omni worker bootstrap requires durable approval, owner/project authorization and private-input planning callbacks.");
    }
    const interactions = googleOmniInteractions || createGoogleVideoInteractionRepository({
      ...clientOptions, timeoutMs: Math.min(timeoutMs, 30000)
    });
    const client = googleOmniClient || createGeminiOmniFlashClient({
      env, fetchImpl,
      assertApprovedSubmission: googleOmniAssertApprovedSubmission,
      authorizeInteraction: googleOmniAuthorizeInteraction,
      timeoutMs: Math.min(timeoutMs, 30000)
    });
    const retention = createGoogleInteractionRetentionPolicy({ env });
    googleOmniIntegration = createGoogleOmniCloudVideoComposition({
      assets: privateAssets.assets, client, interactions,
      preparePlan: googleOmniPreparePlan,
      retentionExpiresAt: googleOmniRetentionExpiresAt || retention.expiresAt,
      authorizeOutputIngestion: providerDependencies.googleOmniAuthorizeOutputIngestion,
      env, fetchImpl, timeoutMs: Math.min(timeoutMs, 120000),
      maxOutputBytes: maxBytesPerOutput
    });
  }
  const adapterFactory = createAdapters || (({ env: providerEnv, fetchImpl: providerFetch, ingestOutputs: ingest }) => {
    const adapters = [];
    const falConfigured = Boolean(providerEnv.FAL_VIDEO_MODEL && providerEnv.FAL_KEY && providerEnv.FAL_BILLING_KEY);
    if (falConfigured) {
      adapters.push(createFalVideoProviderAdapter({ env: providerEnv, fetchImpl: providerFetch, ingestOutputs: ingest }));
    }
    if (runwayModels.length) {
      if (typeof resolveRunwayActualCost !== "function") {
        throw new Error("Runway cloud registration requires an authoritative task-level billing resolver.");
      }
      if (runwayModels.some(model => ["aleph2", "magnific_video_upscaler_creative", "ruby"].includes(model)) &&
          typeof prepareInput !== "function") {
        throw new Error("Runway source operations require an owner-scoped source-media resolver.");
      }
      if (runwayModels.some(model => ["aleph2", "magnific_video_upscaler_creative"].includes(model)) &&
          typeof resolveSourceMetadata !== "function") {
        throw new Error("Runway source operations require a server-side media metadata resolver for safe budget reservation.");
      }
      for (const model of runwayModels) {
        adapters.push(createRunwayCloudVideoAdapter({
          model,
          apiKey: providerEnv.RUNWAY_API_KEY || providerEnv.RUNWAYML_API_SECRET,
          enabled: providerEnv.VIDEO_GATEWAY_ENABLED === "true",
          allowRemote: providerEnv.RUNWAY_VIDEO_ALLOW_REMOTE === "true",
          fetchImpl: providerFetch,
          prepareInput,
          ingestOutputs: ingest,
          resolveActualCost: resolveRunwayActualCost,
          timeoutMs: Math.min(timeoutMs, 30000)
        }));
      }
    }
    if (providerEnv.RUNWAY_MODEL_ROUTER_ENABLED === "true") {
      const configId = String(providerEnv.RUNWAY_VIDEO_ROUTER_CONFIG || "");
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(configId)) {
        throw new Error("Runway Model Router requires RUNWAY_VIDEO_ROUTER_CONFIG to name an existing saved config slug.");
      }
      adapters.push(createRunwayModelRouterVideoAdapter({
        configId,
        apiKey: providerEnv.RUNWAY_API_KEY || providerEnv.RUNWAYML_API_SECRET,
        enabled: providerEnv.RUNWAY_MODEL_ROUTER_ENABLED === "true",
        allowRemote: providerEnv.RUNWAY_VIDEO_ALLOW_REMOTE === "true",
        fetchImpl: providerFetch,
        prepareInput,
        ingestOutputs: ingest,
        timeoutMs: Math.min(timeoutMs, 30000)
      }));
    }
    return adapters;
  });
  const adapters = [...adapterFactory({
    env,
    fetchImpl,
    assets: privateAssets.assets,
    ingestOutputs,
    ...providerDependencies,
    googleOmniIntegration
  })];
  if (googleOmniIntegration) {
    adapters.push(Object.freeze({
      ...googleOmniIntegration.adapter,
      async ingestOutputs(args) { return googleOmniIntegration.ingestOutputs(args); },
      async resolveActualCost(args) { return googleOmniIntegration.resolveActualCost(args); }
    }));
  }
  if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 100) {
    throw new Error("Provider adapter factory must return between 1 and 100 adapters.");
  }

  return createProviderAwareCloudVideoWorker({
    workerId,
    queue,
    enqueue,
    ledger,
    customerCredits,
    adapters,
    deferSeconds
  });
}
