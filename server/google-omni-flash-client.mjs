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

async function readBoundedResponseText(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw fail("Gemini Interactions response exceeded its configured size limit.",
      "GEMINI_OMNI_RESPONSE_TOO_LARGE");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) {
      throw fail("Gemini Interactions response exceeded its configured size limit.",
        "GEMINI_OMNI_RESPONSE_TOO_LARGE");
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
        throw fail("Gemini Interactions response exceeded its configured size limit.",
          "GEMINI_OMNI_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function safeExternalMediaUri(value, supabaseUrl) {
  if (typeof supabaseUrl !== "string" || !supabaseUrl.trim()) return false;
  let storage, uri;
  try { storage = new URL(supabaseUrl); uri = new URL(value); } catch { return false; }
  if (storage.protocol !== "https:" || storage.username || storage.password ||
      storage.search || storage.hash || storage.pathname !== "/" ||
      uri.protocol !== "https:" || uri.origin !== storage.origin ||
      uri.username || uri.password || uri.hash || (uri.port && uri.port !== "443")) return false;
  const prefix = "/storage/v1/object/sign/executive-visuals-media/";
  if (!uri.pathname.startsWith(prefix)) return false;
  let objectPath;
  try { objectPath = decodeURIComponent(uri.pathname.slice(prefix.length)); } catch { return false; }
  const segments = objectPath.split("/");
  if (segments.length < 3 || segments.some(part => !part || part === "." || part === ".." || part.includes("\\"))) return false;
  const params = [...uri.searchParams.entries()];
  return params.length === 1 && params[0][0] === "token" && Boolean(params[0][1]);
}

function safePlan(plan, { supabaseUrl } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) ||
      plan.endpoint !== BASE + "/interactions" || plan.method !== "POST" ||
      plan.auth?.headerName !== "x-goog-api-key" ||
      plan.auth?.credentialSource !== "server-only" ||
      plan.policy?.provider !== "google" || plan.policy?.model !== MODEL ||
      plan.policy?.requiresApproval !== true ||
      !plan.payload || plan.payload.model !== MODEL ||
      plan.payload.response_format?.type !== "video" ||
      !["16:9", "9:16"].includes(plan.payload.response_format?.aspect_ratio) ||
      !["360p", "720p", "1080p", "4k"].includes(plan.payload.response_format?.resolution) ||
      plan.payload.response_format?.delivery !== "uri") {
    throw fail("Gemini interaction plan is not a supported, approval-gated URI-delivery plan.", "GEMINI_OMNI_PLAN_INVALID");
  }
  const input = plan.payload.input;
  if (typeof input === "string") {
    if (!input.trim() || input.length > 12000) throw fail("Gemini interaction text input is invalid.", "GEMINI_OMNI_PLAN_INVALID");
  } else if (Array.isArray(input) && input.length >= 1 && input.length <= 10) {
    for (const item of input) {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          !["text", "image", "video"].includes(item.type)) {
        throw fail("Gemini interaction contains an unsupported input part.", "GEMINI_OMNI_PLAN_INVALID");
      }
      if (item.type === "text") {
        if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 12000) {
          throw fail("Gemini interaction text part is invalid.", "GEMINI_OMNI_PLAN_INVALID");
        }
      } else if (typeof item.uri !== "string" ||
          !( /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+$/.test(item.uri) || safeExternalMediaUri(item.uri, supabaseUrl) )) {
        throw fail("Gemini interaction media must reference an authorized Google Files URI.", "GEMINI_OMNI_PLAN_INVALID");
      }
    }
  } else {
    throw fail("Gemini interaction input must be text or a bounded multimodal content array.", "GEMINI_OMNI_PLAN_INVALID");
  }
  if (plan.payload.previous_interaction_id !== undefined &&
      (typeof plan.payload.previous_interaction_id !== "string" ||
       !/^v1_[A-Za-z0-9_-]{6,200}$/.test(plan.payload.previous_interaction_id))) {
    throw fail("Gemini interaction lineage reference is invalid.", "GEMINI_OMNI_PLAN_INVALID");
  }
  if (plan.payload.generation_config !== undefined) {
    const task = plan.payload.generation_config?.video_config?.task;
    if (!["edit", "extend", "image_to_video", "reference_to_video"].includes(task)) {
      throw fail("Gemini video generation task is unsupported.", "GEMINI_OMNI_PLAN_INVALID");
    }
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
  streamTimeoutMs = 120000,
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
      !Number.isInteger(streamTimeoutMs) || streamTimeoutMs < 1000 || streamTimeoutMs > 300000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new Error("Gemini Interactions client limits are invalid.");
  }

  function configuration(purpose = "lifecycle") {
    const generationEnabled = env.GEMINI_OMNI_ENABLED === "true" && env.GEMINI_OMNI_ALLOW_REMOTE === "true";
    if (purpose === "create") {
      if (!generationEnabled) {
        throw fail("Gemini Omni remote execution is disabled by server policy.", "GEMINI_OMNI_REMOTE_DISABLED");
      }
      if (env.GEMINI_OMNI_PAID_TIER_CONFIRMED !== "true") {
        throw fail("Gemini Omni video generation requires an explicitly verified paid-tier project.", "GEMINI_OMNI_PAID_TIER_REQUIRED");
      }
    } else if (!generationEnabled && env.GEMINI_OMNI_CLEANUP_ENABLED !== "true") {
      throw fail("Gemini Omni lifecycle access is disabled by server policy.", "GEMINI_OMNI_REMOTE_DISABLED");
    }
    const key = String(env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY || "").trim();
    if (!key) throw fail("Configure the Gemini API key on the server.", "GEMINI_OMNI_CONFIG_MISSING");
    return key;
  }

  async function request(url, { method = "GET", body, ambiguousPost = false, purpose = "lifecycle" } = {}) {
    const key = configuration(purpose);
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
      const raw = await readBoundedResponseText(response, maxResponseBytes);
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
        const error = fail("Gemini Interactions rejected the request (HTTP " + response.status + ").", code);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function streamCreate(payload, { onInteractionCreated } = {}) {
    const key = configuration("create");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), streamTimeoutMs);
    let createdId = null;
    let outputUri = null;
    let completed = null;
    let totalBytes = 0;
    let buffer = "";
    const decoder = new TextDecoder();
    let reader;
    const emit = async (block) => {
      const dataLines = block.split(/\r?\n/).filter(line => line.startsWith("data:"));
      if (!dataLines.length) return;
      const raw = dataLines.map(line => line.slice(5).trimStart()).join("\n");
      if (raw === "[DONE]") return;
      let event;
      try { event = JSON.parse(raw); }
      catch { throw fail("Gemini streaming response contained invalid event JSON.", "GEMINI_OMNI_STREAM_INVALID"); }
      const type = event.event_type || block.split(/\r?\n/).find(line => line.startsWith("event:"))?.slice(6).trim();
      if (type === "error") {
        const error = fail("Gemini streaming interaction failed; reconcile the interaction before any retry.",
          "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
        error.providerCode = event.error?.code || null;
        throw error;
      }
      if (type === "interaction.created") {
        const interaction = event.interaction || {};
        const id = interactionId(interaction.id);
        if (interaction.model !== MODEL) throw fail("Gemini stream returned an unexpected model.", "GEMINI_OMNI_INVALID_RESPONSE");
        if (createdId && createdId !== id) throw fail("Gemini stream changed interaction identity.", "GEMINI_OMNI_STREAM_INVALID");
        createdId = id;
        if (typeof onInteractionCreated === "function") {
          await onInteractionCreated({ interactionId: id, status: "running", model: MODEL });
        }
      } else if (type === "step.delta") {
        const delta = event.delta || {};
        if (delta.type === "video" && typeof delta.uri === "string") outputUri = delta.uri;
        if (Array.isArray(delta.content)) {
          const video = delta.content.find(item => item?.type === "video" && typeof item.uri === "string");
          if (video) outputUri = video.uri;
        }
      } else if (type === "interaction.completed") {
        const interaction = event.interaction || {};
        if (interaction.id && createdId && interaction.id !== createdId) {
          throw fail("Gemini completion event does not match the created interaction.", "GEMINI_OMNI_STREAM_INVALID");
        }
        if (!createdId && interaction.id) {
          createdId = interactionId(interaction.id);
          if (interaction.model !== MODEL) throw fail("Gemini stream returned an unexpected model.", "GEMINI_OMNI_INVALID_RESPONSE");
          if (typeof onInteractionCreated === "function") {
            await onInteractionCreated({ interactionId: createdId, status: "running", model: MODEL });
          }
        }
        completed = interaction;
      }
    };
    try {
      let response;
      try {
        response = await fetchImpl(BASE + "/interactions", {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ ...payload, background: true, store: true, stream: true }),
          redirect: "error",
          signal: controller.signal
        });
      } catch {
        throw fail("Gemini interaction submission outcome is unknown; reconcile before any retry.",
          "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
      }
      if (!response.ok) {
        const raw = await readBoundedResponseText(response, maxResponseBytes);
        if (response.status >= 500) throw fail("Gemini interaction submission returned a server error; reconcile before retry.",
          "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
        const error = fail("Gemini Interactions rejected the request (HTTP " + response.status + ").",
          response.status === 429 ? "GEMINI_OMNI_RATE_LIMITED" : "GEMINI_OMNI_REQUEST_REJECTED");
        error.status = response.status;
        error.providerMessage = raw.slice(0, 500);
        throw error;
      }
      const contentType = response.headers?.get?.("content-type") || "";
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        const raw = await readBoundedResponseText(response, maxResponseBytes);
        let data;
        try { data = JSON.parse(raw); }
        catch { throw fail("Gemini accepted the submission but returned an unsupported streaming response; reconcile before retry.",
          "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN"); }
        const result = normalized(data);
        createdId = result.interactionId;
        outputUri = result.video?.delivery === "uri" ? result.video.uri : null;
        if (typeof onInteractionCreated === "function") {
          await onInteractionCreated({ interactionId: createdId, status: result.status, model: MODEL });
        }
        return { interactionId: createdId, status: result.status, outputUri, usage: data.usage || null };
      }
      if (!response.body?.getReader) throw fail("Gemini streaming response body is unavailable.",
        "GEMINI_OMNI_STREAM_INVALID");
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
          try { await reader.cancel(); } catch {}
          throw fail("Gemini streaming response exceeded its configured size limit.",
            "GEMINI_OMNI_RESPONSE_TOO_LARGE");
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, boundary);
          const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
          buffer = buffer.slice(boundary + delimiter.length);
          await emit(block);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) await emit(buffer);
      if (!completed || !createdId) {
        throw fail("Gemini streaming submission ended before a durable completion event; reconcile before retry.",
          "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
      }
      const statusMap = new Map([["completed", "succeeded"], ["in_progress", "running"],
        ["requires_action", "waiting"], ["failed", "failed"], ["cancelled", "canceled"],
        ["incomplete", "incomplete"], ["budget_exceeded", "failed"]]);
      return { interactionId: createdId, status: statusMap.get(completed.status) || "unknown",
        outputUri, usage: completed.usage || null };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw fail(createdId
          ? "Gemini stream timed out after interaction creation; the durable interaction must be reconciled."
          : "Gemini interaction submission timed out; its outcome is unknown and must be reconciled.",
        "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
      }
      if (["GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN", "GEMINI_OMNI_REQUEST_REJECTED",
          "GEMINI_OMNI_RATE_LIMITED"].includes(error?.code)) throw error;
      throw fail(createdId
        ? "Gemini stream failed after interaction creation; reconcile the durable interaction before any retry."
        : "Gemini accepted or may have accepted the submission; reconcile before any retry.",
      "GEMINI_OMNI_SUBMISSION_OUTCOME_UNKNOWN");
    } finally {
      clearTimeout(timer);
      try { reader?.releaseLock(); } catch {}
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

  async function fetchAuthorizedInteraction(id, context) {
    const safeId = interactionId(id);
    await authorize(safeId, context, "read");
    // Request only lifecycle and URI metadata. The Interactions GET response
    // can echo generated video as large inline base64 even when URI delivery was
    // requested; selecting only uri prevents media bytes entering the poller.
    const fields = "id,model,status,steps(type,content(type,mime_type,uri))";
    const url = new URL(BASE + "/interactions/" + encodeURIComponent(safeId));
    url.searchParams.set("fields", fields);
    const data = await request(url.toString());
    normalized(data);
    return data;
  }

  return Object.freeze({
    provider: "google",
    model: MODEL,
    minimumPollIntervalMs: 5000,

    async createInteraction(plan, context = {}, options = {}) {
      const payload = safePlan(plan, { supabaseUrl: env.SUPABASE_URL });
      let approved = false;
      try { approved = await assertApprovedSubmission({ plan, context }); }
      catch {}
      if (approved !== true) throw fail("A durable approval and budget reservation are required before Gemini submission.",
        "GEMINI_OMNI_APPROVAL_REQUIRED");
      const result = await streamCreate(payload, options);
      return Object.freeze({
        taskId: result.interactionId,
        interactionId: result.interactionId,
        status: result.status,
        provider: "google",
        model: MODEL,
        usage: result.usage,
        outputUrls: Object.freeze(result.outputUri ? [result.outputUri] : [])
      });
    },

    async getInteractionForIngestion(id, context = {}) {
      return fetchAuthorizedInteraction(id, context);
    },

    async getInteraction(id, context = {}) {
      const data = await fetchAuthorizedInteraction(id, context);
      const result = normalized(data);
      return Object.freeze({
        taskId: result.interactionId,
        interactionId: result.interactionId,
        status: result.status,
        provider: "google",
        model: MODEL,
        outputUrls: Object.freeze(result.video?.delivery === "uri" ? [result.video.uri] : []),
        outputDelivery: result.video?.delivery || null
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
      try {
        await request(BASE + "/interactions/" + encodeURIComponent(safeId), { method: "DELETE" });
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
      return Object.freeze({ interactionId: safeId, deleted: true });
    }
  });
}
