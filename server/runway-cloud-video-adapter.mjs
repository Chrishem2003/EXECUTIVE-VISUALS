const API_ORIGIN = "https://api.dev.runwayml.com";
const API_VERSION = "2024-11-06";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATIOS = Object.freeze({
  "16:9": "1280:720",
  "9:16": "720:1280",
  "1:1": "960:960",
  "4:3": "1104:832",
  "3:4": "832:1104",
  "21:9": "1584:672"
});
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Runway Gen-4.5 text-to-video adapter for the shared durable worker.
 *
 * Actual billed credits are deliberately not inferred from estimatedCost or
 * the model pricing table. A task-level authoritative billing resolver must
 * be injected before this adapter can be registered.
 */
export function createRunwayCloudVideoAdapter({
  model = process.env.RUNWAY_VIDEO_MODEL || "gen4.5",
  apiKey = process.env.RUNWAY_API_KEY || process.env.RUNWAYML_API_SECRET,
  enabled = process.env.VIDEO_GATEWAY_ENABLED === "true",
  allowRemote = process.env.RUNWAY_VIDEO_ALLOW_REMOTE === "true",
  fetchImpl = globalThis.fetch,
  prepareInput,
  ingestOutputs,
  resolveActualCost,
  timeoutMs = 30000
} = {}) {
  const selectedModel = String(model || "").trim();
  if (selectedModel !== "gen4.5") {
    throw fail("This Runway cloud adapter currently supports only the verified gen4.5 text-to-video contract.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
  }
  const key = String(apiKey || "").trim();
  if (typeof fetchImpl !== "function") throw new Error("Runway cloud adapter requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Runway timeout is invalid.");
  if (typeof ingestOutputs !== "function" || typeof resolveActualCost !== "function") {
    throw fail("Runway cloud adapter requires private output ingestion and an authoritative task-level billing resolver.", "RUNWAY_EXECUTION_GATES_MISSING");
  }

  const assertEnabled = () => {
    if (enabled !== true) throw fail("Video generation is disabled by server configuration.", "VIDEO_GATEWAY_DISABLED");
    if (allowRemote !== true) throw fail("Runway remote video execution is disabled.", "RUNWAY_REMOTE_DISABLED");
    if (!key) throw fail("Configure the Runway API key on the server.", "RUNWAY_CONFIG_INVALID");
  };

  async function request(path, { method = "GET", body = null, submission = false } = {}) {
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
            ...(body === null ? {} : { "content-type": "application/json" })
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        if (submission) {
          throw fail(
            error?.name === "AbortError" ? "Runway submission timed out; task creation is unknown and must be reconciled." : "Runway submission outcome is unknown; reconcile before retrying.",
            "RUNWAY_SUBMISSION_UNKNOWN"
          );
        }
        throw fail(
          error?.name === "AbortError" ? "Runway task request timed out." : "Runway API is temporarily unavailable.",
          error?.name === "AbortError" ? "RUNWAY_TIMEOUT" : "RUNWAY_UNAVAILABLE"
        );
      }
      if (response.status === 429) throw fail("Runway rate limit reached.", "RUNWAY_RATE_LIMITED");
      if (response.status === 401 || response.status === 403) throw fail("Runway API key is not authorized.", "RUNWAY_ACCESS_DENIED");
      if (response.status >= 500) throw fail("Runway returned a temporary server error.", "RUNWAY_SERVER_ERROR");
      if (!response.ok) throw fail("Runway rejected the task request (HTTP " + response.status + ").", "RUNWAY_REQUEST_REJECTED");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("Runway response exceeded the 1 MB limit.", "RUNWAY_INVALID_RESPONSE");
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { throw fail("Runway returned invalid JSON.", "RUNWAY_INVALID_RESPONSE"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("Runway returned an invalid response object.", "RUNWAY_INVALID_RESPONSE");
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function taskId(value) {
    const id = String(value || "");
    if (!UUID.test(id)) throw fail("Runway task ID is invalid.", "RUNWAY_TASK_ID_INVALID");
    return id;
  }

  return Object.freeze({
    provider: "runway",
    model: selectedModel,
    minimumPollIntervalMs: 5000,

    async prepareInput(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          input.provider !== "runway" || input.model !== selectedModel) {
        throw fail("Runway job identity does not match the selected adapter.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      const hasReferences = (Array.isArray(input.referenceAssetIds) && input.referenceAssetIds.length > 0) ||
        Boolean(input.referenceImageDataUrl);
      if (hasReferences && typeof prepareInput !== "function") {
        throw fail("Runway reference assets require an authenticated project-scoped input resolver.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      if (typeof prepareInput !== "function") return input;
      const prepared = await prepareInput(input, context);
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
        throw fail("Runway private input preparation returned an invalid payload.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
      }
      return prepared;
    },

    async submit(input) {
      assertEnabled();
      if (!input || input.provider !== "runway" || input.model !== selectedModel ||
          typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 1000) {
        throw fail("Runway Gen-4.5 requires an exact model identity and a prompt of 1 to 1,000 characters.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      const ratio = RATIOS[input.aspectRatio || "16:9"];
      if (!ratio) throw fail("Runway aspect ratio is not supported by the Gen-4.5 text-to-video contract.", "RUNWAY_INPUT_INVALID");
      const duration = input.durationSeconds === undefined ? 5 : input.durationSeconds;
      if (![5, 10].includes(duration)) throw fail("Runway Gen-4.5 duration must be 5 or 10 seconds.", "RUNWAY_INPUT_INVALID");
      if (input.referenceAssetIds?.length || input.referenceImageDataUrl) {
        throw fail("Runway text-to-video does not accept unresolved reference media.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      const submitted = await request("/text_to_video", {
        method: "POST",
        submission: true,
        body: {
          model: selectedModel,
          promptText: input.prompt.trim(),
          ratio,
          duration,
          ...(typeof input.audio === "boolean" ? { audio: input.audio } : {})
        }
      });
      return { taskId: taskId(submitted.id), status: "queued" };
    },

    async getStatus(providerTaskId) {
      assertEnabled();
      const id = taskId(providerTaskId);
      const task = await request("/tasks/" + id);
      if (task.id !== id || typeof task.status !== "string") {
        throw fail("Runway task status response does not match the persisted task.", "RUNWAY_INVALID_RESPONSE");
      }
      if (task.status === "PENDING" || task.status === "THROTTLED") return { status: "queued" };
      if (task.status === "RUNNING") return { status: "running" };
      if (task.status === "FAILED") {
        return { status: "failed", failure: "Runway task failed.", failureCode: "RUNWAY_TASK_FAILED" };
      }
      if (task.status === "CANCELED" || task.status === "CANCELLED") return { status: "canceled", failure: "Runway task was canceled.", failureCode: "RUNWAY_TASK_CANCELED" };
      if (task.status !== "SUCCEEDED") throw fail("Runway returned an unsupported task state.", "RUNWAY_INVALID_RESPONSE");
      if (!Array.isArray(task.output) || task.output.length < 1 || task.output.length > 10) {
        throw fail("Runway completed without a bounded output URL collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
      }
      const outputUrls = [...new Set(task.output)];
      if (outputUrls.length !== task.output.length || outputUrls.some(raw => {
        try {
          const url = new URL(raw);
          return url.protocol !== "https:" || url.username || url.password || url.port || url.hash;
        } catch { return true; }
      })) {
        throw fail("Runway returned an unsafe or duplicate output URL.", "VIDEO_OUTPUT_URL_REJECTED");
      }
      return { status: "succeeded", taskId: id, outputUrls, provider: "runway", model: selectedModel };
    },

    async cancel(providerTaskId) {
      assertEnabled();
      return request("/tasks/" + taskId(providerTaskId), { method: "DELETE" });
    },

    async ingestOutputs(args) {
      return ingestOutputs({ ...args, provider: "runway", model: selectedModel });
    },

    async resolveActualCost(args) {
      return resolveActualCost({ ...args, provider: "runway", model: selectedModel });
    }
  });
}
