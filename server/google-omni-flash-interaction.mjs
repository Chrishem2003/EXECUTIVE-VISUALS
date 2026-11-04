const MODEL = "gemini-omni-1.1-flash";
const API_VERSION = "v1beta";
const RATIOS = new Set(["16:9", "9:16"]);
const RESOLUTIONS = new Set(["360p", "720p", "1080p", "4k"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code = "GEMINI_OMNI_INVALID_REQUEST") =>
  Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const GOOGLE_FILE_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+$/;
const GOOGLE_FILE_DOWNLOAD_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+(?::download\?alt=media)?$/;

function requiredString(value, label, max = 12000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw fail(label + " must be a non-empty string of at most " + max + " characters.");
  }
  return value.trim();
}

/**
 * Builds a Google Gemini Omni Flash Interactions API request from authorized
 * Executive Visuals asset IDs. This is a pure request planner: it never sends
 * a request, reads credentials, uploads media, or downloads generated output.
 */
export async function buildGeminiOmniFlashInteractionRequest({
  prompt,
  operation = "generate",
  aspectRatio = "16:9",
  resolution = "720p",
  delivery = "uri",
  previousInteractionId,
  projectId,
  referenceImageAssetIds = [],
  firstFrameAssetId,
  lastFrameAssetId,
  sourceVideoAssetId,
  referenceVideoAssetIds = [],
  getAuthorizedAssetContext,
  getAuthorizedInteractionContext,
  resolveGoogleFileAsset,
  ...unsupportedOptions
} = {}) {
  if (Object.keys(unsupportedOptions).length) {
    throw fail("Unsupported Gemini Omni options: " + Object.keys(unsupportedOptions).join(", "), "GEMINI_OMNI_UNSUPPORTED_OPTION");
  }
  const text = requiredString(prompt, "prompt");
  if (!["generate", "edit", "extend"].includes(operation)) throw fail("operation must be generate, edit or extend.");
  if (!RATIOS.has(aspectRatio)) throw fail("Gemini Omni supports only 16:9 and 9:16 output ratios.");
  if (!RESOLUTIONS.has(resolution)) throw fail("resolution must be 360p, 720p, 1080p or 4k.");
  if (!["uri", "inline"].includes(delivery)) throw fail("delivery must be uri or inline.");
  if (!Array.isArray(referenceImageAssetIds) || referenceImageAssetIds.length > 5) {
    throw fail("At most five reference images may be attached by this application.");
  }
  if (!Array.isArray(referenceVideoAssetIds) || referenceVideoAssetIds.length > 3) {
    throw fail("Gemini Omni accepts at most three reference video clips.");
  }
  if (lastFrameAssetId && !firstFrameAssetId) {
    throw fail("A last frame requires a first frame for interpolation.");
  }
  if (previousInteractionId !== undefined &&
      (typeof previousInteractionId !== "string" || !/^v1_[A-Za-z0-9_-]{6,200}$/.test(previousInteractionId))) {
    throw fail("previousInteractionId is invalid.");
  }
  if (operation === "generate" && (previousInteractionId || sourceVideoAssetId)) {
    throw fail("Generate mode cannot include a previous interaction or source video.");
  }
  if (operation === "edit" && !previousInteractionId && !sourceVideoAssetId) {
    throw fail("Edit mode requires a previous interaction or an uploaded source video.");
  }
  if (operation === "extend" && !previousInteractionId && !sourceVideoAssetId) {
    throw fail("Extend mode requires a previous interaction or an uploaded source video.");
  }
  if (previousInteractionId && sourceVideoAssetId) {
    throw fail("Use either a previous interaction or an uploaded source video, not both.");
  }
  if (sourceVideoAssetId && operation === "generate") {
    throw fail("A source video is only valid for edit or extend operations.");
  }

  const assetIds = [
    ...referenceImageAssetIds,
    ...(firstFrameAssetId ? [firstFrameAssetId] : []),
    ...(lastFrameAssetId ? [lastFrameAssetId] : []),
    ...(sourceVideoAssetId ? [sourceVideoAssetId] : []),
    ...referenceVideoAssetIds
  ];
  if (assetIds.some(id => typeof id !== "string" || !UUID.test(id))) {
    throw fail("All media inputs must be private asset UUIDs.");
  }
  if (new Set(assetIds).size !== assetIds.length) {
    throw fail("The same private asset cannot be assigned multiple media roles.");
  }
  if ((assetIds.length || previousInteractionId) && (
    typeof projectId !== "string" || !UUID.test(projectId) ||
    typeof getAuthorizedAssetContext !== "function"
  )) {
    throw fail("Private media and stateful interaction references require authenticated project scope.", "GEMINI_OMNI_ASSET_GATES_MISSING");
  }

  let scope;
  if (assetIds.length || previousInteractionId) {
    try { scope = await getAuthorizedAssetContext({ projectId }); }
    catch { throw fail("The active user is not authorized for this project.", "GEMINI_OMNI_ASSET_FORBIDDEN"); }
    if (!plain(scope) || !UUID.test(scope.ownerId ?? "") || scope.projectId !== projectId) {
      throw fail("Authenticated project scope is invalid.", "GEMINI_OMNI_ASSET_FORBIDDEN");
    }
  }
  if (assetIds.length && typeof resolveGoogleFileAsset !== "function") {
    throw fail("Private media requires a server-side Google Files resolver.", "GEMINI_OMNI_ASSET_GATES_MISSING");
  }
  if (previousInteractionId) {
    if (typeof getAuthorizedInteractionContext !== "function") {
      throw fail("Stateful edits require an owner/project-scoped interaction record.", "GEMINI_OMNI_INTERACTION_GATES_MISSING");
    }
    let interactionScope;
    try {
      interactionScope = await getAuthorizedInteractionContext({
        interactionId: previousInteractionId, ownerId: scope.ownerId, projectId: scope.projectId
      });
    } catch {
      throw fail("The previous interaction is not authorized for this project.", "GEMINI_OMNI_INTERACTION_FORBIDDEN");
    }
    if (!plain(interactionScope) || interactionScope.ownerId !== scope.ownerId ||
        interactionScope.projectId !== scope.projectId || interactionScope.model !== MODEL) {
      throw fail("The previous interaction does not belong to the active owner, project and model.", "GEMINI_OMNI_INTERACTION_FORBIDDEN");
    }
  }

  async function resolve(assetId, mediaType, role = mediaType) {
    let asset;
    try {
      asset = await resolveGoogleFileAsset({
        assetId, ownerId: scope.ownerId, projectId: scope.projectId, mediaType
      });
    } catch {
      throw fail("A private " + mediaType + " asset could not be resolved.", "GEMINI_OMNI_ASSET_UNAVAILABLE");
    }
    if (!plain(asset) || typeof asset.uri !== "string") {
      throw fail("The media resolver returned an invalid media URI.", "GEMINI_OMNI_ASSET_INVALID");
    }
    if (asset.sourceType === "signed_url") {
      let signed;
      try { signed = new URL(asset.uri); } catch { throw fail("The private media resolver returned an invalid signed URL.", "GEMINI_OMNI_ASSET_INVALID"); }
      const expiresAt = Date.parse(asset.expiresAt);
      if (signed.protocol !== "https:" || signed.username || signed.password || signed.hash ||
          !signed.searchParams.has("token") || !Number.isSafeInteger(asset.sizeBytes) ||
          asset.sizeBytes < 1 || asset.sizeBytes > 100 * 1024 * 1024 ||
          !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30000) {
        throw fail("The private signed URL is unsafe, expired, or exceeds Gemini's 100 MB external URL limit.",
          "GEMINI_OMNI_SIGNED_URL_INVALID");
      }
    } else if (!GOOGLE_FILE_URI.test(asset.uri)) {
      throw fail("The media resolver returned a non-Google or invalid Files API URI.", "GEMINI_OMNI_ASSET_INVALID");
    }
    if (asset.mediaType !== mediaType) {
      throw fail("The resolved asset media type does not match its requested role.", "GEMINI_OMNI_ASSET_INVALID");
    }
    if (role === "video" && (
      typeof asset.durationSeconds !== "number" || !Number.isFinite(asset.durationSeconds) ||
      asset.durationSeconds <= 0 || asset.durationSeconds > 10
    )) {
      throw fail("Uploaded source videos must have verified duration metadata and be ten seconds or shorter.");
    }
    if (role === "reference_video" && (
      typeof asset.durationSeconds !== "number" || !Number.isFinite(asset.durationSeconds) ||
      asset.durationSeconds <= 0 || asset.durationSeconds > 3
    )) {
      throw fail("Each reference video must be three seconds or shorter.");
    }
    return asset.uri;
  }

  const input = [];
  if (sourceVideoAssetId) {
    input.push({ type: "video", uri: await resolve(sourceVideoAssetId, "video") });
  }
  if (firstFrameAssetId) {
    input.push({ type: "image", uri: await resolve(firstFrameAssetId, "image") });
  }
  if (lastFrameAssetId) {
    input.push({ type: "image", uri: await resolve(lastFrameAssetId, "image") });
  }
  for (const id of referenceImageAssetIds) {
    input.push({ type: "image", uri: await resolve(id, "image") });
  }
  for (const id of referenceVideoAssetIds) {
    input.push({ type: "video", uri: await resolve(id, "video", "reference_video") });
  }
  input.push({ type: "text", text });

  const payload = {
    model: MODEL,
    input: input.length === 1 ? input[0].text : input,
    response_format: {
      type: "video",
      aspect_ratio: aspectRatio,
      resolution,
      delivery
    }
  };
  if (previousInteractionId) payload.previous_interaction_id = previousInteractionId;

  let task;
  if (operation === "edit") task = "edit";
  else if (operation === "extend") task = "extend";
  else if (firstFrameAssetId && !lastFrameAssetId) task = "image_to_video";
  else if (!firstFrameAssetId && (referenceImageAssetIds.length || referenceVideoAssetIds.length)) task = "reference_to_video";
  if (task) payload.generation_config = { video_config: { task } };

  return Object.freeze({
    endpoint: "https://generativelanguage.googleapis.com/" + API_VERSION + "/interactions",
    method: "POST",
    auth: Object.freeze({ headerName: "x-goog-api-key", credentialSource: "server-only" }),
    payload: Object.freeze(payload),
    policy: Object.freeze({
      provider: "google",
      model: MODEL,
      operation,
      remoteExecution: false,
      requiresApproval: true,
      outputMustBeIngestedPrivately: true,
      minimumPollIntervalMs: 5000,
      outputMayContainBase64: true,
      uriDeliveryRecommendedAboveBytes: 4 * 1024 * 1024
    })
  });
}

