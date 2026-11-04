const BASE_URL = "https://agents.lumalabs.ai/v1";
const fail = (message, code = "LUMA_VIDEO_ADAPTER_ERROR") => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const allowedRatios = new Set(["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"]);
const allowedResolutions = new Set(["540p", "720p", "1080p"]);

function safeImageRef(value, label) {
  if (!plain(value)) throw fail(label + " must be a typed image reference.", "LUMA_VIDEO_INPUT_INVALID");
  if (typeof value.file_id === "string" && value.file_id.trim() && value.file_id.length <= 256) return { file_id: value.file_id };
  if (typeof value.generation_id === "string" && value.generation_id.trim() && value.generation_id.length <= 128) return { generation_id: value.generation_id };
  if (typeof value.url === "string") {
    let url;
    try { url = new URL(value.url); } catch { throw fail(label + " URL is invalid.", "LUMA_VIDEO_INPUT_INVALID"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || value.url.length > 4096) {
      throw fail(label + " must be a credential-free HTTPS URL.", "LUMA_VIDEO_INPUT_INVALID");
    }
    return { url: url.toString() };
  }
  throw fail(label + " must contain a file_id, generation_id or HTTPS URL.", "LUMA_VIDEO_INPUT_INVALID");
}

function validateInput(input) {
  if (!plain(input)) throw fail("Luma generation input must be an object.", "LUMA_VIDEO_INPUT_INVALID");
  const prompt = input.prompt ?? input.promptText;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 6000) {
    throw fail("Ray 3.2 prompt must contain 1–6000 characters.", "LUMA_VIDEO_INPUT_INVALID");
  }
  for (const field of ["hdr", "exrExport", "loop"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") {
      throw fail(field + " must be a boolean when supplied.", "LUMA_VIDEO_INPUT_INVALID");
    }
  }
  const durationSeconds = input.durationSeconds ?? 5;
  if (![5, 10].includes(durationSeconds)) throw fail("Ray 3.2 duration must be 5 or 10 seconds.", "LUMA_VIDEO_INPUT_INVALID");
  const resolution = input.resolution ?? "720p";
  if (!allowedResolutions.has(resolution)) throw fail("Ray 3.2 resolution must be 540p, 720p or 1080p.", "LUMA_VIDEO_INPUT_INVALID");
  const aspectRatio = input.aspectRatio ?? input.aspect_ratio;
  if (aspectRatio !== undefined && !allowedRatios.has(aspectRatio)) throw fail("Ray 3.2 aspect ratio is unsupported.", "LUMA_VIDEO_INPUT_INVALID");

  const video = { resolution, duration: durationSeconds + "s" };
  if (input.hdr === true) video.hdr = true;
  if (input.exrExport === true) video.exr_export = true;
  if (input.loop === true) video.loop = true;
  if (input.exrExport === true && input.hdr !== true) throw fail("EXR export requires HDR.", "LUMA_VIDEO_INPUT_INVALID");
  if (input.hdr === true && (durationSeconds !== 5 || !["720p", "1080p"].includes(resolution) || input.loop === true)) {
    throw fail("Ray 3.2 generation HDR is priced only for 5-second 720p or 1080p output and cannot loop.", "LUMA_VIDEO_INPUT_INVALID");
  }
  if (input.loop === true && durationSeconds !== 5) throw fail("Ray 3.2 looping supports only 5-second output.", "LUMA_VIDEO_INPUT_INVALID");

  const hasStart = input.startFrame !== undefined;
  const hasEnd = input.endFrame !== undefined;
  const hasKeyframes = input.keyframes !== undefined || input.keyframeIndexes !== undefined;
  if (durationSeconds === 10 && (hasStart || hasEnd)) {
    throw fail("Ray 3.2 10-second generation cannot use startFrame or endFrame; use multi-keyframe mode.", "LUMA_VIDEO_INPUT_INVALID");
  }
  if (hasKeyframes) {
    if (hasStart || hasEnd || input.loop === true) throw fail("Ray 3.2 keyframes are mutually exclusive with start/end frames and looping.", "LUMA_VIDEO_INPUT_INVALID");
    if (!Array.isArray(input.keyframes) || input.keyframes.length < 1 || input.keyframes.length > 64 ||
        !Array.isArray(input.keyframeIndexes) || input.keyframeIndexes.length !== input.keyframes.length) {
      throw fail("Ray 3.2 keyframes require 1–64 images and an equal number of frame indexes.", "LUMA_VIDEO_INPUT_INVALID");
    }
    const maxFrame = durationSeconds * 24;
    const indexes = new Set();
    video.keyframes = input.keyframes.map((frame, index) => safeImageRef(frame, "keyframe " + (index + 1)));
    video.keyframe_indexes = input.keyframeIndexes.map(value => {
      if (!Number.isSafeInteger(value) || value < 0 || value > maxFrame || indexes.has(value)) {
        throw fail("Ray 3.2 keyframe indexes must be unique output-frame positions within the duration.", "LUMA_VIDEO_INPUT_INVALID");
      }
      indexes.add(value);
      return value;
    });
  } else {
    if (hasStart) video.start_frame = safeImageRef(input.startFrame, "startFrame");
    if (hasEnd) video.end_frame = safeImageRef(input.endFrame, "endFrame");
  }
  const payload = { model: "ray-3.2", type: "video", prompt: prompt.trim(), video };
  if (aspectRatio !== undefined) payload.aspect_ratio = aspectRatio;
  return payload;
}

