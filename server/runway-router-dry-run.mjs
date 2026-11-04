const API_BASE = "https://api.dev.runwayml.com/v1";
const API_VERSION = "2024-11-06";
const RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
const RESOLUTIONS = new Set(["480p", "720p", "1080p", "4k"]);
const fail = (message, code = "RUNWAY_ROUTER_PREFLIGHT_INVALID_INPUT") =>
  Object.assign(new Error(message), { code });

function configSlug(value) {
  const slug = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) {
    throw fail("A valid saved Runway Model Router config ID is required.", "RUNWAY_ROUTER_CONFIG_INVALID");
  }
  return slug;
}

/**
 * Builds a strictly non-billable Runway Model Router request.
 * dryRun is deliberately hard-coded; callers cannot turn this into generation.
 */
export function buildRunwayRouterDryRunPayload({
  configId, prompt, durationSeconds, aspectRatio, resolution, audio, seed
} = {}) {
  const input = {};
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 26000) {
    throw fail("Runway router prompt must contain 1 to 26,000 characters.");
  }
  input.promptText = prompt.trim();
  if (durationSeconds !== undefined) {
    if (!Number.isInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 30) {
      throw fail("Runway router duration must be a whole number from 2 to 30 seconds.");
    }
    input.duration = durationSeconds;
  }
  if (aspectRatio !== undefined) {
    if (!RATIOS.has(aspectRatio)) throw fail("Runway router aspect ratio is unsupported.");
    input.aspectRatio = aspectRatio;
  }
  if (resolution !== undefined) {
    if (!RESOLUTIONS.has(resolution)) throw fail("Runway router resolution is unsupported.");
    input.resolution = resolution;
  }
  if (audio !== undefined) {
    if (typeof audio !== "boolean") throw fail("Runway router audio must be a boolean.");
    input.audio = audio;
  }
  if (seed !== undefined) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      throw fail("Runway router seed must be an unsigned 32-bit integer.");
    }
    input.seed = seed;
  }
  return Object.freeze({
    configId: configSlug(configId),
    dryRun: true,
    input: Object.freeze(input)
  });
}

function normalizeDecision(payload, expectedConfigId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("Runway returned an invalid router preflight response.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  // A dry run is documented to create no task. Treat an unexpected task ID as a
  // contract violation; never poll, cancel, or otherwise act on it.
  if (typeof payload.id === "string" && payload.id.trim()) {
    throw fail("Runway returned a task ID for a dry-run request; the response was quarantined.", "RUNWAY_ROUTER_DRY_RUN_UNEXPECTED_TASK");
  }
  const routing = payload.routing;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw fail("Runway omitted the router decision.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  const credits = routing.estimatedCost?.credits;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
    throw fail("Runway omitted a valid estimated credit cost.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  if (routing.configId !== undefined && routing.configId !== expectedConfigId) {
    throw fail("Runway returned a decision for a different router configuration.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  const model = typeof routing.model === "string" ? routing.model : null;
  const provider = typeof routing.provider === "string" ? routing.provider : null;
  if (!model || !provider) {
    throw fail("Runway omitted the selected provider or model.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
  }
  return Object.freeze({
    status: "preflighted",
    dryRun: true,
    taskCreated: false,
    billed: false,
    configId: expectedConfigId,
    provider,
    model,
    estimatedCredits: credits,
    ...(routing.resolvedSettings && typeof routing.resolvedSettings === "object"
      ? { resolvedSettings: Object.freeze({ ...routing.resolvedSettings }) } : {}),
    ...(routing.resolvedInput && typeof routing.resolvedInput === "object"
      ? { resolvedInput: Object.freeze({ ...routing.resolvedInput }) } : {}),
    ...(routing.capacityFallback && typeof routing.capacityFallback === "object"
      ? { capacityFallback: Object.freeze({ ...routing.capacityFallback }) } : {})
  });
}

/**
 * Calls only POST /generate/video with dryRun:true. Remote access remains
 * disabled unless both explicit server-side opt-ins and a key are configured.
 */
export function createRunwayRouterDryRunClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  async function preflight(input) {
    if (env.RUNWAY_ROUTER_PREFLIGHT_ENABLED !== "true") {
      throw fail("Runway Model Router preflight is disabled by server configuration.", "RUNWAY_ROUTER_PREFLIGHT_DISABLED");
    }
    if (env.RUNWAY_VIDEO_ALLOW_REMOTE !== "true") {
      throw fail("Runway remote access requires explicit server-side opt-in.", "RUNWAY_REMOTE_DISABLED");
    }
    const key = String(env.RUNWAY_API_KEY || "").trim();
    if (!key) throw fail("Configure the Runway API key on the server.", "RUNWAY_CONFIG_INVALID");

    const payload = buildRunwayRouterDryRunPayload(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(120000, timeoutMs)));
    try {
      let response;
      try {
        response = await fetchImpl(API_BASE + "/generate/video", {
          method: "POST",
          headers: {
            authorization: "Bearer " + key,
            "X-Runway-Version": API_VERSION,
            "content-type": "application/json"
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Runway router preflight timed out." : "Runway router preflight could not reach the API.",
          error?.name === "AbortError" ? "RUNWAY_TIMEOUT" : "RUNWAY_UNAVAILABLE");
      }
      if (response.status === 429) throw fail("Runway rate limit reached.", "RUNWAY_RATE_LIMITED");
      if (response.status >= 500) throw fail("Runway returned a temporary server error.", "RUNWAY_SERVER_ERROR");
      if (!response.ok) throw fail("Runway rejected the router preflight (" + response.status + ").", "RUNWAY_REQUEST_REJECTED");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("Runway router response exceeded the 1 MB limit.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE");
      let result;
      try { result = JSON.parse(raw); }
      catch { throw fail("Runway returned invalid router JSON.", "RUNWAY_ROUTER_PREFLIGHT_INVALID_RESPONSE"); }
      return normalizeDecision(result, payload.configId);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ provider: "runway", mode: "dry_run_only", preflight });
}
