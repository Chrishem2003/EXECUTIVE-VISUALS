import { createHash } from "node:crypto";
const API_BASE = "https://api.dev.runwayml.com/v1";
const API_VERSION = "2024-11-06";
const fail = (message, code = "RUNWAY_ROUTER_PREFLIGHT_INVALID_INPUT") =>
  Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const LIMITS = Object.freeze({ referenceImages: 4, referenceVideos: 2, referenceAudio: 1 });

function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (plain(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

function inputFingerprint(payload) {
  return createHash("sha256")
    .update(stableJson({ configId: payload.configId, input: payload.input }))
    .digest("hex");
}

function configSlug(value) {
  const slug = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) {
    throw fail("A valid saved Runway Model Router config ID is required.", "RUNWAY_ROUTER_CONFIG_INVALID");
  }
  return slug;
}

function validateAssetUri(uri, kind) {
  if (typeof uri !== "string" || uri.length < 13 || uri.length > 5 * 1024 * 1024) {
    throw fail("Resolved " + kind + " asset URI is outside supported bounds.", "RUNWAY_ROUTER_ASSET_INVALID");
  }
  if (/^runway:\/\/[A-Za-z0-9._~:/-]+$/.test(uri)) return uri;
  const dataPattern = kind === "image" ? /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i
    : kind === "video" ? /^data:video\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i
      : /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
  if (dataPattern.test(uri)) return uri;
  let url;
  try { url = new URL(uri); } catch { throw fail("Resolved " + kind + " asset URI is invalid.", "RUNWAY_ROUTER_ASSET_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) {
    throw fail("Resolved " + kind + " asset URI must be credential-free HTTPS without fragments or non-standard ports.", "RUNWAY_ROUTER_ASSET_INVALID");
  }
  return url.href;
}

function validateReferences(items, field, kind) {
  if (!Array.isArray(items)) throw fail(field + " must be an array.");
  if (items.length > LIMITS[field]) throw fail("Too many " + field + " assets.");
  const roles = new Set();
  return items.map(item => {
    if (!plain(item)) throw fail("Each " + field + " item must be an object.");
    if (field === "referenceImages") {
      if (!["first", "last", "reference"].includes(item.role)) throw fail("Image references require first, last or reference roles.");
      if (item.role !== "reference" && roles.has(item.role)) throw fail("Only one first-frame and one last-frame image are allowed.");
      roles.add(item.role);
    } else if (field === "referenceVideos") {
      if (!["source", "reference"].includes(item.role)) throw fail("Video references require source or reference roles.");
      if (item.role === "source" && roles.has("source")) throw fail("Only one source video is allowed.");
      roles.add(item.role);
    }
    return field === "referenceAudio"
      ? { uri: validateAssetUri(item.uri, kind) }
      : { uri: validateAssetUri(item.uri, kind), role: item.role };
  });
}

/** Builds a strictly non-billable Runway Model Router request. */
export function buildRunwayRouterDryRunPayload({
  configId, prompt, negativePrompt, durationSeconds, aspectRatio, resolution,
  audio, seed, referenceImages = [], referenceVideos = [], referenceAudio = [], contentModeration
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 26000) {
    throw fail("Runway router prompt must contain 1 to 26,000 characters.");
  }
  const input = { promptText: prompt.trim() };
  if (negativePrompt !== undefined) {
    if (typeof negativePrompt !== "string" || negativePrompt.length > 1000) throw fail("Runway negative prompt must not exceed 1,000 characters.");
    if (negativePrompt.trim()) input.negativePrompt = negativePrompt.trim();
  }
  if (durationSeconds !== undefined) {
    if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 30) throw fail("Runway router duration must be a whole number from 2 to 30 seconds.");
    input.duration = durationSeconds;
  }
  if (aspectRatio !== undefined) {
    if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(aspectRatio)) throw fail("Runway router aspect ratio is unsupported.");
    input.aspectRatio = aspectRatio;
  }
  if (resolution !== undefined) {
    if (!["480p", "720p", "1080p", "4k"].includes(resolution)) throw fail("Runway router resolution is unsupported.");
    input.resolution = resolution;
  }
  if (audio !== undefined) {
    if (typeof audio !== "boolean") throw fail("Runway router audio must be a boolean.");
    input.audio = audio;
  }
  if (seed !== undefined) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw fail("Runway router seed must be an unsigned 32-bit integer.");
    input.seed = seed;
  }
  const images = validateReferences(referenceImages, "referenceImages", "image");
  const videos = validateReferences(referenceVideos, "referenceVideos", "video");
  const audios = validateReferences(referenceAudio, "referenceAudio", "audio");
  if (images.length) input.referenceImages = images;
  if (videos.length) input.referenceVideos = videos;
  if (audios.length) input.referenceAudio = audios;
  if (contentModeration !== undefined) {
    if (!plain(contentModeration) || !["auto", "low"].includes(contentModeration.publicFigureThreshold)) {
      throw fail("Runway content moderation threshold must be auto or low.");
    }
    input.contentModeration = { publicFigureThreshold: contentModeration.publicFigureThreshold };
  }
  return Object.freeze({ configId: configSlug(configId), dryRun: true, input: Object.freeze(input) });
}