function parseResponseBody(text) {
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw fail("Luma returned a non-JSON response.", "LUMA_VIDEO_RESPONSE_INVALID"); }
}

export function createLumaRay32Adapter({
  apiKey = process.env.LUMA_AGENTS_API_KEY,
  fetchImpl = globalThis.fetch,
  baseUrl = BASE_URL,
  timeoutMs = 30000
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096) {
    throw fail("LUMA_AGENTS_API_KEY is required on the server.", "LUMA_VIDEO_CONFIGURATION_MISSING");
  }
  if (typeof fetchImpl !== "function") throw fail("A fetch implementation is required.");
  let base;
  try { base = new URL(baseUrl); } catch { throw fail("Luma base URL is invalid."); }
  if (base.protocol !== "https:" || base.hostname !== "agents.lumalabs.ai" || base.port || base.username || base.password || base.search || base.hash || base.pathname !== "/v1") {
    throw fail("Luma base URL must be credential-free HTTPS.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw fail("Luma timeout must be between 1 and 120 seconds.");

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL((base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname) + path, base.origin).toString(), {
        ...init,
        headers: {
          authorization: "Bearer " + apiKey,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers
        },
        signal: controller.signal
      });
      const body = parseResponseBody(await response.text());
      if (!response.ok) {
        const error = fail("Luma API request failed with HTTP " + response.status + ".", "LUMA_VIDEO_HTTP_" + response.status);
        error.status = response.status;
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      if (!plain(body)) throw fail("Luma API returned an invalid response object.", "LUMA_VIDEO_RESPONSE_INVALID");
      return body;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("Luma API request timed out.", "LUMA_VIDEO_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    provider: "luma",
    model: "ray-3.2",
    minimumPollIntervalMs: 5000,
    async prepareInput(input) { return validateInput(input); },
    async submit(payload) {
      const body = await request("/generations", { method: "POST", body: JSON.stringify(payload) });
      if (typeof body.id !== "string" || !body.id.trim() || body.id.length > 128) {
        throw fail("Luma did not return a valid generation ID.", "LUMA_VIDEO_TASK_ID_MISSING");
      }
      return { taskId: body.id, status: body.state || "queued" };
    },
    async getStatus(taskId) {
      if (typeof taskId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(taskId)) {
        throw fail("Luma generation ID is invalid.", "LUMA_VIDEO_TASK_ID_INVALID");
      }
      const body = await request("/generations/" + encodeURIComponent(taskId));
      if (body.id !== taskId) throw fail("Luma returned a generation record that does not match the requested task.", "LUMA_VIDEO_RESPONSE_MISMATCH");
      const state = body.state;
      if (state === "failed") {
        return { taskId, status: "failed", failure: String(body.failure_reason || "Luma generation failed.").slice(0, 500), failureCode: String(body.failure_code || "LUMA_GENERATION_FAILED").slice(0, 100), usage: body.usage || null };
      }
      if (state === "completed") {
        const outputUrls = Array.isArray(body.output)
          ? body.output.filter(item => item?.type === "video" && typeof item.url === "string").map(item => item.url)
          : [];
        if (outputUrls.length < 1 || outputUrls.length > 3 || outputUrls.some(value => {
          try {
            const url = new URL(value);
            return url.protocol !== "https:" || url.username || url.password || value.length > 4096;
          } catch { return true; }
        })) {
          throw fail("Luma completed without a valid bounded HTTPS video output.", "LUMA_VIDEO_OUTPUT_INVALID");
        }
        return { taskId, status: "succeeded", outputUrls, usage: body.usage || null, providerGenerationId: body.id };
      }
      return { taskId, status: state === "queued" ? "queued" : "running", providerState: typeof state === "string" ? state.slice(0, 80) : "unknown" };
    }
  });
}
