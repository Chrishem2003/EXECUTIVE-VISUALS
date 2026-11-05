const API_ORIGIN = "https://api.kie.ai";
const TASK_ID = /^[A-Za-z0-9_-]{6,200}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

function safeOutputUrl(value) {
  if (typeof value !== "string" || value.length > 4096) throw fail("Kie returned an invalid output URL.", "KIE_OUTPUT_URL_REJECTED");
  let url;
  try { url = new URL(value); } catch { throw fail("Kie returned an invalid output URL.", "KIE_OUTPUT_URL_REJECTED"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || url.href.length > 4096) {
    throw fail("Kie output must be a credential-free public HTTPS URL.", "KIE_OUTPUT_URL_REJECTED");
  }
  return url.toString();
}
function parseResultUrls(value) {
  let result = value;
  if (typeof result === "string") {
    try { result = JSON.parse(result); }
    catch { throw fail("Kie returned invalid result JSON.", "KIE_RESPONSE_INVALID"); }
  }
  if (!plain(result) || !Array.isArray(result.resultUrls) || result.resultUrls.length < 1 || result.resultUrls.length > 10) {
    throw fail("Kie completed without a bounded result URL collection.", "VIDEO_OUTPUT_COLLECTION_INVALID");
  }
  const urls = result.resultUrls.map(safeOutputUrl);
  if (new Set(urls).size !== urls.length) throw fail("Kie returned duplicate output URLs.", "KIE_OUTPUT_URL_REJECTED");
  return urls;
}

export function createKieSeedanceClient({
  apiKey = process.env.KIE_API_KEY,
  model = process.env.KIE_SEEDANCE_MODEL || "bytedance/seedance-2",
  fetchImpl = globalThis.fetch,
  baseUrl = API_ORIGIN,
  timeoutMs = 30000
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096) {
    throw fail("KIE_API_KEY is required on the server.", "KIE_CONFIGURATION_MISSING");
  }
  if (typeof fetchImpl !== "function") throw fail("Kie Seedance client requires fetch.");
  if (!["bytedance/seedance-2", "bytedance/seedance-2-5"].includes(model)) {
    throw fail("Kie Seedance client requires an exact supported model ID.", "KIE_MODEL_UNSUPPORTED");
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw fail("Kie API base URL is invalid."); }
  if (base.protocol !== "https:" || base.hostname !== "api.kie.ai" || base.port || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) throw fail("Kie API base URL must be https://api.kie.ai.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail("Kie timeout must be between 1 and 120 seconds.");

  async function request(path, { method = "GET", body = null, submission = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(API_ORIGIN + path, {
          method,
          headers: {
            authorization: "Bearer " + apiKey,
            accept: "application/json",
            ...(body === null ? {} : { "content-type": "application/json" })
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        if (submission) throw fail(
          error?.name === "AbortError" ? "Kie task creation timed out; the paid submission outcome is unknown." : "Kie submission outcome is unknown; reconcile before retrying.",
          "KIE_SUBMISSION_UNKNOWN"
        );
        throw fail(error?.name === "AbortError" ? "Kie task query timed out." : "Kie API is temporarily unavailable.",
          error?.name === "AbortError" ? "KIE_TIMEOUT" : "KIE_UNAVAILABLE");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1024 * 1024) throw fail("Kie response exceeded the 1 MB limit.", "KIE_RESPONSE_INVALID");
      let payload;
      try { payload = raw ? JSON.parse(raw) : {}; }
      catch { throw fail("Kie returned invalid JSON.", "KIE_RESPONSE_INVALID"); }
      if (!plain(payload)) throw fail("Kie returned an invalid response object.", "KIE_RESPONSE_INVALID");
      if (response.status === 429 || payload.code === 429) throw fail("Kie account rate limit reached.", "KIE_RATE_LIMITED");
      if (response.status === 401 || response.status === 403 || payload.code === 401) throw fail("Kie API key is not authorized.", "KIE_ACCESS_DENIED");
      if (payload.code === 402) throw fail("Kie account has insufficient credits; no task was accepted.", "KIE_CREDITS_INSUFFICIENT");
      if (!response.ok || (payload.code !== undefined && payload.code !== 200)) {
        const code = payload.code === 422 ? "KIE_REQUEST_REJECTED" : response.status >= 500 ? "KIE_SERVER_ERROR" : "KIE_REQUEST_REJECTED";
        const error = fail("Kie rejected the request (HTTP " + response.status + ", code " + String(payload.code ?? "unknown") + ").", code);
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    model,
    minimumPollIntervalMs: 5000,
    async submit(input) {
      const payload = await request("/api/v1/jobs/createTask", {
        method: "POST", submission: true, body: { model, input }
      });
      const taskId = payload.data?.taskId;
      if (payload.code !== 200 || typeof taskId !== "string" || !TASK_ID.test(taskId)) {
        throw fail("Kie did not return a valid durable task ID.", "KIE_SUBMISSION_RESPONSE_INVALID");
      }
      return { taskId, status: "queued" };
    },
    async getStatus(taskId) {
      if (typeof taskId !== "string" || !TASK_ID.test(taskId)) throw fail("Kie task ID is invalid.", "KIE_TASK_ID_INVALID");
      const payload = await request("/api/v1/jobs/recordInfo?taskId=" + encodeURIComponent(taskId));
      const data = payload.data;
      if (payload.code !== 200 || !plain(data) || data.taskId !== taskId || typeof data.state !== "string") {
        throw fail("Kie task status did not match the persisted task ID.", "KIE_RESPONSE_INVALID");
      }
      const creditsConsumed = Number(data.creditsConsumed);
      const usage = Number.isFinite(creditsConsumed) && creditsConsumed >= 0
        ? { creditsConsumed, costTimeSeconds: Number.isFinite(Number(data.costTime)) ? Number(data.costTime) : null }
        : null;
      if (["waiting", "wait", "queuing", "queueing"].includes(data.state)) return { taskId, status: "queued", usage };
      if (["generating", "running"].includes(data.state)) return { taskId, status: "running", usage };
      if (data.state === "fail" || data.state === "failed") {
        return { taskId, status: "failed", failure: String(data.failMsg || "Kie video task failed.").slice(0, 500), failureCode: "KIE_TASK_FAILED", usage };
      }
      if (data.state !== "success" && data.state !== "succeeded") throw fail("Kie returned an unsupported task state.", "KIE_RESPONSE_INVALID");
      const outputUrls = parseResultUrls(data.resultJson);
      return {
        taskId, status: "succeeded", outputUrls, usage,
        creditsConsumed: usage?.creditsConsumed ?? null,
        provider: "kie", model
      };
    }
  });
}
