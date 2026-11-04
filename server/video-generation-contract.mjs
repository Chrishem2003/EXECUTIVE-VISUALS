import { createHash, randomUUID } from "node:crypto";

const ALLOWED_ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
const ALLOWED_AUDIO_MODES = new Set(["provider_default", "generated", "none", "reference"]);
const MAX_PROMPT_LENGTH = 12000;
const MAX_REFERENCE_ASSETS = 12;

export class VideoGenerationValidationError extends Error {
  constructor(message, code = "VIDEO_GENERATION_INVALID_REQUEST") {
    super(message);
    this.name = "VideoGenerationValidationError";
    this.code = code;
  }
}

function boundedString(value, label, maxLength, { required = false } = {}) {
  if (value == null && !required) return undefined;
  if (typeof value !== "string") {
    throw new VideoGenerationValidationError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw new VideoGenerationValidationError(`${label} is required`);
  }
  if (normalized.length > maxLength) {
    throw new VideoGenerationValidationError(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function finiteNumber(value, label, { min, max, required = false, integer = false } = {}) {
  if (value == null && !required) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VideoGenerationValidationError(`${label} must be a finite number`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new VideoGenerationValidationError(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new VideoGenerationValidationError(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function assetIds(value, label, maxItems = MAX_REFERENCE_ASSETS) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new VideoGenerationValidationError(`${label} must be an array of at most ${maxItems} asset IDs`);
  }
  const ids = value.map((item) => boundedString(item, `${label} item`, 160, { required: true }));
  if (new Set(ids).size !== ids.length) {
    throw new VideoGenerationValidationError(`${label} cannot contain duplicate asset IDs`);
  }
  return ids;
}

/**
 * Normalize and validate a provider-neutral video-generation request.
 * This function intentionally does not guess provider support or discard options.
 */
export function normalizeVideoGenerationRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VideoGenerationValidationError("Request must be an object");
  }

  const prompt = boundedString(input.prompt, "prompt", MAX_PROMPT_LENGTH, { required: true });
  const negativePrompt = boundedString(input.negativePrompt, "negativePrompt", 4000);
  const aspectRatio = input.aspectRatio ?? "16:9";
  if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
    throw new VideoGenerationValidationError("aspectRatio is not supported by the normalized contract");
  }
  const audioMode = input.audioMode ?? "provider_default";
  if (!ALLOWED_AUDIO_MODES.has(audioMode)) {
    throw new VideoGenerationValidationError("audioMode is not supported by the normalized contract");
  }

  const resolution = input.resolution ?? "provider_default";
  if (!["provider_default", "480p", "720p", "1080p", "1440p", "2160p"].includes(resolution)) {
    throw new VideoGenerationValidationError("resolution must be provider_default, 480p, 720p, 1080p, 1440p, or 2160p");
  }

  const request = {
    requestId: boundedString(input.requestId, "requestId", 160) ?? randomUUID(),
    ...(input.projectId != null && input.projectId !== "" ? { projectId: boundedString(input.projectId, "projectId", 160, { required: true }) } : {}),
    prompt,
    aspectRatio,
    resolution,
    durationSeconds: finiteNumber(input.durationSeconds ?? 5, "durationSeconds", { min: 1, max: 180, required: true, integer: true }),
    audioMode,
    referenceAssetIds: assetIds(input.referenceAssetIds, "referenceAssetIds"),
    ...(negativePrompt ? { negativePrompt } : {}),
  };

  if (input.seed != null) request.seed = finiteNumber(input.seed, "seed", { min: 0, max: 4294967295, integer: true });
  if (input.startFrameAssetId != null) {
    request.startFrameAssetId = boundedString(input.startFrameAssetId, "startFrameAssetId", 160, { required: true });
  }
  if (input.endFrameAssetId != null) {
    request.endFrameAssetId = boundedString(input.endFrameAssetId, "endFrameAssetId", 160, { required: true });
  }
  if (input.motionReferenceAssetId != null) {
    request.motionReferenceAssetId = boundedString(input.motionReferenceAssetId, "motionReferenceAssetId", 160, { required: true });
  }
  if (input.provider != null) request.provider = boundedString(input.provider, "provider", 80, { required: true });
  if (input.model != null) request.model = boundedString(input.model, "model", 160, { required: true });

  return Object.freeze(request);
}

/**
 * Provider declarations are explicit. Unsupported requested inputs fail closed.
 */
export function assertVideoCapabilities(request, capabilities = {}) {
  const checks = [
    [request.negativePrompt != null, capabilities.negativePrompt === true, "negativePrompt"],
    [request.seed != null, capabilities.seed === true, "seed"],
    [request.startFrameAssetId != null, capabilities.startFrame === true, "startFrameAssetId"],
    [request.endFrameAssetId != null, capabilities.endFrame === true, "endFrameAssetId"],
    [request.motionReferenceAssetId != null, capabilities.motionReference === true, "motionReferenceAssetId"],
    [request.referenceAssetIds.length > 0, capabilities.referenceImages === true, "referenceAssetIds"],
    [request.audioMode !== "provider_default", capabilities.audioModes?.includes?.(request.audioMode) === true, "audioMode"],
  ];
  const unsupported = checks.filter(([requested, supported]) => requested && !supported).map(([, , field]) => field);
  if (unsupported.length) {
    throw new VideoGenerationValidationError(
      `Selected provider/model does not declare support for: ${unsupported.join(", ")}`,
      "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY",
    );
  }

  if (capabilities.aspectRatios && !capabilities.aspectRatios.includes(request.aspectRatio)) {
    throw new VideoGenerationValidationError("Selected provider/model does not support this aspect ratio", "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  }
  if (capabilities.resolutions && !capabilities.resolutions.includes(request.resolution)) {
    throw new VideoGenerationValidationError("Selected provider/model does not support this resolution", "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  }
  if (capabilities.minDurationSeconds != null && request.durationSeconds < capabilities.minDurationSeconds) {
    throw new VideoGenerationValidationError("Requested duration is below the provider/model minimum", "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  }
  if (capabilities.maxDurationSeconds != null && request.durationSeconds > capabilities.maxDurationSeconds) {
    throw new VideoGenerationValidationError("Requested duration exceeds the provider/model maximum", "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  }
  return true;
}

export function createVideoRequestProvenance(request, { provider, model, adapterVersion = "1" } = {}) {
  const normalized = normalizeVideoGenerationRequest(request);
  const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return Object.freeze({
    requestId: normalized.requestId,
    projectId: normalized.projectId,
    provider: provider ?? normalized.provider ?? "unknown",
    model: model ?? normalized.model ?? "unknown",
    adapterVersion,
    requestHash,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Deterministic test adapter. It never performs network calls or creates media.
 */
export function createMockVideoGenerationAdapter({ capabilities = {} } = {}) {
  return Object.freeze({
    provider: "mock",
    model: "mock-video-v1",
    capabilities: Object.freeze({
      negativePrompt: true,
      seed: true,
      startFrame: true,
      endFrame: true,
      motionReference: true,
      referenceImages: true,
      audioModes: ["generated", "none", "reference"],
      aspectRatios: [...ALLOWED_ASPECT_RATIOS],
      resolutions: ["provider_default", "480p", "720p", "1080p"],
      minDurationSeconds: 1,
      maxDurationSeconds: 30,
      ...capabilities,
    }),
    async submit(input) {
      const request = normalizeVideoGenerationRequest(input);
      assertVideoCapabilities(request, this.capabilities);
      return Object.freeze({
        jobId: `mock-${request.requestId}`,
        requestId: request.requestId,
        provider: this.provider,
        model: this.model,
        status: "queued",
        mock: true,
        message: "Mock adapter accepted the request; no video was generated and no network request was made.",
      });
    },
    async getStatus(jobId) {
      if (typeof jobId !== "string" || !jobId.startsWith("mock-")) {
        throw new VideoGenerationValidationError("Unknown mock job ID", "VIDEO_GENERATION_JOB_NOT_FOUND");
      }
      return Object.freeze({ jobId, status: "succeeded", mock: true, output: null });
    },
  });
}