/**
 * Normalize only the documented raw REST interaction response. The SDK-only
 * output_video convenience property is intentionally not accepted here.
 */
export function normalizeGeminiOmniFlashInteractionResponse(response, {
  maxInlineVideoBytes = 32 * 1024 * 1024
} = {}) {
  if (!plain(response) || typeof response.id !== "string" ||
      !/^v1_[A-Za-z0-9_-]{6,200}$/.test(response.id) ||
      response.model !== MODEL || !Array.isArray(response.steps)) {
    throw fail("Gemini Omni REST interaction response is malformed.", "GEMINI_OMNI_INVALID_RESPONSE");
  }
  const statusMap = new Map([
    ["completed", "succeeded"], ["in_progress", "running"],
    ["requires_action", "waiting"], ["failed", "failed"],
    ["cancelled", "canceled"], ["incomplete", "incomplete"],
    ["budget_exceeded", "failed"]
  ]);
  const status = statusMap.get(response.status) ?? "unknown";
  let video = null;
  for (const step of response.steps) {
    if (!plain(step) || step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      if (!plain(item) || item.type !== "video") continue;
      if (item.mime_type !== "video/mp4") {
        throw fail("Gemini Omni returned an unsupported video MIME type.", "GEMINI_OMNI_INVALID_RESPONSE");
      }
      if (typeof item.data === "string") {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) {
          throw fail("Gemini Omni returned invalid base64 video data.", "GEMINI_OMNI_INVALID_RESPONSE");
        }
        const bytes = Math.floor(item.data.length * 3 / 4) - (item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0);
        if (bytes <= 0 || bytes > maxInlineVideoBytes) {
          throw fail("Inline video exceeds the configured response limit; use URI delivery.", "GEMINI_OMNI_RESPONSE_TOO_LARGE");
        }
        video = { mimeType: "video/mp4", delivery: "inline", base64: item.data, byteLength: bytes };
      } else if (typeof item.uri === "string" && GOOGLE_FILE_DOWNLOAD_URI.test(item.uri)) {
        video = { mimeType: "video/mp4", delivery: "uri", uri: item.uri };
      } else {
        throw fail("Gemini Omni video output contains neither valid base64 data nor a Google Files URI.", "GEMINI_OMNI_INVALID_RESPONSE");
      }
    }
  }
  if (status === "succeeded" && !video) {
    throw fail("Gemini Omni marked the interaction completed without a video output.", "GEMINI_OMNI_MISSING_OUTPUT");
  }
  return Object.freeze({
    interactionId: response.id,
    status,
    model: MODEL,
    video: video ? Object.freeze(video) : null
  });
}
