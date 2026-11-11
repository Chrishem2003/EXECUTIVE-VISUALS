import { buildFalVideoPayload } from "./fal-video-gateway.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const QUEUE_ORIGIN = "https://queue.fal.run";
const fail = (message, code) => Object.assign(new Error(message), { code });

function normalizeModel(value) {
  const model = String(value || "").trim();
  if (!model || model.length > 240 || !/^[a-zA-Z0-9_./:-]+$/.test(model) || model.startsWith("/") || model.includes("..") || model.split("/").length < 2 || model.split("/").some(part => !part || part === ".")) {
    throw fail("Configure a valid FAL video model identifier.", "VIDEO_GATEWAY_CONFIG_INVALID");
  }
  return model;
}

function modelEndpoint(model) {
  return QUEUE_ORIGIN + "/" + model.split("/").map(encodeURIComponent).join("/");
}

function trustedQueueUrl(raw, expectedPath) {
  let url;
  try { url = new URL(raw); }
  catch { throw fail("FAL returned an invalid queue task URL.", "VIDEO_GATEWAY_INVALID_RESPONSE"); }
  if (url.origin !== QUEUE_ORIGIN || url.username || url.password || url.port || url.search || url.hash || url.pathname !== expectedPath) {
    throw fail("FAL returned an unexpected or unsafe queue task URL.", "VIDEO_GATEWAY_INVALID_RESPONSE");
  }
  return url.toString();
}

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw fail("A persisted FAL task descriptor is required.", "VIDEO_GATEWAY_TASK_INVALID");
  }
  const model = normalizeModel(task.model);
  const requestId = String(task.requestId || "");
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) {
    throw fail("The persisted FAL request ID is invalid.", "VIDEO_GATEWAY_TASK_INVALID");
  }
  const root = "/" + model.split("/").slice(0, 2).join("/") + "/requests/" + requestId;
  return Object.freeze({
    provider: "fal",
    model,
    requestId,
    statusUrl: trustedQueueUrl(task.statusUrl, root + "/status"),
    resultUrl: trustedQueueUrl(task.resultUrl, root),
    cancelUrl: trustedQueueUrl(task.cancelUrl, root + "/cancel")
  });
}