const ASSET_GROUPS = Object.freeze([
  ["referenceImages", "image"], ["referenceVideos", "video"], ["referenceAudio", "audio"]
]);

async function resolvePrivateReferences(input, resolver, getAuthorizedAssetContext) {
  const resolved = { ...input };
  const hasReferences = ASSET_GROUPS.some(([field]) => Array.isArray(input[field]) && input[field].length > 0);
  let context = null;
  if (hasReferences) {
    if (typeof getAuthorizedAssetContext !== "function") throw fail("An authenticated project-access resolver is required for reference media.", "RUNWAY_ROUTER_ASSET_AUTH_REQUIRED");
    if (typeof input.projectId !== "string" || !input.projectId.trim()) throw fail("A project ID is required for private reference media.", "RUNWAY_ROUTER_ASSET_INVALID");
    try { context = await getAuthorizedAssetContext({ projectId: input.projectId }); }
    catch { throw fail("The active user is not authorized for this project.", "RUNWAY_ROUTER_ASSET_FORBIDDEN"); }
    if (!plain(context) || typeof context.ownerId !== "string" || !context.ownerId.trim() || context.projectId !== input.projectId) {
      throw fail("The authenticated project-access resolver returned an invalid scope.", "RUNWAY_ROUTER_ASSET_FORBIDDEN");
    }
  }
  for (const [field, kind] of ASSET_GROUPS) {
    const refs = input[field] || [];
    if (!Array.isArray(refs) || refs.length > LIMITS[field]) throw fail("Invalid or excessive " + field + " asset list.");
    if (refs.length && typeof resolver !== "function") throw fail("A private project asset resolver is required for reference media.", "RUNWAY_ROUTER_ASSET_RESOLVER_REQUIRED");
    resolved[field] = await Promise.all(refs.map(async ref => {
      if (!plain(ref) || typeof ref.assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.assetId)) {
        throw fail("Each reference asset must include a valid asset ID.", "RUNWAY_ROUTER_ASSET_INVALID");
      }
      let result;
      try {
        result = await resolver({
          assetId: ref.assetId, ownerId: context.ownerId,
          projectId: context.projectId, mediaType: kind
        });
      } catch {
        throw fail("A private reference asset could not be resolved.", "RUNWAY_ROUTER_ASSET_UNAVAILABLE");
      }
      const uri = validateAssetUri(result?.uri, kind);
      return field === "referenceAudio" ? { uri } : { uri, role: ref.role };
    }));
  }
  delete resolved.ownerId;
  delete resolved.projectId;
  return resolved;
}

