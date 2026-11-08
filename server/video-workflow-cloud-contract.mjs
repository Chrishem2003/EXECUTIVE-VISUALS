import { createHash } from "node:crypto";
import { normalizeVideoGenerationRequest } from "./video-generation-contract.mjs";

const fail = (message, code = "VIDEO_WORKFLOW_CLOUD_CONTRACT_INVALID") =>
  Object.assign(new Error(message), { code });

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assetList(value, label, maximum) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum ||
      value.some(item => typeof item !== "string" || !item.trim())) {
    throw fail(label + " must contain at most " + maximum + " non-empty asset IDs.");
  }
  const ids = value.map(item => item.trim());
  if (new Set(ids).size !== ids.length) throw fail(label + " cannot contain duplicate asset IDs.");
  return ids;
}

/**
 * Build the immutable, provider-bound input for a governed cloud video job.
 *
 * This is deliberately a contract builder, not an enqueue shortcut: callers
 * must still authenticate/authorize the project, resolve assets server-side,
 * obtain a quote, bind an explicit approval, reserve funds and use the durable
 * cloud enqueue/ledger. No provider or storage network calls occur here.
 *
 * The first supported workflow adapter is Runway Model Router because it has
 * a dedicated durable worker, dry-run price ceiling and task-level settlement.
 */
export function createVideoWorkflowCloudRequest({
  node, values = {}, projectId, requestId
} = {}) {
  if (!node || node.kind !== "video.generate") {
    throw fail("Only video.generate workflow nodes are supported by this cloud contract.", "VIDEO_WORKFLOW_CLOUD_NODE_UNSUPPORTED");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw fail("Workflow node values must be an object.");
  }
  const config = node.config && typeof node.config === "object" && !Array.isArray(node.config)
    ? node.config : {};
  const provider = firstString(config.provider);
  const model = firstString(config.model);
  if (provider !== "runway" || model !== "model-router") {
    throw fail("The first governed workflow adapter supports only the explicit runway/model-router identity.", "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE");
  }
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160) {
    throw fail("A saved project ID is required for cloud video workflow execution.", "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED");
  }
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
    throw fail("A stable workflow request ID is required for idempotent cloud execution.", "VIDEO_WORKFLOW_CLOUD_REQUEST_ID_REQUIRED");
  }

  const prompt = firstString(values.prompt, values.text, values.input, config.prompt);
  const sourceVideoAssetId = firstString(
    values.sourceVideoAssetId, values.sourceVideo, values.video,
    config.sourceVideoAssetId
  );
  const startFrameAssetId = firstString(
    values.startFrameAssetId, values["start-frame"], values.image, values.referenceImage, values.reference, config.startFrameAssetId, config.referenceAssetId
  );
  const referenceAssetIds = assetList(
    config.referenceImageAssetIds ?? values.referenceImageAssetIds ?? values.references,
    "Reference images", 4
  );
  const referenceVideoAssetIds = assetList(
    config.referenceVideoAssetIds ?? values.referenceVideoAssetIds,
    "Reference videos", 1
  );
  const referenceAudioAssetIds = assetList(
    config.referenceAudioAssetIds ?? values.referenceAudioAssetIds ??
      (firstString(values.referenceAudioAssetId, config.referenceAudioAssetId)
        ? [firstString(values.referenceAudioAssetId, config.referenceAudioAssetId)] : []),
    "Reference audio", 1
  );

  const allAssetIds = [
    sourceVideoAssetId,
    startFrameAssetId,
    ...referenceAssetIds,
    ...referenceVideoAssetIds,
    ...referenceAudioAssetIds
  ].filter(Boolean);
  if (new Set(allAssetIds).size !== allAssetIds.length) {
    throw fail(
      "A workflow asset cannot be assigned to more than one source/reference role.",
      "VIDEO_WORKFLOW_CLOUD_ASSET_ROLE_CONFLICT"
    );
  }

  const derivedOperation = sourceVideoAssetId
    ? "video-to-video"
    : startFrameAssetId || referenceAssetIds.length
      ? "image-to-video"
      : "text-to-video";
  const requestedOperation = firstString(config.operation);
  if (requestedOperation && requestedOperation !== derivedOperation) {
    throw fail("Configured operation does not match the connected source assets.", "VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  }
  if (!prompt) throw fail("Video generation requires a non-empty prompt.", "PROMPT_REQUIRED");
  if (startFrameAssetId && referenceAssetIds.includes(startFrameAssetId)) {
    throw fail("The first-frame asset cannot also appear in the reference-image list.");
  }
  if (startFrameAssetId && referenceAssetIds.length > 3) {
    throw fail("Runway Model Router accepts at most four images including the first frame.");
  }
  if (derivedOperation !== "video-to-video" && referenceVideoAssetIds.length) {
    throw fail("Reference videos require a source video and the video-to-video operation.");
  }
  const audioMode = config.audioMode ?? "provider_default";
  if (audioMode === "reference" && referenceAudioAssetIds.length !== 1) {
    throw fail("Reference audio mode requires exactly one connected reference-audio asset.");
  }
  if (audioMode !== "reference" && referenceAudioAssetIds.length) {
    throw fail("Reference-audio assets require audioMode=reference.");
  }

  const normalized = normalizeVideoGenerationRequest({
    requestId,
    projectId: projectId.trim(),
    provider,
    model,
    operation: derivedOperation,
    prompt,
    negativePrompt: config.negativePrompt ?? values.negativePrompt,
    durationSeconds: Number(config.durationSeconds ?? config.duration ?? 5),
    aspectRatio: config.aspectRatio ?? "16:9",
    resolution: config.resolution ?? "provider_default",
    audioMode,
    referenceAssetIds,
    referenceVideoAssetIds,
    referenceAudioAssetIds,
    ...(sourceVideoAssetId ? { sourceVideoAssetId } : {}),
    ...(startFrameAssetId ? { startFrameAssetId } : {}),
    ...(config.seed != null ? { seed: config.seed } : {})
  });

  if (normalized.durationSeconds < 2 || normalized.durationSeconds > 30) {
    throw fail("Runway Model Router duration must be between 2 and 30 seconds.", "VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }
  if (!["provider_default", "480p", "720p", "1080p", "4k"].includes(normalized.resolution)) {
    throw fail("Runway Model Router resolution is unsupported.", "VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }

  const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const input = deepFreeze({ ...normalized, requestHash });
  return deepFreeze({
    provider,
    model,
    operation: derivedOperation,
    requestId,
    projectId: projectId.trim(),
    requestHash,
    input
  });
}
