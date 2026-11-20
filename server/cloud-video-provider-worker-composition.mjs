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
import { createRunwayTaskActualCostResolver } from "./runway-task-actual-cost-resolver.mjs";
import { createGoogleOmniCloudVideoComposition } from "./google-omni-cloud-video-composition.mjs";
import { createGeminiOmniFlashClient } from "./google-omni-flash-client.mjs";
import { createGoogleVideoInteractionRepository } from "./google-video-interaction-repository.mjs";
import { createGoogleInteractionRetentionPolicy } from "./google-interaction-retention-policy.mjs";
import { createLumaRay32Adapter } from "./luma-ray32-video-adapter.mjs";
import { createLumaActualCostResolver } from "./luma-actual-cost-resolver.mjs";
import { createLumaProviderFileRepository } from "./luma-provider-file-repository.mjs";
import { createLumaProviderFileService } from "./luma-provider-file-service.mjs";

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
  runwayModels = String(env.RUNWAY_VIDEO_MODELS || env.RUNWAY_VIDEO_MODEL || "").split(",").map(value => value.trim()).filter(Boolean),
  allowedOutputHosts = [],
  validateMedia,
  ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
  timeoutMs = 15000,
  maxBytesPerOutput = 250 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
  deferSeconds = 30,
  neon = {
    endpoint: env.NEON_STORAGE_ENDPOINT,
    region: env.NEON_STORAGE_REGION,
    accessKeyId: env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: env.NEON_STORAGE_BUCKET || "executive-visuals-media"
  }
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
  if (!Array.isArray(runwayModels) || runwayModels.length > 13 ||
      runwayModels.some(model => typeof model !== "string" || !["gen4.5", "seedance2_5", "kling_4", "kling_4_flash", "kling3.0_standard", "kling3.0_pro", "kling3.0_4k", "gemini_omni_flash_1.2", "aleph2", "magnific_video_upscaler_creative", "ruby", "veo3.1", "veo3.1_fast"].includes(model)) ||
      new Set(runwayModels).size !== runwayModels.length) {
    throw new Error("Runway model registration must be a unique list of explicitly supported model profiles.");
  }

  const clientOptions = { url, serviceRoleKey, fetchImpl, timeoutMs };
  const queue = createCloudQueue(clientOptions);
  const ledger = createCloudVideoSubmissionLedger(clientOptions);
  const customerCredits = createCloudCustomerCreditLedger(clientOptions);
  const privateAssets = createCloudAssetService({
    ...clientOptions,
    storageProvider: env.CLOUD_MEDIA_STORAGE_PROVIDER || "supabase",
    neon,
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
    assets: privateAssets.assets, fetchImpl, supabaseUrl: url, ffprobePath,
    storageProvider: env.CLOUD_MEDIA_STORAGE_PROVIDER || "supabase",
    neonEndpoint: neon.endpoint, neonBucket: neon.bucket
  });
  const prepareInput = prepareRunwayInput || sourceResolver.prepare;
  const resolveSourceMetadata = resolveRunwaySourceMetadata || sourceResolver.resolveMetadata;
  const resolveReferenceVideoMetadata = sourceResolver.resolveReferenceVideoMetadata;
  const enqueue = createCloudVideoEnqueue({
    ...clientOptions, env,
    resolveRunwaySourceMetadata: resolveSourceMetadata,
    resolveRunwayReferenceVideoMetadata: resolveReferenceVideoMetadata
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
  const googleOmniAssertConnection = providerDependencies.googleOmniAssertConnection;
  if (googleEnabled && env.GOOGLE_OMNI_CONNECTION_STATUS !== "connected") {
    throw new Error("Google Omni remains gated until its external account connection is complete and verified.");
  }
  if (googleEnabled && typeof googleOmniAssertConnection !== "function") {
    throw new Error("Google Omni requires a live connection verifier before any worker execution.");
  }
  async function assertGoogleOmniConnection(job, operation) {
    let connection;
    try {
      connection = await googleOmniAssertConnection({
        provider: "google", model: "gemini-omni-1.1-flash", job: job || null, operation
      });
    } catch {
      throw Object.assign(new Error("Google Omni connection verification failed; remote execution remains blocked."),
        { code: "GOOGLE_OMNI_CONNECTION_REQUIRED" });
    }
    if (!connection || connection.connected !== true || connection.verified !== true ||
        typeof connection.connectionId !== "string" || !connection.connectionId.trim() ||
        connection.connectionId.length > 200) {
      throw Object.assign(new Error("Google Omni account connection is not verified for worker execution."),
        { code: "GOOGLE_OMNI_CONNECTION_REQUIRED" });
    }
    return true;
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
      const veoOnly = runwayModels.every(model => model === "veo3.1" || model === "veo3.1_fast");
      const runwayActualCostResolver = resolveRunwayActualCost || (veoOnly && providerEnv.RUNWAY_WORKSPACE_USAGE_ENABLED === "true"
        ? createRunwayTaskActualCostResolver({
            apiKey: providerEnv.RUNWAY_API_KEY || providerEnv.RUNWAYML_API_SECRET,
            enabled: true, fetchImpl: providerFetch, timeoutMs: Math.min(timeoutMs, 30000)
          })
        : null);
      if (typeof runwayActualCostResolver !== "function") {
        throw new Error("Runway cloud registration requires an authoritative task-level billing resolver; Veo requires the linked Enterprise workspace usage gate.");
      }
      if (runwayModels.some(model => ["aleph2", "magnific_video_upscaler_creative", "ruby", "seedance2_5", "kling_4", "kling_4_flash", "kling3.0_standard", "kling3.0_pro", "kling3.0_4k"].includes(model)) &&
          typeof prepareInput !== "function") {
        throw new Error("Runway source operations require an owner-scoped source-media resolver.");
      }
      if (runwayModels.some(model => ["aleph2", "magnific_video_upscaler_creative", "seedance2_5", "kling_4", "kling_4_flash", "gemini_omni_flash_1.2"].includes(model)) &&
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
          resolveActualCost: runwayActualCostResolver,
          assertActualCostReady: runwayActualCostResolver.assertAvailable,
          timeoutMs: Math.min(timeoutMs, 30000)
        }));
      }
    }
    const lumaRequested = providerEnv.LUMA_VIDEO_ENABLED === "true" || providerEnv.LUMA_VIDEO_ALLOW_REMOTE === "true";
    if (lumaRequested) {
      if (providerEnv.LUMA_VIDEO_ENABLED !== "true" || providerEnv.LUMA_VIDEO_ALLOW_REMOTE !== "true") {
        throw Object.assign(new Error("Luma requires both LUMA_VIDEO_ENABLED=true and LUMA_VIDEO_ALLOW_REMOTE=true."), { code: "LUMA_VIDEO_REMOTE_DISABLED" });
      }
      const resolveLumaActualCost = providerDependencies.resolveLumaActualCost ||
        createLumaActualCostResolver({ usdPerCredit: providerEnv.LUMA_USD_PER_CREDIT });
      const lumaClient = providerDependencies.lumaClient || createLumaRay32Adapter({
        apiKey: providerEnv.LUMA_AGENTS_API_KEY,
        fetchImpl: providerFetch,
        timeoutMs: Math.min(timeoutMs, 30000)
      });
      if (!lumaClient || typeof lumaClient.prepareInput !== "function" || typeof lumaClient.submit !== "function" || typeof lumaClient.getStatus !== "function") {
        throw Object.assign(new Error("Luma registration requires a compatible Ray 3.2 client."), { code: "LUMA_VIDEO_CLIENT_INVALID" });
      }
      let lumaPrepareInput = providerDependencies.lumaPrepareInput;
      if (!lumaPrepareInput) {
        const lumaFileRepository = providerDependencies.lumaFileRepository || createLumaProviderFileRepository({
          ...clientOptions, timeoutMs: Math.min(timeoutMs, 30000)
        });
        const lumaFileService = providerDependencies.lumaFileService || createLumaProviderFileService({
          assets: privateAssets.assets, adapter: lumaClient, repository: lumaFileRepository,
          fetchImpl, timeoutMs: Math.min(timeoutMs, 30000), maxBytes: maxBytesPerOutput,
          supabaseUrl: url, storageProvider: env.CLOUD_MEDIA_STORAGE_PROVIDER || "supabase",
          r2AccountId: env.R2_ACCOUNT_ID, r2Bucket: env.R2_BUCKET || "executive-visuals-media",
          neonEndpoint: neon.endpoint, neonBucket: neon.bucket
        });
        lumaPrepareInput = lumaFileService.resolveInput;
      }
      const model = "ray-3.2";
      const assertLumaEnabled = () => {
        if (providerEnv.VIDEO_GATEWAY_ENABLED !== "true" || providerEnv.VIDEO_GATEWAY_ALLOW_REMOTE !== "true" ||
            providerEnv.LUMA_VIDEO_ENABLED !== "true" || providerEnv.LUMA_VIDEO_ALLOW_REMOTE !== "true") {
          throw Object.assign(new Error("Luma remote video execution is disabled."), { code: "LUMA_VIDEO_REMOTE_DISABLED" });
        }
      };
      adapters.push(Object.freeze({
        provider: "luma",
        model,
        minimumPollIntervalMs: lumaClient.minimumPollIntervalMs || 5000,
        async prepareInput(input, context) {
          if (!input || typeof input !== "object" || Array.isArray(input) || input.provider !== "luma" || input.model !== model) {
            throw Object.assign(new Error("Luma job provider/model identity does not match Ray 3.2."), { code: "VIDEO_JOB_INPUT_MISMATCH" });
          }
          const hasReferences = Boolean(input.startFrame || input.endFrame || input.startFrameAssetId ||
            input.endFrameAssetId || input.sourceVideoAssetId || input.sourceVideo || input.source || input.sourceGenerationId) ||
            (Array.isArray(input.keyframes) && input.keyframes.length > 0) ||
            (Array.isArray(input.keyframeAssetIds) && input.keyframeAssetIds.length > 0) ||
            (Array.isArray(input.referenceAssetIds) && input.referenceAssetIds.length > 0);
          if (hasReferences && typeof lumaPrepareInput !== "function") {
            throw Object.assign(new Error("Luma reference media requires an authenticated owner/project-scoped resolver."), { code: "LUMA_VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED" });
          }
          const resolved = typeof lumaPrepareInput === "function" ? await lumaPrepareInput(input, context) : input;
          if (!resolved || typeof resolved !== "object" || Array.isArray(resolved) || resolved.provider !== "luma" || resolved.model !== model) {
            throw Object.assign(new Error("Luma input resolver returned an invalid or mismatched request."), { code: "LUMA_VIDEO_INPUT_INVALID" });
          }
          const ownerId = context?.job?.owner_id;
          if (typeof ownerId !== "string" || !ownerId.trim() || ownerId.length > 256) {
            throw Object.assign(new Error("Luma user attribution requires the stable internal owner ID."), { code: "LUMA_VIDEO_OWNER_ID_REQUIRED" });
          }
          return Object.freeze({ provider: "luma", model, payload: await lumaClient.prepareInput({ ...resolved, user_id: ownerId }) });
        },
        async submit(prepared) {
          assertLumaEnabled();
          if (!prepared || prepared.provider !== "luma" || prepared.model !== model || !prepared.payload || typeof prepared.payload !== "object") {
            throw Object.assign(new Error("Luma prepared payload does not match Ray 3.2."), { code: "VIDEO_JOB_INPUT_MISMATCH" });
          }
          return lumaClient.submit(prepared.payload);
        },
        async getStatus(taskId, context) {
          assertLumaEnabled();
          return lumaClient.getStatus(taskId, context);
        },
        async ingestOutputs(args) {
          return ingest({ ...args, provider: "luma", model });
        },
        async resolveActualCost(args) {
          return resolveLumaActualCost({ ...args, provider: "luma", model });
        }
      }));
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
    const googleAdapter = googleOmniIntegration.adapter;
    adapters.push(Object.freeze({
      provider: googleAdapter.provider,
      model: googleAdapter.model,
      async prepareInput(input, context) {
        await assertGoogleOmniConnection(context?.job, "prepare");
        return googleAdapter.prepareInput(input, context);
      },
      async submit(input, context) {
        await assertGoogleOmniConnection(context?.job, "submit");
        return googleAdapter.submit(input, context);
      },
      async getStatus(taskId, context) {
        await assertGoogleOmniConnection(context?.job, "poll");
        return googleAdapter.getStatus(taskId, context);
      },
      async ingestOutputs(args) {
        await assertGoogleOmniConnection(args?.job, "ingest");
        return googleOmniIntegration.ingestOutputs(args);
      },
      async resolveActualCost(args) {
        await assertGoogleOmniConnection(args?.job, "reconcile_cost");
        return googleOmniIntegration.resolveActualCost(args);
      }
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