function normalizeDecision(payload, expectedConfigId, requestFingerprint) {
  if (!plain(payload)) throw fail("Runway returned an invalid router preflight response.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  if (typeof payload.id === "string" && payload.id.trim()) {
    throw fail("Runway returned a task ID for a dry-run request; the response was quarantined.", "RUNWAY_ROUTER_DRY_RUN_UNEXPECTED_TASK");
  }
  const routing = payload.routing;
  if (!plain(routing)) throw fail("Runway omitted the router decision.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  const credits = routing.estimatedCost?.credits;
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw fail("Runway omitted a valid estimated credit cost.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  if (routing.configId !== undefined && routing.configId !== expectedConfigId) {
    throw fail("Runway returned a decision for a different router configuration.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  if (typeof routing.model !== "string" || !routing.model || typeof routing.provider !== "string" || !routing.provider) {
    throw fail("Runway omitted the selected provider or model.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  return Object.freeze({
    status: "preflighted", dryRun: true, taskCreated: false, billed: false,
    configId: expectedConfigId, provider: routing.provider, model: routing.model,
    estimatedCredits: credits, inputHash: requestFingerprint,
    ...(plain(routing.resolvedSettings) ? { resolvedSettings: Object.freeze({ ...routing.resolvedSettings }) } : {}),
    ...(plain(routing.resolvedInput) ? { resolvedInput: Object.freeze({ ...routing.resolvedInput }) } : {}),
    ...(plain(routing.capacityFallback) ? { capacityFallback: Object.freeze({ ...routing.capacityFallback }) } : {})
  });
}

/**
 * Calls only POST /generate/video with dryRun:true. It cannot create a task.
 */
export function createRunwayRouterDryRunClient({
  env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30000,
  resolvePrivateAsset, getAuthorizedAssetContext
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  async function preflight(input, { maxEstimatedCredits } = {}) {
    if (env.RUNWAY_ROUTER_PREFLIGHT_ENABLED !== "true") throw fail("Runway Model Router preflight is disabled.", "RUNWAY_ROUTER_PREFLIGHT_DISABLED");
    if (env.RUNWAY_VIDEO_ALLOW_REMOTE !== "true") throw fail("Runway remote access requires explicit server-side opt-in.", "RUNWAY_REMOTE_DISABLED");
    const key = String(env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET || "").trim();
    if (!key) throw fail("Configure the Runway API key on the server.", "RUNWAY_CONFIG_INVALID");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail("Runway preflight timeout is invalid.");
    const resolvedInput = await resolvePrivateReferences(input, resolvePrivateAsset, getAuthorizedAssetContext);
    const payload = buildRunwayRouterDryRunPayload(resolvedInput);
    if (maxEstimatedCredits !== undefined && (!Number.isSafeInteger(maxEstimatedCredits) || maxEstimatedCredits < 0)) {
      throw fail("Maximum estimated credits must be a non-negative safe integer.", "RUNWAY_ROUTER_BUDGET_INVALID");
    }
    const requestFingerprint = inputFingerprint(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(API_BASE + "/generate/video", {
          method: "POST",
          headers: { authorization: "Bearer " + key, "X-Runway-Version": API_VERSION, "content-type": "application/json" },
          body: JSON.stringify(payload), signal: controller.signal, redirect: "error"
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Runway router preflight timed out." : "Runway router preflight could not reach the API.",
          error?.name === "AbortError" ? "RUNWAY_TIMEOUT" : "RUNWAY_UNAVAILABLE");
      }
      if (response.status === 429) throw fail("Runway rate limit reached.", "RUNWAY_RATE_LIMITED");
      if (response.status >= 500) throw fail("Runway returned a temporary server error.", "RUNWAY_SERVER_ERROR");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("Runway router response exceeded the 1 MB limit.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
      let result;
      try { result = raw ? JSON.parse(raw) : null; }
      catch {
        if (!response.ok) throw fail("Runway rejected the router preflight (HTTP " + response.status + ").", "RUNWAY_REQUEST_REJECTED");
        throw fail("Runway returned invalid router JSON.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
      }
      if (!response.ok) {
        if (response.status === 400 && result?.code === "no_eligible_model") {
          throw fail("Runway Model Router found no eligible model for this input and configuration.", "RUNWAY_NO_ELIGIBLE_MODEL");
        }
        if (response.status === 404) throw fail("The saved Runway Model Router configuration is unavailable to this account.", "RUNWAY_ROUTER_CONFIG_NOT_FOUND");
        throw fail("Runway rejected the router preflight (HTTP " + response.status + ").", "RUNWAY_REQUEST_REJECTED");
      }
      const decision = normalizeDecision(result, payload.configId, requestFingerprint);
      if (maxEstimatedCredits !== undefined && decision.estimatedCredits > maxEstimatedCredits) {
        throw fail("Runway router estimate exceeds the approved credit ceiling; no generation was created.", "RUNWAY_ROUTER_BUDGET_EXCEEDED");
      }
      return Object.freeze({ ...decision, budgetCheck: maxEstimatedCredits === undefined ? "not_checked" : "within_limit" });
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({ provider: "runway", mode: "dry_run_only", preflight });
}
