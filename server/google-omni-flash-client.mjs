import { normalizeGeminiOmniFlashInteractionResponse } from "./google-omni-flash-interaction.mjs";

const ORIGIN = "https://generativelanguage.googleapis.com";
const BASE = ORIGIN + "/v1beta";
const MODEL = "gemini-omni-1.1-flash";
const ID = /^v1_[A-Za-z0-9_-]{6,200}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

function interactionId(value) {
  if (typeof value !== "string" || !ID.test(value)) {
    throw fail("Gemini interaction ID is invalid.", "GEMINI_OMNI_INVALID_INTERACTION_ID");
  }
  return value;
}

function safePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) ||
      plan.endpoint !== BASE + "/interactions" || plan.method !== "POST" ||
      plan.auth?.headerName !== "x-goog-api-key" ||
      plan.auth?.credentialSource !== "server-only" ||
      plan.policy?.provider !== "google" || plan.policy?.model !== MODEL ||
      plan.policy?.requiresApproval !== true ||
      !plan.payload || plan.payload.model !== MODEL ||
      plan.payload.response_format?.type !== "video" ||
      plan.payload.response_format?.delivery !== "uri") {
    throw fail("Gemini interaction plan is not a supported, approval-gated URI-delivery plan.", "GEMINI_OMNI_PLAN_INVALID");
  }
  return plan.payload;
}

/**
 * Server-only Interactions API transport. It deliberately never retries
 * interaction creation: an ambiguous POST is returned as reconciliation work.
 * Callers must supply durable approval and owner/project authorization gates.
 */
export function createGeminiOmniFlashClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  assertApprovedSubmission,
  authorizeInteraction,
  timeoutMs = 30000,
  maxResponseBytes = 4 * 1024 * 1024
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Gemini Interactions client requires fetch.");
  if (typeof assertApprovedSubmission !== "function") {
    throw new TypeError("Gemini Interactions client requires a durable approval validator.");
  }
  if (typeof authorizeInteraction !== "function") {
    throw new TypeError("Gemini Interactions client requires an owner/project interaction authorizer.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new Error("Gemini Interactions client limits are invalid.");
  }

  function configuration() {
    if (env.GEMINI_OMNI_ENABLED !== "true" || env.GEMINI_OMNI_ALLOW_REMOTE !== "true") {
      throw fail("Gemini Omni remote execution is disabled by server policy.", "GEMINI_OMNI_REMOTE_DISABLED");
    }
    const key = String(env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY || "").trim();
    if (!key) throw fail("Configure the Gemini API key on the server.", "GEMINI_OMNI_CONFIG_MISSING");
    return key;
  }

  async function request(url, { method = "GET", body, ambiguousPost = false } = {}) {
    const key = configuration();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            "x-goog-api-key": key,
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        if (ambiguousPost) {
          throw fail("Gemini interaction submission outcome is unknown; reconcile before any retry.",
            "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
        }
        throw fail(error?.name === "AbortError" ? "Gemini Interactions request timed out." : "Gemini Interactions request failed.",
          error?.name === "AbortError" ? "GEMINI_OMNI_REQUEST_TIMEOUT" : "GEMINI_OMNI_REQUEST_FAILED");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > maxResponseBytes) {
        throw fail("Gemini Interactions response exceeded its configured size limit.", "GEMINI_OMNI_RESPONSE_TOO_LARGE");
      }
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch {
          if (ambiguousPost) throw fail("Gemini accepted or may have accepted the request but returned an unreadable response; reconcile before retry.",
            "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
          throw fail("Gemini Interactions returned invalid JSON.", "GEMINI_OMNI_INVALID_RESPONSE");
        }
      }
      if (!response.ok) {
        if (ambiguousPost && response.status >= 500) {
          throw fail("Gemini interaction submission returned a server error; reconcile before retry.",
            "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
        }
        const code = response.status === 429 ? "GEMINI_OMNI_RATE_LIMITED" : "GEMINI_OMNI_REQUEST_REJECTED";
        throw fail("Gemini Interactions rejected the request (HTTP " + response.status + ").", code);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function authorize(id, context, action) {
    let allowed = false;
    try { allowed = await authorizeInteraction({ interactionId: id, context, action }); }
    catch {}
    if (allowed !== true) throw fail("Gemini interaction is not authorized for this owner and project.", "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  }

  function normalized(data) {
    return normalizeGeminiOmniFlashInteractionResponse(data);
  }

  return Object.freeze({
    provider: "google",
    model: MODEL,
    minimumPollIntervalMs: 5000,

    async createInteraction(plan, context = {}) {
      const payload = safePlan(plan);
      let approved = false;
      try { approved = await assertApprovedSubmission({ plan, context }); }
      catch {}
      if (approved !== true) throw fail("A durable approval and budget reservation are required before Gemini submission.",
        "GEMINI_OMNI_APPROVAL_REQUIRED");
      const requestPayload = { ...payload, background: true, store: true };
      const data = await request(BASE + "/interactions", {
        method: "POST", body: requestPayload, ambiguousPost: true
      });
      const result = normalized(data);
      return Object.freeze({
        taskId: result.interactionId,
        interactionId: result.interactionId,
        status: result.status,
        provider: "google",
        model: MODEL,
        outputUrls: Object.freeze(result.video?.delivery === "uri" ? [result.video.uri] : [])
      });
    },

    async getInteraction(id, context = {}) {
      const safeId = interactionId(id);
      await authorize(safeId, context, "read");
      const data = await request(BASE + "/interactions/" + encodeURIComponent(safeId));
      const result = normalized(data);
      return Object.freeze({
        taskId: result.interactionId,
        interactionId: result.interactionId,
        status: result.status,
        provider: "google",
        model: MODEL,
        outputUrls: Object.freeze(result.video?.delivery === "uri" ? [result.video.uri] : [])
      });
    },

    async cancelInteraction(id, context = {}) {
      const safeId = interactionId(id);
      await authorize(safeId, context, "cancel");
      const data = await request(BASE + "/interactions/" + encodeURIComponent(safeId) + "/cancel", { method: "POST" });
      const result = normalized(data);
      return Object.freeze({ interactionId: result.interactionId, status: result.status, cancelRequested: true });
    },

    async deleteInteraction(id, context = {}) {
      const safeId = interactionId(id);
      await authorize(safeId, context, "delete");
      await request(BASE + "/interactions/" + encodeURIComponent(safeId), { method: "DELETE" });
      return Object.freeze({ interactionId: safeId, deleted: true });
    }
  });
}
