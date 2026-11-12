import { estimateVideoGenerationCost } from "./video-generation-cost-estimator.mjs";
import { getVideoProviderModel } from "./video-provider-registry.mjs";
import { assertVideoCapabilities, normalizeVideoGenerationRequest } from "./video-generation-contract.mjs";
const SCHEMA = "executive_visuals";
const RPC = Object.freeze({
  enqueue: "enqueue_video_generation_job",
  finish: "finish_video_generation_job_v2",
  defer: "defer_video_generation_job_v2",
  quarantine: "quarantine_video_generation_job_v2",
  resume: "resume_reconciled_video_generation_job",
  recover: "recover_expired_video_generation_jobs"
});

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cloud video enqueue URL must be a valid absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloud video enqueue URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

async function readResponseTextBounded(response, maximumBytes = 1024 * 1024) {
  if (typeof response?.body?.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw new Error("Cloud video enqueue response exceeded the 1 MB limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Cloud video enqueue response exceeded the 1 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export function createCloudVideoEnqueue({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  env = process.env,
  resolveRunwaySourceMetadata
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud video enqueue requires server-side SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud video enqueue requires a fetch implementation.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cloud video enqueue timeout must be between 1000 and 120000 milliseconds.");
  const base = endpoint(url);

  async function call(name, args) {
    if (!Object.values(RPC).includes(name)) throw new Error("Unsupported cloud video enqueue operation.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: "Bearer " + serviceRoleKey,
          "content-type": "application/json",
          "accept-profile": SCHEMA,
          "content-profile": SCHEMA,
          accept: "application/json"
        },
        body: JSON.stringify(args),
        signal: controller.signal
      });
      const body = await readResponseTextBounded(response);
      let parsed = null;
      if (body) {
        try { parsed = JSON.parse(body); }
        catch { throw new Error("Cloud video enqueue returned a non-JSON response (HTTP " + response.status + ")."); }
      }
      if (!response.ok) {
        const message = typeof parsed?.message === "string" ? parsed.message.replaceAll(serviceRoleKey, "[redacted]").slice(0, 300) : "Cloud video enqueue request failed.";
        const error = new Error(message);
        error.code = "CLOUD_VIDEO_ENQUEUE_HTTP_" + response.status;
        error.status = response.status;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Cloud video enqueue request timed out.");
        timeout.code = "CLOUD_VIDEO_ENQUEUE_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  function required(value, name, max = 256) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(name + " is required and must be bounded.");
    return value;
  }

  return Object.freeze({
    async enqueue({
      ownerId, projectId = null, idempotencyKey, provider, model, requestHash,
      input, budgetApprovalId, reservedAmount, currency
    } = {}) {
      required(ownerId, "Owner ID");
      if (projectId !== null) required(projectId, "Project ID");
      required(idempotencyKey, "Idempotency key", 180);
      required(provider, "Provider", 100);
      required(model, "Model", 160);
      required(budgetApprovalId, "Budget approval ID");
      if (!/^[A-Za-z0-9._:-]{1,180}$/.test(idempotencyKey)) throw new Error("Idempotency key has an invalid format.");
      if (typeof requestHash !== "string" || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("Request hash must be a lowercase SHA-256 digest.");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Video generation input must be an object.");
      if (input.provider !== provider || input.model !== model || input.requestHash !== requestHash ||
          (input.projectId || null) !== projectId) throw new Error("Video generation input does not match its enqueue scope.");
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32000) throw new Error("Video generation input exceeds the 32000-byte limit.");
      if (typeof reservedAmount !== "number" || !Number.isFinite(reservedAmount) || reservedAmount <= 0 || reservedAmount > 100000000) {
        throw new Error("Reserved amount must be a positive bounded number.");
      }
      if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter uppercase code.");
      const runwayTextEnabled = provider === "runway" && model === "gen4.5" &&
        (input.operation === undefined || input.operation === "text-to-video") && !input.startFrameAssetId;
      const runwayImageEnabled = provider === "runway" && model === "gen4.5" &&
        (input.operation === "image-to-video" || Boolean(input.startFrameAssetId));
      const runwayEditEnabled = provider === "runway" && model === "aleph2" && input.operation === "video-to-video";
      const runwayUpscaleEnabled = provider === "runway" && model === "magnific_video_upscaler_creative" && input.operation === "video-upscale";
      const runwayHdrEnabled = provider === "runway" && model === "ruby" && input.operation === "video-to-hdr";
      const runwayRouterEnabled = provider === "runway" && model === "model-router" &&
        ["text-to-video", "image-to-video", "video-to-video"].includes(input.operation);
      const runwayRouterVideoEditEnabled = runwayRouterEnabled && input.operation === "video-to-video";
      const runwayEnabled = runwayTextEnabled || runwayImageEnabled || runwayEditEnabled || runwayUpscaleEnabled || runwayHdrEnabled || runwayRouterEnabled;
      const googleEnabled = provider === "google" && model === "gemini-omni-1.1-flash";
      if (runwayRouterEnabled && (
        env.RUNWAY_MODEL_ROUTER_ENABLED !== "true" ||
        env.CLOUD_VIDEO_WORKER_ENABLED !== "true" ||
        env.RUNWAY_VIDEO_ALLOW_REMOTE !== "true" ||
        env.VIDEO_GATEWAY_ENABLED !== "true" ||
        env.VIDEO_GATEWAY_ALLOW_REMOTE !== "true" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(String(env.RUNWAY_VIDEO_ROUTER_CONFIG || "")) ||
        currency !== "USD"
      )) {
        const disabled = new Error("Runway Model Router enqueue requires explicit worker, remote and saved-config gates plus a USD budget ceiling.");
        disabled.code = "RUNWAY_ROUTER_REMOTE_DISABLED";
        throw disabled;
      }
      if (!runwayEnabled && !googleEnabled) {
        const unsupported = new Error("The selected provider/model does not have an enabled, verified cloud execution adapter.");
        unsupported.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
        throw unsupported;
      }
      if (googleEnabled && (
        env.GEMINI_OMNI_ENABLED !== "true" ||
        env.GEMINI_OMNI_ALLOW_REMOTE !== "true" ||
        env.GEMINI_OMNI_PAID_TIER_CONFIRMED !== "true" ||
        env.GEMINI_OMNI_WORKER_ENABLED !== "true"
      )) {
        const disabled = new Error("Gemini Omni enqueue requires explicit remote, paid-tier and hosted-worker enablement.");
        disabled.code = "GEMINI_OMNI_REMOTE_DISABLED";
        throw disabled;
      }
      let verifiedSourceMetadata = null;
      if (runwayEditEnabled || runwayUpscaleEnabled || runwayHdrEnabled || runwayRouterVideoEditEnabled) {
        if (typeof resolveRunwaySourceMetadata !== "function") {
          const unavailable = new Error("Runway source operations require a server-side media probe and owner-scoped asset resolver.");
          unavailable.code = "VIDEO_SOURCE_METADATA_UNAVAILABLE";
          throw unavailable;
        }
        verifiedSourceMetadata = await resolveRunwaySourceMetadata({
          ownerId, projectId, assetId: input.sourceVideoAssetId
        });
        if (!verifiedSourceMetadata || verifiedSourceMetadata.ownerId !== ownerId ||
            (verifiedSourceMetadata.projectId || null) !== projectId || verifiedSourceMetadata.assetId !== input.sourceVideoAssetId ||
            !["video/mp4", "video/quicktime", "video/webm"].includes(verifiedSourceMetadata.mediaType) ||
            !Number.isFinite(verifiedSourceMetadata.durationSeconds) ||
            verifiedSourceMetadata.durationSeconds < 1 || verifiedSourceMetadata.durationSeconds > 30) {
          const invalid = new Error("The source asset must have verified video metadata and a duration from 1 to 30 seconds.");
          invalid.code = "VIDEO_SOURCE_METADATA_INVALID";
          throw invalid;
        }
        const billableDurationSeconds = Math.ceil(verifiedSourceMetadata.durationSeconds);
        if (input.durationSeconds !== billableDurationSeconds) {
          const invalid = new Error("The submitted duration must match the server-probed, rounded-up source duration.");
          invalid.code = "VIDEO_SOURCE_METADATA_MISMATCH";
          throw invalid;
        }
        if (runwayUpscaleEnabled && (!Number.isSafeInteger(verifiedSourceMetadata.frameCount) ||
            verifiedSourceMetadata.frameCount < 1 || verifiedSourceMetadata.frameCount > 1000000)) {
          const invalid = new Error("Video upscaling requires a server-probed frame count for accurate credit reservation.");
          invalid.code = "VIDEO_SOURCE_METADATA_INVALID";
          throw invalid;
        }
        if (runwayUpscaleEnabled && input.outputFrames !== verifiedSourceMetadata.frameCount) {
          const invalid = new Error("The submitted output frame count must match the server-probed source frame count.");
          invalid.code = "VIDEO_SOURCE_METADATA_MISMATCH";
          throw invalid;
        }
        if (runwayHdrEnabled && (
          verifiedSourceMetadata.sourceDynamicRange !== "sdr" ||
          !Number.isSafeInteger(verifiedSourceMetadata.sourceWidth) || verifiedSourceMetadata.sourceWidth < 16 || verifiedSourceMetadata.sourceWidth > 4096 ||
          !Number.isSafeInteger(verifiedSourceMetadata.sourceHeight) || verifiedSourceMetadata.sourceHeight < 16 || verifiedSourceMetadata.sourceHeight > 4096
        )) {
          const invalid = new Error("Ruby HDR requires server-probed SDR source metadata and verified dimensions.");
          invalid.code = "VIDEO_SOURCE_METADATA_INVALID";
          throw invalid;
        }
      }
      const pricingInput = verifiedSourceMetadata ? {
        ...input,
        durationSeconds: Math.ceil(verifiedSourceMetadata.durationSeconds),
        inputVideoSeconds: Math.ceil(verifiedSourceMetadata.durationSeconds),
        outputFrames: verifiedSourceMetadata.frameCount,
        sourceWidth: verifiedSourceMetadata.sourceWidth,
        sourceHeight: verifiedSourceMetadata.sourceHeight,
        sourceDynamicRange: verifiedSourceMetadata.sourceDynamicRange
      } : input;
      const estimate = runwayRouterEnabled
        ? { amount: reservedAmount, currency: "USD", source: "approved_budget_ceiling_pending_runway_router_preflight" }
        : estimateVideoGenerationCost({
        provider, model, operation: input.operation || (input.startFrameAssetId ? "image-to-video" : "text-to-video"),
        durationSeconds: pricingInput.durationSeconds,
        outputFormat: input.outputFormat, resolution: input.resolution ?? (runwayUpscaleEnabled ? "2k" : input.resolution), audio: input.audio,
        inputVideoSeconds: pricingInput.inputVideoSeconds, referenceVideoSeconds: input.referenceVideoSeconds,
        referenceImageCount: input.referenceImageCount, referenceAudioCount: input.referenceAudioCount,
        hasStartFrame: Boolean(input.startFrameAssetId) || input.hasStartFrame === true, outputFrames: pricingInput.outputFrames,
        sourceWidth: pricingInput.sourceWidth ?? input.sourceWidth, sourceHeight: pricingInput.sourceHeight ?? input.sourceHeight,
        sourceDynamicRange: model === "ruby" ? (pricingInput.sourceDynamicRange ?? input.sourceDynamicRange) : undefined, outputWidth: input.outputWidth,
        outputHeight: input.outputHeight, targetFramerate: input.targetFramerate,
        inputType: input.sourceVideoAssetId ? "video" : input.startFrameAssetId ? "image" : input.inputType
      });

      const requestedOutputFormat = input.outputFormat ?? (runwayHdrEnabled ? "hdr10" : "mp4");
      if (runwayHdrEnabled ? !["hdr10", "hlg"].includes(requestedOutputFormat) : requestedOutputFormat !== "mp4") {
        const unsupported = new Error("The selected hosted video adapter supports MP4 outputs; Ruby HDR is limited to hdr10 and hlg profiles.");
        unsupported.code = "VIDEO_PRICE_OUTPUT_FORMAT_UNSUPPORTED";
        throw unsupported;
      }
      if (runwayRouterEnabled) {
        if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 26000 ||
            input.durationSeconds !== undefined && (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 2 || input.durationSeconds > 30) ||
            input.resolution !== undefined && !["480p", "720p", "1080p", "4k"].includes(input.resolution) ||
            input.aspectRatio !== undefined && !["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(input.aspectRatio) ||
            input.negativePrompt !== undefined && (typeof input.negativePrompt !== "string" || input.negativePrompt.length > 1000)) {
          const invalid = new Error("Runway Model Router video input exceeds its documented prompt, duration, ratio, resolution or negative-prompt limits.");
          invalid.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw invalid;
        }
      } else if (runwayTextEnabled || runwayImageEnabled) {
        // Gen-4.5's hosted worker currently supports provider-default resolution only.
        if (input.resolution !== undefined && input.resolution !== "provider_default") {
          const unsupported = new Error("The current Gen-4.5 worker only supports provider-default resolution.");
          unsupported.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw unsupported;
        }
        if (runwayImageEnabled && !input.startFrameAssetId) {
          const invalid = new Error("Gen-4.5 image-to-video requires an owner-scoped first-frame asset.");
          invalid.code = "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED";
          throw invalid;
        }
        const unpricedExecutionFields = ["audio","inputVideoSeconds","referenceVideoSeconds","referenceImageCount",
          "referenceAudioCount","hasStartFrame","outputFrames","sourceWidth","sourceHeight","sourceDynamicRange",
          "outputWidth","outputHeight","targetFramerate","inputType"];
        if (unpricedExecutionFields.some(field => input[field] !== undefined)) {
          const unsupported = new Error("The current Gen-4.5 worker does not yet accept these finishing or reference-media options.");
          unsupported.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw unsupported;
        }
      } else if (runwayEditEnabled) {
        if (!input.sourceVideoAssetId || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 1000) {
          const invalid = new Error("Aleph2 video editing requires an authorized source video asset and a prompt of 1 to 1,000 characters.");
          invalid.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw invalid;
        }
        if (!Number.isFinite(verifiedSourceMetadata?.durationSeconds) || verifiedSourceMetadata.durationSeconds < 1 || verifiedSourceMetadata.durationSeconds > 30) {
          const invalid = new Error("Aleph2 source video duration must be server-verified and between 1 and 30 seconds.");
          invalid.code = "VIDEO_PRICE_DURATION_INVALID";
          throw invalid;
        }
        if (input.keyframeAssetIds !== undefined &&
            (!Array.isArray(input.keyframeAssetIds) || input.keyframeAssetIds.length > 5)) {
          throw new Error("Aleph2 accepts at most five keyframe guidance assets.");
        }
      } else if (runwayUpscaleEnabled) {
        if (!input.sourceVideoAssetId || !Number.isFinite(verifiedSourceMetadata?.durationSeconds) ||
            verifiedSourceMetadata.durationSeconds < 1 || verifiedSourceMetadata.durationSeconds > 30) {
          const invalid = new Error("Magnific video upscaling requires an authorized source video no longer than 30 seconds.");
          invalid.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw invalid;
        }
        if (!Number.isSafeInteger(verifiedSourceMetadata?.frameCount) || verifiedSourceMetadata.frameCount < 1 || verifiedSourceMetadata.frameCount > 1000000) {
          const invalid = new Error("Magnific video upscaling requires a server-probed output frame count for safe credit reservation.");
          invalid.code = "VIDEO_PRICE_INPUT_REQUIRED";
          throw invalid;
        }
        if (!["720p", "1k", "2k", "4k"].includes(input.resolution ?? "2k")) {
          throw new Error("Magnific video upscaling resolution must be 720p, 1k, 2k or 4k.");
        }
      } else if (runwayHdrEnabled) {
        if (!input.sourceVideoAssetId || !Number.isFinite(verifiedSourceMetadata?.durationSeconds) ||
            Math.ceil(verifiedSourceMetadata.durationSeconds) !== input.durationSeconds) {
          const invalid = new Error("Ruby HDR requires a verified source video and matching duration.");
          invalid.code = "VIDEO_SOURCE_METADATA_MISMATCH";
          throw invalid;
        }
      } else {
        if (input.resolution !== undefined && !["provider_default","720p"].includes(input.resolution)) {
          const unsupported = new Error("Gemini Omni budget reservation currently supports 720p only.");
          unsupported.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw unsupported;
        }
        if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 3 || input.durationSeconds > 10) {
          const invalid = new Error("Gemini Omni duration must be between 3 and 10 seconds.");
          invalid.code = "VIDEO_PRICE_DURATION_INVALID";
          throw invalid;
        }
        if (input.operation !== undefined && !["generate","edit","extend"].includes(input.operation)) {
          throw new Error("Gemini Omni operation must be generate, edit or extend.");
        }
        if (input.lastFrameAssetId && !input.firstFrameAssetId) {
          throw new Error("A Gemini Omni last frame requires a first frame.");
        }
        if (input.referenceImageAssetIds !== undefined &&
            (!Array.isArray(input.referenceImageAssetIds) || input.referenceImageAssetIds.length > 5)) {
          throw new Error("Gemini Omni accepts at most five reference images.");
        }
        if (input.referenceVideoAssetIds !== undefined &&
            (!Array.isArray(input.referenceVideoAssetIds) || input.referenceVideoAssetIds.length > 3)) {
          throw new Error("Gemini Omni accepts at most three reference videos.");
        }
        if (input.previousInteractionId && !input.projectId) {
          throw new Error("Gemini Omni conversational edits require project scope.");
        }
        if (input.operation === "generate" && (input.previousInteractionId || input.sourceVideoAssetId)) {
          throw new Error("Gemini Omni generate mode cannot include a previous interaction or source video.");
        }
        if (["edit","extend"].includes(input.operation) && !input.previousInteractionId && !input.sourceVideoAssetId) {
          throw new Error("Gemini Omni edit and extend modes require a previous interaction or source video.");
        }
        const unsupportedGoogleFields = ["negativePrompt","seed","motionReferenceAssetId","referenceAudioAssetIds",
          "referenceAudioCount","inputVideoSeconds","referenceVideoSeconds","audio","targetFramerate"];
        if (unsupportedGoogleFields.some(field => input[field] !== undefined)) {
          const unsupported = new Error("Gemini Omni does not support one or more requested finishing, audio-reference or motion controls.");
          unsupported.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
          throw unsupported;
        }
      }
      const modelRecord = getVideoProviderModel(provider, model);
      if (!modelRecord) {
        const unsupported = new Error("The selected provider/model is not present in the verified capability registry.");
        unsupported.code = "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY";
        throw unsupported;
      }
      const capabilityInput = googleEnabled ? {
        ...input,
        resolution: input.resolution === undefined || input.resolution === "provider_default" ? "720p" : input.resolution,
        startFrameAssetId: input.firstFrameAssetId ?? input.startFrameAssetId,
        endFrameAssetId: input.lastFrameAssetId ?? input.endFrameAssetId,
        referenceAssetIds: input.referenceImageAssetIds ?? input.referenceAssetIds
      } : verifiedSourceMetadata ? {
        ...input,
        durationSeconds: Math.ceil(verifiedSourceMetadata.durationSeconds),
        ...(runwayUpscaleEnabled ? { outputFrames: verifiedSourceMetadata.frameCount, resolution: input.resolution ?? "2k" } : {})
      } : input;
      const normalizedRequest = normalizeVideoGenerationRequest(capabilityInput);
      assertVideoCapabilities(normalizedRequest, modelRecord.capabilities);

      if (currency !== estimate.currency) throw new Error("Budget approval currency must match the verified provider price.");
      if (reservedAmount < estimate.amount) {
        const error = new Error("Budget reservation is below the verified provider/model price estimate.");
        error.code = "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE";
        error.estimate = estimate;
        throw error;
      }
      // Keep this application gate aligned with the reviewed SQL migration.
      // Aleph 2 is enabled only for video-to-video MP4 edits; SQL independently
      // enforces duration, minimum price, exact approval and project budget policy.
      const sqlEnqueueSupported =
        (provider === "runway" && model === "gen4.5") ||
        (provider === "runway" && model === "aleph2" && input.operation === "video-to-video" && input.outputFormat === "mp4") ||
        (provider === "runway" && model === "model-router" && ["text-to-video", "image-to-video", "video-to-video"].includes(input.operation)) ||
        (provider === "google" && model === "gemini-omni-1.1-flash");
      if (!sqlEnqueueSupported) {
        const unavailable = new Error("This provider/model has a worker adapter but is not yet enabled by the durable database enqueue and pricing policy.");
        unavailable.code = "VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED";
        throw unavailable;
      }

      const rows = await call(RPC.enqueue, {
        p_owner_id: ownerId, p_project_id: projectId, p_idempotency_key: idempotencyKey,
        p_provider: provider, p_model: model, p_request_hash: requestHash, p_input: input,
        p_budget_approval_id: budgetApprovalId, p_reserved_amount: reservedAmount, p_currency: currency
      });
      if (!Array.isArray(rows) || rows.length !== 1 ||
          typeof rows[0]?.job_id !== "string" ||
          !["queued","submitted","processing","reviewing","succeeded","partial","failed","cancelled","blocked","needs_input","expired"].includes(rows[0]?.job_status) ||
          typeof rows[0]?.idempotent_replay !== "boolean" ||
          typeof rows[0]?.budget_reservation_id !== "string") {
        throw new Error("Cloud video enqueue returned an invalid job/reservation result.");
      }
      return Object.freeze({
        jobId: rows[0].job_id,
        status: rows[0].job_status,
        idempotentReplay: rows[0].idempotent_replay,
        budgetReservationId: rows[0].budget_reservation_id
      });
    },
    async defer({ jobId, workerId, leaseToken, delaySeconds = 30, reasonCode = "VIDEO_PROVIDER_POLL_DEFERRED" } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (typeof leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) throw new Error("A valid worker lease token is required.");
      if (!Number.isInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 900) throw new Error("Defer delay must be between 5 and 900 seconds.");
      if (typeof reasonCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(reasonCode)) throw new Error("Defer reason code is invalid.");
      const result = await call(RPC.defer, {
        p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken, p_delay_seconds: delaySeconds, p_reason_code: reasonCode
      });
      if (typeof result !== "boolean") throw new Error("Cloud video defer returned an invalid result.");
      return result;
    },
    async quarantine({ jobId, workerId, leaseToken, reasonCode = "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION" } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (typeof leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) throw new Error("A valid worker lease token is required.");
      if (typeof reasonCode !== "string" || !/^[A-Z0-9_]{1,100}$/.test(reasonCode)) throw new Error("Quarantine reason code is invalid.");
      const result = await call(RPC.quarantine, {
        p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken, p_reason_code: reasonCode
      });
      if (typeof result !== "boolean") throw new Error("Cloud video quarantine returned an invalid result.");
      return result;
    },
    async recoverExpiredVideo(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Video recovery limit must be between 1 and 1000.");
      const result = await call(RPC.recover, { p_limit: limit });
      if (!Number.isInteger(result) || result < 0) throw new Error("Cloud video recovery returned an invalid count.");
      return result;
    },
    async resumeReconciled({ jobId, ownerId, evidenceReference } = {}) {
      required(jobId, "Job ID");
      required(ownerId, "Owner ID");
      required(evidenceReference, "Evidence reference", 1000);
      const result = await call(RPC.resume, {
        p_job_id: jobId, p_owner_id: ownerId, p_evidence_reference: evidenceReference
      });
      if (typeof result !== "boolean") throw new Error("Cloud video resume returned an invalid result.");
      return result;
    },
    async finish({ jobId, workerId, leaseToken, status, output = null, error = null, actualAmount = null } = {}) {
      required(jobId, "Job ID");
      required(workerId, "Worker ID", 128);
      if (typeof leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) throw new Error("A valid worker lease token is required.");
      if (!["succeeded", "partial", "failed", "cancelled"].includes(status)) throw new Error("Video job status must be terminal.");
      for (const [label, value] of [["output", output], ["error", error]]) {
        if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Job " + label + " must be an object or null.");
        if (value !== null && Buffer.byteLength(JSON.stringify(value), "utf8") > (label === "output" ? 32000 : 8000)) throw new Error("Job " + label + " exceeds its size limit.");
      }
      if (["succeeded", "partial"].includes(status)) {
        if (typeof actualAmount !== "number" || !Number.isFinite(actualAmount) || actualAmount < 0 || actualAmount > 100000000) {
          throw new Error("Successful video jobs require a non-negative bounded actual amount.");
        }
      } else if (actualAmount !== null) {
        throw new Error("Failed or cancelled video jobs must release their reservation without an actual amount.");
      }
      const result = await call(RPC.finish, {
        p_job_id: jobId, p_worker_id: workerId, p_lease_token: leaseToken, p_status: status,
        p_output: output, p_error: error, p_actual_amount: actualAmount
      });
      if (typeof result !== "boolean") throw new Error("Cloud video job finalization returned an invalid result.");
      return result;
    }
  });
}
