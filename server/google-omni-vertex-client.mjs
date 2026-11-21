import { GoogleAuth } from "google-auth-library";

const ORIGIN = "https://aiplatform.googleapis.com";
const MODEL = "gemini-omni-1.2-flash";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

async function readBoundedResponseText(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw fail("Google Vertex Interactions response exceeded its size limit.", "GOOGLE_VERTEX_RESPONSE_TOO_LARGE");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) {
      throw fail("Google Vertex Interactions response exceeded its size limit.", "GOOGLE_VERTEX_RESPONSE_TOO_LARGE");
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw fail("Google Vertex Interactions response exceeded its size limit.", "GOOGLE_VERTEX_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
function normalizeProjectId(value) {
  const valueText = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(valueText)) {
    throw new TypeError("Google Vertex video worker requires a valid Google Cloud project ID.");
  }
  return valueText;
}
function normalizeBucketName(value) {
  const valueText = String(value || "").trim();
  if (valueText.length < 3 || valueText.length > 222 ||
      !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(valueText) ||
      valueText.includes("..") || valueText.includes(".-") || valueText.includes("-.")) {
    throw new TypeError("Google Vertex video worker requires a valid dedicated GCS output bucket.");
  }
  return valueText;
}
function interactionId(value) {
  if (typeof value !== "string" || !/^v1_[A-Za-z0-9_-]{6,200}$/.test(value)) {
    throw fail("Google Vertex returned an invalid interaction ID.", "GOOGLE_VERTEX_INTERACTION_INVALID");
  }
  return value;
}
function parseInteraction(raw, expectedId, expectedModel) {
  let value;
  try { value = JSON.parse(raw); } catch {
    throw fail("Google Vertex returned invalid interaction JSON.", "GOOGLE_VERTEX_RESPONSE_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (expectedId && value.id !== expectedId) || value.model !== expectedModel ||
      !["queued", "in_progress", "requires_action", "running", "completed", "failed", "cancelled", "canceled", "incomplete"].includes(value.status)) {
    throw fail("Google Vertex interaction response did not match the expected job and model.", "GOOGLE_VERTEX_RESPONSE_INVALID");
  }
  interactionId(value.id);
  return value;
}

/**
 * Server-only Gemini Omni 1.2 transport for Vertex AI Interactions API.
 * Uses Application Default Credentials (or an injected Google auth client),
 * never an API key. Remote execution remains disabled until the caller's
 * approval, budget, lease, and private-output ingestion gates authorize it.
 */
export function createGoogleOmniVertexClient({
  projectId: projectInput = process.env.GOOGLE_CLOUD_PROJECT,
  outputBucket: bucketInput = process.env.GOOGLE_OMNI_OUTPUT_BUCKET,
  outputPrefix = process.env.GOOGLE_OMNI_OUTPUT_PREFIX || "executive-visuals/omni-12",
  authClient = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000,
  maxResponseBytes = 2 * 1024 * 1024,
  now = () => Date.now()
} = {}) {
  const project = normalizeProjectId(projectInput);
  const bucket = normalizeBucketName(bucketInput);
  const prefix = String(outputPrefix || "").replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9/_-]{1,180}$/.test(prefix) || prefix.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("Google Vertex output prefix is invalid.");
  }
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 8 * 1024 * 1024) {
    throw new TypeError("Google Vertex client transport limits are invalid.");
  }
  const auth = authClient || new GoogleAuth({ scopes: [SCOPE] });
  let cachedClient = null;

  async function accessToken() {
    if (!cachedClient) cachedClient = typeof auth.getClient === "function" ? await auth.getClient() : auth;
    if (typeof cachedClient.getAccessToken !== "function") {
      throw fail("Google Vertex worker has no OAuth access-token provider.", "GOOGLE_VERTEX_AUTH_UNAVAILABLE");
    }
    const result = await cachedClient.getAccessToken();
    const token = typeof result === "string" ? result : result?.token;
    if (typeof token !== "string" || token.length < 20 || token.length > 8192 || /\s/.test(token)) {
      throw fail("Google Vertex worker could not obtain a valid OAuth access token.", "GOOGLE_VERTEX_AUTH_UNAVAILABLE");
    }
    return token;
  }

  function outputUri(context) {
    if (!UUID.test(String(context?.jobId || "")) || !HASH.test(String(context?.requestHash || ""))) {
      throw fail("Google Vertex output location requires a valid job and request hash.", "GOOGLE_VERTEX_CONTEXT_INVALID");
    }
    return "gs://" + bucket + "/" + prefix + "/" + context.jobId + "/" + context.requestHash + "/";
  }

  async function request(url, { method = "GET", body, signal } = {}) {
    const token = await accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          authorization: "Bearer " + token,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: "error"
      });
      const raw = await readBoundedResponseText(response, maxResponseBytes);
      if (!response.ok) {
        const error = fail("Google Vertex Interactions request failed with HTTP " + response.status + ".", "GOOGLE_VERTEX_REQUEST_FAILED");
        error.status = response.status;
        throw error;
      }
      return raw;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("Google Vertex Interactions request timed out.", "GOOGLE_VERTEX_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  const base = ORIGIN + "/v1beta1/projects/" + encodeURIComponent(project) + "/locations/global/interactions";

  async function createInteraction(plan, context, { onInteractionCreated, signal } = {}) {
    if (plan?.policy?.provider !== "google" || plan?.policy?.model !== MODEL ||
        plan?.policy?.requiresApproval !== true || plan?.payload?.model !== MODEL ||
        !UUID.test(String(context?.jobId || "")) || !UUID.test(String(context?.ownerId || "")) ||
        !HASH.test(String(context?.requestHash || "")) ||
        typeof onInteractionCreated !== "function") {
      throw fail("Google Omni 1.2 submission requires an approved, scoped worker plan.", "GOOGLE_VERTEX_PLAN_INVALID");
    }
    const gcsUri = outputUri(context);
    const videoTask = plan.payload.generation_config?.video_config?.task;
    if (typeof videoTask !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(videoTask)) {
      throw fail("Google Omni 1.2 requires an explicit video task in generation_config.video_config.task.", "GOOGLE_VERTEX_PLAN_INVALID");
    }
    const configuredFormats = Array.isArray(plan.payload.response_format)
      ? plan.payload.response_format
      : plan.payload.response_format ? [plan.payload.response_format] : [];
    const videoFormats = configuredFormats.filter(item => item?.type === "video");
    if (videoFormats.length > 1) {
      throw fail("Google Omni 1.2 requests may define only one video output destination.", "GOOGLE_VERTEX_PLAN_INVALID");
    }
    const responseFormat = [
      ...configuredFormats.filter(item => item?.type !== "video"),
      {
        ...(videoFormats[0] || {}),
        type: "video",
        delivery: "uri",
        gcs_uri: gcsUri
      }
    ];
    const payload = {
      ...plan.payload,
      model: MODEL,
      store: true,
      background: true,
      response_format: responseFormat,
      // Stable, low-cardinality labels enable Cloud Billing attribution on PayGo.
      // Never include owner IDs, job IDs, prompts or other per-user data.
      labels: {
        application: "executive_visuals",
        component: "video_generation",
        provider: "google",
        model: "omni_1_2_flash"
      }
    };
    const raw = await request(base, { method: "POST", body: payload, signal });
    const interaction = parseInteraction(raw, null, MODEL);
    await onInteractionCreated({
      interactionId: interaction.id,
      status: interaction.status,
      model: MODEL,
      outputUri: gcsUri
    });
    return Object.freeze({
      interactionId: interaction.id,
      taskId: interaction.id,
      provider: "google",
      model: MODEL,
      status: interaction.status,
      outputUri: gcsUri,
      createdAt: now()
    });
  }

  async function getInteractionForIngestion(id, context = {}, { signal } = {}) {
    const safeId = interactionId(id);
    if (!UUID.test(String(context?.jobId || "")) || !UUID.test(String(context?.ownerId || ""))) {
      throw fail("Google Vertex interaction retrieval requires an authorized job context.", "GOOGLE_VERTEX_CONTEXT_INVALID");
    }
    const pollUrl = base + "/" + encodeURIComponent(safeId);
    const raw = await request(pollUrl, { signal });
    return parseInteraction(raw, safeId, MODEL);
  }

  async function cancelInteraction(id, context = {}, { signal } = {}) {
    const safeId = interactionId(id);
    if (!UUID.test(String(context?.jobId || "")) || !UUID.test(String(context?.ownerId || ""))) {
      throw fail("Google Vertex interaction cancellation requires an authorized job context.", "GOOGLE_VERTEX_CONTEXT_INVALID");
    }
    const cancelUrl = ORIGIN + "/v1/projects/" + encodeURIComponent(project) + "/locations/global/interactions/" + encodeURIComponent(safeId) + "/cancel";
    await request(cancelUrl, { method: "POST", signal });
    return Object.freeze({ interactionId: safeId, status: "cancel_requested" });
  }

  return Object.freeze({
    provider: "google",
    model: MODEL,
    endpoint: base,
    outputUri,
    createInteraction,
    getInteractionForIngestion,
    cancelInteraction
  });
}
