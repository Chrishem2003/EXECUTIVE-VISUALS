const API_ORIGIN = "https://api.dev.runwayml.com";
const API_VERSION = "2024-11-06";
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code) => Object.assign(new Error(message), { code });

function routerSlug(value) {
  const slug = String(value || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slug)) {
    throw fail("A valid saved Runway Model Router slug is required.", "RUNWAY_ROUTER_CONFIG_INVALID");
  }
  return slug;
}

function routedInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 26000) {
    throw fail("Runway Model Router requires a valid video prompt.", "RUNWAY_ROUTER_INPUT_INVALID");
  }
  const result = { promptText: input.prompt.trim() };
  if (input.negativePrompt !== undefined) {
    if (typeof input.negativePrompt !== "string" || input.negativePrompt.length > 1000) {
      throw fail("Runway negative prompt exceeds 1,000 characters.", "RUNWAY_ROUTER_INPUT_INVALID");
    }
    if (input.negativePrompt.trim()) result.negativePrompt = input.negativePrompt.trim();
  }
  if (input.durationSeconds !== undefined) {
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 2 || input.durationSeconds > 30) {
      throw fail("Runway routed duration must be between 2 and 30 seconds.", "RUNWAY_ROUTER_INPUT_INVALID");
    }
    result.duration = input.durationSeconds;
  }
  if (input.aspectRatio !== undefined) {
    if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(input.aspectRatio)) {
      throw fail("Runway routed aspect ratio is unsupported.", "RUNWAY_ROUTER_INPUT_INVALID");
    }
    result.aspectRatio = input.aspectRatio;
  }
  if (input.resolution !== undefined && input.resolution !== "provider_default") {
    if (!["480p", "720p", "1080p", "4k"].includes(input.resolution)) {
      throw fail("Runway routed resolution is unsupported.", "RUNWAY_ROUTER_INPUT_INVALID");
    }
    result.resolution = input.resolution;
  }
  if (input.audio !== undefined) {
    if (typeof input.audio !== "boolean") throw fail("Runway routed audio flag must be boolean.", "RUNWAY_ROUTER_INPUT_INVALID");
    result.audio = input.audio;
  } else if (input.audioMode === "generated") {
    result.audio = true;
  } else if (input.audioMode === "none") {
    result.audio = false;
  }
  if (input.seed !== undefined) {
    if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 4294967295) {
      throw fail("Runway routed seed is invalid.", "RUNWAY_ROUTER_INPUT_INVALID");
    }
    result.seed = input.seed;
  }
  const sourceVideos = Array.isArray(input.referenceVideos) ? input.referenceVideos.filter(item => item?.role === "source") : [];
  if (sourceVideos.length > 1 || (input.operation === "video-to-video" && sourceVideos.length !== 1) || (input.operation !== "video-to-video" && sourceVideos.length !== 0)) {
    throw fail("Runway video-to-video requires exactly one source video; other operations cannot include a source video.", "RUNWAY_ROUTER_INPUT_INVALID");
  }
  const referenceLimits = { referenceImages: 4, referenceVideos: 2, referenceAudio: 1, keyframes: 5 };
  if (input.audioMode === "reference" && (!Array.isArray(input.referenceAudio) || input.referenceAudio.length !== 1)) {
    throw fail("Reference audio mode requires exactly one resolved audio reference.", "RUNWAY_ROUTER_INPUT_INVALID");
  }
  for (const field of Object.keys(referenceLimits)) {
    if (input[field] !== undefined) {
      if (!Array.isArray(input[field]) || input[field].length > referenceLimits[field] ||
          input[field].some(item => !item || typeof item.uri !== "string" || !/^https:\/\//i.test(item.uri) && !/^runway:\/\//i.test(item.uri))) {
        throw fail("Runway routed " + field + " exceeds its documented count or URI constraints.", "RUNWAY_ROUTER_INPUT_INVALID");
      }
      if (field === "referenceImages" && input[field].some(item => !["first", "last", "reference"].includes(item.role))) {
        throw fail("Runway reference images require first, last or reference roles.", "RUNWAY_ROUTER_INPUT_INVALID");
      }
      if (field === "referenceVideos" && input[field].some(item => !["source", "reference"].includes(item.role))) {
        throw fail("Runway reference videos require source or reference roles.", "RUNWAY_ROUTER_INPUT_INVALID");
      }
      if (field === "referenceAudio" && input[field].some(item => item.role !== undefined)) {
        throw fail("Runway reference audio does not accept a role field.", "RUNWAY_ROUTER_INPUT_INVALID");
      }
      result[field] = input[field].map(item => ({ ...item }));
    }
  }
  if (input.contentModeration !== undefined) {
    if (!input.contentModeration || !["auto", "low"].includes(input.contentModeration.publicFigureThreshold)) {
      throw fail("Runway content moderation setting is invalid.", "RUNWAY_ROUTER_INPUT_INVALID");
    }
    result.contentModeration = { publicFigureThreshold: input.contentModeration.publicFigureThreshold };
  }
  return result;
}

