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

  const operation = input.operation;
  if (operation != null && !["text-to-video", "image-to-video", "video-to-video", "video-upscale", "video-to-hdr", "generate", "edit", "extend"].includes(operation)) {
    throw new VideoGenerationValidationError("operation is not supported by the normalized video contract");
  }
  const prompt = boundedString(input.prompt, "prompt", MAX_PROMPT_LENGTH, { required: !["video-upscale", "video-to-hdr"].includes(operation) });
  const negativePrompt = boundedString(input.negativePrompt, "negativePrompt", 4000);
  const aspectRatio = input.aspectRatio ?? "16:9";
  if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
    throw new VideoGenerationValidationError("aspectRatio is not supported by the normalized contract");
  }
  const audioMode = input.audioMode ?? "provider_default";
  if (!ALLOWED_AUDIO_MODES.has(audioMode)) {
    throw new VideoGenerationValidationError("audioMode is not supported by the normalized contract");
  }

  const resolution = input.resolution ?? (operation === "video-upscale" ? "2k" : "provider_default");
  if (!["provider_default", "480p", "720p", "1080p", "1440p", "2160p", "1k", "2k", "4k"].includes(resolution)) {
    throw new VideoGenerationValidationError("resolution must be a documented provider resolution tier");
  }

  const outputFormat = boundedString(
    input.outputFormat ?? (operation === "video-to-hdr" ? "hdr10" : "mp4"),
    "outputFormat", 32, { required: true }
  );
  const request = {
    requestId: boundedString(input.requestId, "requestId", 160) ?? randomUUID(),
    ...(input.projectId != null && input.projectId !== "" ? { projectId: boundedString(input.projectId, "projectId", 160, { required: true }) } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(operation !== undefined ? { operation } : {}),
    aspectRatio,
    resolution,
    durationSeconds: finiteNumber(input.durationSeconds ?? 5, "durationSeconds", { min: 1, max: 180, required: true, integer: true }),
    outputFormat,
    audioMode,
    referenceAssetIds: assetIds(input.referenceAssetIds ?? input.referenceImageAssetIds, "referenceAssetIds"),
    referenceVideoAssetIds: assetIds(input.referenceVideoAssetIds, "referenceVideoAssetIds", 2),
    referenceAudioAssetIds: assetIds(input.referenceAudioAssetIds, "referenceAudioAssetIds", 1),
    ...(negativePrompt ? { negativePrompt } : {}),
  };

  if (input.seed != null) request.seed = finiteNumber(input.seed, "seed", { min: 0, max: 4294967295, integer: true });
  if (audioMode === "reference" && request.referenceAudioAssetIds.length !== 1) {
    throw new VideoGenerationValidationError("Reference audio mode requires exactly one referenceAudioAssetId");
  }
  if (input.sourceVideoAssetId != null) {
    request.sourceVideoAssetId = boundedString(input.sourceVideoAssetId, "sourceVideoAssetId", 160, { required: true });
  }
  if (request.sourceVideoAssetId && request.referenceVideoAssetIds.length > 1) {
    throw new VideoGenerationValidationError("A source video leaves room for at most one additional reference video in the Runway Model Router contract");
  }
  if (request.sourceVideoAssetId && request.referenceVideoAssetIds.includes(request.sourceVideoAssetId)) {
    throw new VideoGenerationValidationError("The source video cannot also be supplied as a reference video");
  }
  if (input.keyframeAssetIds != null) request.keyframeAssetIds = assetIds(input.keyframeAssetIds, "keyframeAssetIds", 5);
  if (input.keyframes != null) {
    if (!Array.isArray(input.keyframes) || input.keyframes.length > 5) {
      throw new VideoGenerationValidationError("keyframes must be an array containing at most five timestamped assets");
    }
    let previousAt = -1;
    request.keyframes = input.keyframes.map((frame, index) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        throw new VideoGenerationValidationError("Each keyframe must contain an assetId and timestamp");
      }
      const assetId = boundedString(frame.assetId, "keyframes[" + index + "].assetId", 160, { required: true });
      const at = finiteNumber(frame.at, "keyframes[" + index + "].at", { min: 0, max: 30, required: true });
      if (at <= previousAt) throw new VideoGenerationValidationError("Keyframe timestamps must be strictly increasing");
      previousAt = at;
      return Object.freeze({ assetId, at });
    });
  }
  if (request.keyframeAssetIds?.length && !request.keyframes?.length) {
    throw new VideoGenerationValidationError("Keyframe asset IDs require explicit timestamps; use keyframes [{assetId, at}]");
  }
  if (request.keyframes?.length && operation !== "video-to-video") {
    throw new VideoGenerationValidationError("Timestamped keyframes are supported only for video-to-video");
  }
  if (["video-to-video", "video-upscale", "video-to-hdr"].includes(operation) && !request.sourceVideoAssetId) {
    throw new VideoGenerationValidationError("sourceVideoAssetId is required for this video operation");
  }
  if (operation !== "video-to-video" && request.keyframeAssetIds?.length) {
    throw new VideoGenerationValidationError("keyframeAssetIds are supported only for video-to-video");
  }
  if (input.outputFrames != null) request.outputFrames = finiteNumber(input.outputFrames, "outputFrames", { min: 1, max: 1000000, integer: true });
  for (const field of ["creativity", "sharpen", "smartGrain"]) {
    if (input[field] != null) request[field] = finiteNumber(input[field], field, { min: 0, max: 100, integer: true });
  }
  if (input.flavor != null) {
    if (!["vivid", "natural"].includes(input.flavor)) throw new VideoGenerationValidationError("flavor must be vivid or natural");
    request.flavor = input.flavor;
  }
  if (input.fpsBoost != null) {
    if (typeof input.fpsBoost !== "boolean") throw new VideoGenerationValidationError("fpsBoost must be a boolean");
    request.fpsBoost = input.fpsBoost;
  }
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
    [request.referenceVideoAssetIds.length > 0, capabilities.referenceVideos === true, "referenceVideoAssetIds"],
    [request.referenceAudioAssetIds.length > 0, capabilities.referenceAudio === true, "referenceAudioAssetIds"],
    [request.audioMode !== "provider_default", capabilities.audioModes?.includes?.(request.audioMode) === true, "audioMode"],
  ];
  const unsupported = checks.filter(([requested, supported]) => requested && !supported).map(([, , field]) => field);
  if (unsupported.length) {
    throw new VideoGenerationValidationError(
      `Selected provider/model does not declare support for: ${unsupported.join(", ")}`,
      "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY",
    );
  }

  for (const [field, limit] of [["referenceAssetIds", capabilities.maxReferenceImages], ["referenceVideoAssetIds", capabilities.maxReferenceVideos], ["referenceAudioAssetIds", capabilities.maxReferenceAudio]]) {
    if (Number.isInteger(limit) && request[field].length > limit) {
      throw new VideoGenerationValidationError(`Selected provider/model accepts at most ${limit} ${field} assets`, "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
    }
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