export function createFalAsyncVideoClient({
  apiKey = process.env.FAL_KEY,
  model = process.env.FAL_VIDEO_MODEL,
  enabled = process.env.VIDEO_GATEWAY_ENABLED === "true",
  allowRemote = process.env.VIDEO_GATEWAY_ALLOW_REMOTE === "true",
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000
} = {}) {
  const key = String(apiKey || "").trim();
  const selectedModel = normalizeModel(model);
  if (typeof fetchImpl !== "function") throw new Error("FAL async video adapter requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("FAL async video timeout is outside the supported range.");

  async function request(url, { method = "GET", body = null, submission = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            authorization: "Key " + key,
            ...(body === null ? {} : { "content-type": "application/json" }),
            ...(submission ? { "X-Fal-No-Retry": "true" } : {})
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        throw fail(
          error?.name === "AbortError" ? "FAL request timed out." : "FAL could not be reached.",
          error?.name === "AbortError" ? "VIDEO_GATEWAY_TIMEOUT" : "VIDEO_GATEWAY_UNAVAILABLE"
        );
      }
      if (response.status === 429) throw fail("FAL rate limit reached.", "VIDEO_GATEWAY_RATE_LIMITED");
      if (!response.ok) {
        const status = response.status;
        throw fail("FAL rejected the request (HTTP " + status + ").", status >= 500 ? "VIDEO_GATEWAY_SERVER_ERROR" : "VIDEO_GATEWAY_REQUEST_REJECTED");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw fail("FAL returned an oversized response.", "VIDEO_GATEWAY_INVALID_RESPONSE");
      try { return raw ? JSON.parse(raw) : {}; }
      catch { throw fail("FAL returned invalid JSON.", "VIDEO_GATEWAY_INVALID_RESPONSE"); }
    } finally {
      clearTimeout(timer);
    }
  }

  function assertEnabled() {
    if (!enabled) throw fail("Video generation is disabled by server configuration.", "VIDEO_GATEWAY_DISABLED");
    if (!allowRemote) throw fail("Remote video providers are disabled. Verify pricing and explicitly enable remote access on the server.", "VIDEO_GATEWAY_REMOTE_DISABLED");
    if (!key) throw fail("Configure the FAL API key on the server.", "VIDEO_GATEWAY_CONFIG_INVALID");
  }

  return Object.freeze({
    /**
     * Submit once and return the durable task descriptor immediately.
     * An ambiguous transport/server failure is never retried: the provider may
     * have accepted the request before the response was lost.
     */
    async submit({ prompt, duration = 5, aspectRatio = "16:9", referenceImageDataUrl = "" } = {}) {
      assertEnabled();
      const payload = buildFalVideoPayload({ prompt, duration, aspectRatio, referenceImageDataUrl });
      let submitted;
      try {
        submitted = await request(modelEndpoint(selectedModel), {
          method: "POST",
          body: payload,
          submission: true
        });
      } catch (error) {
        if (["VIDEO_GATEWAY_TIMEOUT", "VIDEO_GATEWAY_UNAVAILABLE", "VIDEO_GATEWAY_SERVER_ERROR"].includes(error?.code)) {
          throw fail(
            "FAL submission outcome is unknown. Reconcile the provider request before attempting another submission.",
            "VIDEO_GATEWAY_SUBMISSION_UNKNOWN"
          );
        }
        throw error;
      }
      if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
        throw fail("FAL returned an invalid submission response.", "VIDEO_GATEWAY_INVALID_RESPONSE");
      }
      const requestId = String(submitted.request_id || "");
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) {
        throw fail("FAL did not return a valid request identifier.", "VIDEO_GATEWAY_INVALID_RESPONSE");
      }
      const root = "/" + selectedModel.split("/").slice(0, 2).join("/") + "/requests/" + requestId;
      return validateTask({
        model: selectedModel,
        requestId,
        statusUrl: submitted.status_url || QUEUE_ORIGIN + root + "/status",
        resultUrl: submitted.response_url || QUEUE_ORIGIN + root,
        cancelUrl: submitted.cancel_url || QUEUE_ORIGIN + root + "/cancel"
      });
    },

    /** One bounded status request; callers schedule the next poll durably. */
    async status(task) {
      assertEnabled();
      const descriptor = validateTask(task);
      const data = await request(descriptor.statusUrl);
      if (!data || typeof data !== "object" || Array.isArray(data) || !["IN_QUEUE", "IN_PROGRESS", "COMPLETED"].includes(data.status)) {
        throw fail("FAL returned an unknown task state.", "VIDEO_GATEWAY_INVALID_RESPONSE");
      }
      return Object.freeze({
        ...descriptor,
        status: data.status,
        ...(Number.isInteger(data.queue_position) && data.queue_position >= 0 ? { queuePosition: data.queue_position } : {}),
        ...(typeof data.error === "string" ? { error: data.error.slice(0, 1000) } : {}),
        ...(typeof data.error_type === "string" ? { errorType: data.error_type.slice(0, 120) } : {})
      });
    },

    /** Fetch the provider result only after the durable worker observes COMPLETED. */
    async result(task) {
      assertEnabled();
      const descriptor = validateTask(task);
      const data = await request(descriptor.resultUrl);
      if (data && typeof data.detail === "string" && /still in progress|not completed|not ready/i.test(data.detail)) {
        throw fail("FAL video result is not ready yet; retain the task and poll status again.", "VIDEO_GATEWAY_RESULT_NOT_READY");
      }
      if (data && (data.error || data.error_type || data.detail)) {
        throw fail("FAL video task did not produce a successful result.", "VIDEO_GATEWAY_JOB_FAILED");
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw fail("FAL returned an invalid video result.", "VIDEO_GATEWAY_INVALID_RESPONSE");
      }
      return data;
    },

    /** Cancellation is best-effort; callers must still reconcile final status. */
    async cancel(task) {
      assertEnabled();
      const descriptor = validateTask(task);
      return request(descriptor.cancelUrl, { method: "PUT" });
    }
  });
}