async function cancelResponseBody(response) {
  await response?.body?.cancel().catch(() => {});
}

function boundedObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("Runway omitted " + label + ".", "RUNWAY_ROUTER_RESPONSE_INVALID");
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 6500) throw fail("Runway " + label + " exceeded the durable metadata limit.", "RUNWAY_ROUTER_RESPONSE_INVALID");
  return JSON.parse(text);
}

/**
 * Opt-in live Model Router adapter. It never runs dry-runs as paid jobs.
 * The completed task's documented cost.credits field is the authoritative
 * realized charge; estimatedCost.credits is only the pre-generation ceiling.
 */
export function createRunwayModelRouterVideoAdapter({
  configId = process.env.RUNWAY_VIDEO_ROUTER_CONFIG,
  model = "model-router",
  apiKey = process.env.RUNWAY_API_KEY || process.env.RUNWAYML_API_SECRET,
  enabled = process.env.RUNWAY_MODEL_ROUTER_ENABLED === "true",
  allowRemote = process.env.RUNWAY_VIDEO_ALLOW_REMOTE === "true",
  fetchImpl = globalThis.fetch,
  prepareInput,
  ingestOutputs,
  timeoutMs = 30000
} = {}) {
  const slug = routerSlug(configId);
  const key = String(apiKey || "").trim();
  if (typeof fetchImpl !== "function") throw new Error("Runway Model Router requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Runway Model Router timeout is invalid.");
  if (typeof ingestOutputs !== "function") {
    throw fail("Runway Model Router requires private output ingestion.", "RUNWAY_ROUTER_EXECUTION_GATES_MISSING");
  }

  const assertConfigured = () => {
    if (!key) {
      throw fail("Runway Model Router quotes require a server-side API key.", "RUNWAY_ROUTER_NOT_CONFIGURED");
    }
  };

  const assertEnabled = () => {
    assertConfigured();
    if (enabled !== true || allowRemote !== true) {
      throw fail("Runway Model Router paid submission is disabled until explicit server-side opt-ins are configured.", "RUNWAY_ROUTER_DISABLED");
    }
  };

  async function request(path, { method = "GET", body, submission = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(API_ORIGIN + "/v1" + path, {
          method,
          headers: {
            authorization: "Bearer " + key,
            "X-Runway-Version": API_VERSION,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        throw fail(
          submission
            ? "Runway routed submission outcome is unknown; reconcile before retrying."
            : "Runway task status is temporarily unavailable.",
          submission ? "RUNWAY_SUBMISSION_UNKNOWN" : "RUNWAY_UNAVAILABLE"
        );
      }
      if (response.status === 429) { await cancelResponseBody(response); throw fail("Runway rate limit reached.", "RUNWAY_RATE_LIMITED"); }
      if (response.status === 401 || response.status === 403) { await cancelResponseBody(response); throw fail("Runway API key is not authorized.", "RUNWAY_ACCESS_DENIED"); }
      if (response.status >= 500) { await cancelResponseBody(response); throw fail("Runway returned a temporary server error.", "RUNWAY_SERVER_ERROR"); }
      if (!response.ok) { await cancelResponseBody(response); throw fail("Runway rejected the routed request (HTTP " + response.status + ").", "RUNWAY_REQUEST_REJECTED"); }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("Runway response exceeded the 1 MB limit.", "RUNWAY_RESPONSE_INVALID");
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { throw fail("Runway returned invalid JSON.", "RUNWAY_RESPONSE_INVALID"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("Runway returned an invalid response object.", "RUNWAY_RESPONSE_INVALID");
      return data;
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    provider: "runway",
    model,
    minimumPollIntervalMs: 5000,
    async prepareInput(input, context) {
      if (!input || input.provider !== "runway" || input.model !== model || input.operation && !["text-to-video", "image-to-video", "video-to-video"].includes(input.operation)) {
        throw fail("Runway router job identity or operation is invalid.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      if (typeof prepareInput !== "function") {
        routedInput(input);
        return input;
      }
      const prepared = await prepareInput(input, context);
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
        throw fail("Runway router private input preparation returned an invalid object.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
      }
      const merged = { ...input, ...prepared };
      routedInput(merged);
      return merged;
    },
    async preflight(input) {
      // Dry-run quotes are explicitly non-billable and may be offered before
      // paid execution is enabled. The submit path still requires both flags.
      assertConfigured();
      const response = await request("/generate/video", {
        method: "POST",
        body: { configId: slug, dryRun: true, input: routedInput(input) }
      });
      if (typeof response.id === "string" && response.id.trim()) {
        throw fail("Runway dry-run unexpectedly returned a task ID; quote was quarantined.", "RUNWAY_ROUTER_DRY_RUN_INVALID");
      }
      const routing = boundedObject(response.routing, "dry-run routing metadata");
      const credits = routing.estimatedCost?.credits;
      if (routing.configId !== slug || typeof routing.model !== "string" || !routing.model.trim() ||
          typeof routing.provider !== "string" || !routing.provider.trim() ||
          !Number.isSafeInteger(credits) || credits <= 0) {
        throw fail("Runway dry-run omitted a valid model, route or estimated credit ceiling.", "RUNWAY_ROUTER_DRY_RUN_INVALID");
      }
      return Object.freeze({
        billable: false,
        configId: slug,
        model: routing.model,
        provider: routing.provider,
        estimatedCredits: credits,
        estimatedUsd: Math.round(credits * 0.01 * 10000) / 10000,
        currency: "USD",
        routing
      });
    },
    async submit(input) {
      assertEnabled();
      const body = { configId: slug, input: routedInput(input) };
      const response = await request("/generate/video", { method: "POST", body, submission: true });
      if (typeof response.id !== "string" || !TASK_ID.test(response.id)) {
        throw fail("Runway routed generation omitted a valid task ID; reconcile before retrying.", "RUNWAY_SUBMISSION_UNKNOWN");
      }
      const routing = boundedObject(response.routing, "routing metadata");
      if (routing.configId !== slug || typeof routing.model !== "string" || !routing.model.trim() ||
          typeof routing.provider !== "string" || !routing.provider.trim()) {
        throw fail("Runway routed generation returned mismatched routing metadata.", "RUNWAY_ROUTER_RESPONSE_INVALID");
      }
      return {
        taskId: response.id,
        status: "queued",
        metadata: {
          routeType: "runway-model-router",
          configId: slug,
          routing,
          estimatedCredits: routing.estimatedCost?.credits
        }
      };
    },
    async getStatus(providerTaskId) {
      if (typeof providerTaskId !== "string" || !TASK_ID.test(providerTaskId)) {
        throw fail("Runway task ID is invalid.", "RUNWAY_TASK_ID_INVALID");
      }
      const task = await request("/tasks/" + providerTaskId);
      if (task.id !== providerTaskId) throw fail("Runway task response ID did not match the requested task.", "RUNWAY_TASK_ID_MISMATCH");
      const status = String(task.status || "").toUpperCase();
      if (["PENDING", "THROTTLED"].includes(status)) return { status: "queued", taskId: providerTaskId };
      if (["RUNNING"].includes(status)) return { status: "running", taskId: providerTaskId };
      if (["FAILED", "CANCELED"].includes(status)) return {
        status: status === "CANCELED" ? "canceled" : "failed",
        taskId: providerTaskId,
        failure: "Runway routed video task did not complete.",
        failureCode: "RUNWAY_TASK_FAILED"
      };
      if (status !== "SUCCEEDED") throw fail("Runway returned an unsupported task state.", "VIDEO_PROVIDER_STATUS_INVALID");
      if (!Array.isArray(task.output) || task.output.length < 1 || task.output.length > 10) {
        throw fail("Runway completed without a bounded output collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
      }
      const outputUrls = task.output.map(value => {
        let parsed;
        try { parsed = new URL(value); } catch { throw fail("Runway output URL is invalid.", "VIDEO_OUTPUT_URL_REJECTED"); }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw fail("Runway output URL is unsafe.", "VIDEO_OUTPUT_URL_REJECTED");
        return parsed.toString();
      });
      return {
        status: "succeeded", taskId: providerTaskId, outputUrls,
        provider: "runway", model: "model-router",
        ...(task.cost && typeof task.cost === "object" ? { cost: task.cost } : {}),
        ...(task.estimatedCost && typeof task.estimatedCost === "object" ? { estimatedCost: task.estimatedCost } : {})
      };
    },
    async ingestOutputs(args) { return ingestOutputs(args); },
    async resolveActualCost(args) {
      const metadata = args.submissionMetadata;
      const task = args.task;
      if (!metadata || metadata.routeType !== "runway-model-router" || metadata.configId !== slug ||
          !metadata.routing || typeof metadata.routing !== "object" ||
          metadata.routing.configId !== slug || typeof metadata.routing.model !== "string" ||
          !metadata.routing.model.trim() || !task || task.status !== "succeeded" ||
          task.taskId !== args.providerTaskId) {
        throw fail("Durable Runway route and completed task evidence are required; budget remains reserved.", "VIDEO_BUDGET_COST_UNRESOLVED");
      }
      const credits = task.cost?.credits;
      const estimatedCredits = task.estimatedCost?.credits;
      if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0 ||
          typeof estimatedCredits !== "number" || !Number.isFinite(estimatedCredits) ||
          estimatedCredits < 0 || credits > estimatedCredits) {
        throw fail("Runway completed task omitted valid realized cost or exceeded its task estimate.", "VIDEO_BUDGET_COST_UNRESOLVED");
      }
      const modelUsed = metadata.routing.model;
      return {
        amount: Math.round(credits * 0.01 * 10000) / 10000,
        currency: "USD",
        model: modelUsed,
        evidenceReference: "runway:model-router:" + slug + ":" + args.providerTaskId + ":task-cost-credits:" + credits
      };
    }
  });
}
