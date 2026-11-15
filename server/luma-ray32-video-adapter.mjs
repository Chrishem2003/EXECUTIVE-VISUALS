const BASE_URL = "https://agents.lumalabs.ai/v1";
const fail = (message, code = "LUMA_VIDEO_ADAPTER_ERROR") => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const allowedRatios = new Set(["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"]);
const allowedResolutions = new Set(["360p", "540p", "720p", "1080p"]);

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
  const operation = input.operation ?? "generate";
  if (!["generate", "edit", "reframe", "extend"].includes(operation)) {
    throw fail("Luma operation must be generate, edit, reframe or extend.", "LUMA_VIDEO_INPUT_INVALID");
  }
  const durationSeconds = input.durationSeconds ?? 5;
  if (operation === "reframe") {
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 10) {
      throw fail("Ray 3.2 reframe source duration must be a whole number from 2 to 10 seconds.", "LUMA_VIDEO_INPUT_INVALID");
    }
  } else if (operation === "edit") {
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 2 || durationSeconds > 18) {
      throw fail("Ray 3.2 video edit source duration must be a whole number from 2 to 18 seconds.", "LUMA_VIDEO_INPUT_INVALID");
    }
  } else if (![5, 10].includes(durationSeconds)) {
    throw fail("Ray 3.2 generation/extension duration must be 5 or 10 seconds.", "LUMA_VIDEO_INPUT_INVALID");
  }
  const resolution = input.resolution ?? "720p";
  if (!allowedResolutions.has(resolution)) throw fail("Ray 3.2 resolution must be 360p, 540p, 720p or 1080p.", "LUMA_VIDEO_INPUT_INVALID");
  const aspectRatio = input.aspectRatio ?? input.aspect_ratio;
  if (aspectRatio !== undefined && !allowedRatios.has(aspectRatio)) throw fail("Ray 3.2 aspect ratio is unsupported.", "LUMA_VIDEO_INPUT_INVALID");

  if (operation !== "generate") {
    if (input.hdr === true || input.exrExport === true || input.loop === true || input.keyframes !== undefined ||
        input.keyframeIndexes !== undefined || input.startFrame !== undefined || input.endFrame !== undefined) {
      throw fail("Generation-only controls cannot be combined with edit, reframe or extend operations.", "LUMA_VIDEO_INPUT_INVALID");
    }
    if (operation === "edit" || operation === "reframe") {
      const source = input.sourceVideo ?? input.source;
      if (!plain(source)) throw fail("Luma video edit and reframe require an owner-resolved sourceVideo reference.", "LUMA_VIDEO_INPUT_INVALID");
      let sourceRef;
      if (typeof source.generation_id === "string" && source.generation_id.trim() && source.generation_id.length <= 128) {
        sourceRef = { generation_id: source.generation_id.trim() };
      } else if (typeof source.file_id === "string" && source.file_id.trim() && source.file_id.length <= 256) {
        sourceRef = { file_id: source.file_id.trim() };
      } else if (typeof source.url === "string") {
        let url;
        try { url = new URL(source.url); } catch { throw fail("Source video URL is invalid.", "LUMA_VIDEO_INPUT_INVALID"); }
        if (url.protocol !== "https:" || url.username || url.password || url.hash || source.url.length > 4096 ||
            typeof source.media_type !== "string" || !/^video\/[a-z0-9.+-]+$/i.test(source.media_type)) {
          throw fail("Source video URL requires credential-free HTTPS and an explicit video media_type.", "LUMA_VIDEO_INPUT_INVALID");
        }
        sourceRef = { url: url.toString(), media_type: source.media_type };
      } else {
        throw fail("Source video must contain generation_id, file_id or a typed HTTPS URL.", "LUMA_VIDEO_INPUT_INVALID");
      }
      const payload = {
        model: "ray-3.2",
        type: operation === "edit" ? "video_edit" : "video_reframe",
        prompt: prompt.trim(),
        source: sourceRef,
        video: { resolution }
      };
      if (input.user_id !== undefined) {
        if (typeof input.user_id !== "string" || !input.user_id.trim() || input.user_id.length > 256) {
          throw fail("Luma user_id must be a stable opaque identifier of at most 256 characters.", "LUMA_VIDEO_INPUT_INVALID");
        }
        payload.user_id = input.user_id.trim();
      }
      if (operation === "edit") {
        const strength = input.editStrength ?? "flex_2";
        if (!["adhere_1", "adhere_2", "adhere_3", "flex_1", "flex_2", "flex_3", "reimagine_1", "reimagine_2", "reimagine_3"].includes(strength)) {
          throw fail("Luma editStrength is not a supported Ray 3.2 strength.", "LUMA_VIDEO_INPUT_INVALID");
        }
        payload.video.edit = { strength };
      } else {
        if (aspectRatio === undefined) throw fail("Luma video reframe requires a target aspectRatio.", "LUMA_VIDEO_INPUT_INVALID");
        payload.aspect_ratio = aspectRatio;
        if (input.sourcePosition !== undefined) {
          const position = input.sourcePosition;
          if (!plain(position) ||
              !Number.isFinite(position.x_norm) || position.x_norm < -2 || position.x_norm > 2 ||
              !Number.isFinite(position.y_norm) || position.y_norm < -2 || position.y_norm > 2 ||
              !Number.isFinite(position.w_norm) || position.w_norm <= 0 || position.w_norm > 2 ||
              !Number.isFinite(position.h_norm) || position.h_norm <= 0 || position.h_norm > 2) {
            throw fail("Luma sourcePosition requires normalized x/y coordinates in [-2,2] and positive width/height up to 2.", "LUMA_VIDEO_INPUT_INVALID");
          }
          payload.source_position = {
            x_norm: position.x_norm, y_norm: position.y_norm,
            w_norm: position.w_norm, h_norm: position.h_norm
          };
        }
      }
      return payload;
    }
    const generationId = input.sourceGenerationId;
    if (typeof generationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generationId)) {
      throw fail("Luma extension requires a valid sourceGenerationId owned by the same caller.", "LUMA_VIDEO_INPUT_INVALID");
    }
    const payload = {
      model: "ray-3.2", type: "video", prompt: prompt.trim(),
      video: { resolution, duration: durationSeconds + "s", start_frame: { generation_id: generationId } }
    };
    if (input.user_id !== undefined) {
      if (typeof input.user_id !== "string" || !input.user_id.trim() || input.user_id.length > 256) {
        throw fail("Luma user_id must be a stable opaque identifier of at most 256 characters.", "LUMA_VIDEO_INPUT_INVALID");
      }
      payload.user_id = input.user_id.trim();
    }
    if (aspectRatio !== undefined) payload.aspect_ratio = aspectRatio;
    return payload;
  }

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
  if (input.user_id !== undefined) {
    if (typeof input.user_id !== "string" || !input.user_id.trim() || input.user_id.length > 256) {
      throw fail("Luma user_id must be a stable opaque identifier of at most 256 characters.", "LUMA_VIDEO_INPUT_INVALID");
    }
    payload.user_id = input.user_id.trim();
  }
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
  timeoutMs = 30000,
  billingSettlementMaxWaitMs = 20 * 60 * 1000,
  now = () => Date.now()
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
  if (!Number.isInteger(billingSettlementMaxWaitMs) || billingSettlementMaxWaitMs < 60000 || billingSettlementMaxWaitMs > 60 * 60 * 1000 || typeof now !== "function") throw fail("Luma billing-settlement wait configuration is invalid.");

  async function request(path, init = {}) {
    const { allowEmptyResponse = false, ...requestInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL((base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname) + path, base.origin).toString(), {
        ...requestInit,
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
      if (!plain(body)) {
        if (allowEmptyResponse && response.ok && body === null) return {};
        throw fail("Luma API returned an invalid response object.", "LUMA_VIDEO_RESPONSE_INVALID");
      }
      return body;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("Luma API request timed out.", "LUMA_VIDEO_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }

  const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const FILE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]);
  const MAX_FILE_BYTES = 250 * 1024 * 1024;

  const issuedUploadReceipts = new WeakMap();

  function validateUploadReceipt(body, expected) {
    const file = body?.file || body;
    const fileId = body?.id || file?.id;
    const upload = body?.upload;
    if (!plain(file) || typeof fileId !== "string" || !FILE_ID.test(fileId) ||
        file.id !== fileId || file.mime_type !== expected.mimeType ||
        Number(file.size_bytes) !== expected.sizeBytes || !["pending", "ready"].includes(file.state)) {
      throw fail("Luma returned an invalid provider-file receipt.", "LUMA_FILE_RESPONSE_INVALID");
    }
    if (!plain(upload) || upload.method !== "PUT" || typeof upload.url !== "string") {
      throw fail("Luma did not return a presigned PUT upload.", "LUMA_FILE_UPLOAD_URL_INVALID");
    }
    let url;
    try { url = new URL(upload.url); } catch { throw fail("Luma returned an invalid presigned upload URL.", "LUMA_FILE_UPLOAD_URL_INVALID"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        !(url.hostname === "amazonaws.com" || url.hostname.endsWith(".amazonaws.com") ||
          url.hostname === "amazonaws.com.cn" || url.hostname.endsWith(".amazonaws.com.cn")) ||
        !Number.isFinite(Date.parse(upload.expires_at || "")) || Date.parse(upload.expires_at) <= now()) {
      throw fail("Luma presigned upload URL must be an unexpired HTTPS object-storage URL.", "LUMA_FILE_UPLOAD_URL_INVALID");
    }
    const headers = plain(upload.headers) ? upload.headers : {};
    for (const [name, value] of Object.entries(headers)) {
      if (!/^(content-type|content-length|x-amz-[a-z0-9-]+)$/i.test(name) ||
          typeof value !== "string" || value.length > 2048 || /[\r\n]/.test(value)) {
        throw fail("Luma returned unsafe presigned upload headers.", "LUMA_FILE_RESPONSE_INVALID");
      }
    }
    const uploadReceipt = Object.freeze({ url: url.toString(), method: "PUT", headers: Object.freeze({ ...headers }), expiresAt: upload.expires_at });
    issuedUploadReceipts.set(uploadReceipt, { mimeType: expected.mimeType, sizeBytes: expected.sizeBytes });
    return Object.freeze({ fileId, state: file.state, mimeType: expected.mimeType, sizeBytes: expected.sizeBytes, upload: uploadReceipt });
  }

  return Object.freeze({
    provider: "luma",
    model: "ray-3.2",
    minimumPollIntervalMs: 5000,
    async createFileUpload({ mimeType, sizeBytes, filename, purpose = "input", userId } = {}) {
      const normalizedMime = typeof mimeType === "string" ? mimeType.toLowerCase().trim() : "";
      if (!FILE_MIME_TYPES.has(normalizedMime) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES ||
          !["input", "reference"].includes(purpose) ||
          (filename !== undefined && (typeof filename !== "string" || !filename.trim() || filename.length > 255 || /[\r\n]/.test(filename))) ||
          (userId !== undefined && (typeof userId !== "string" || !userId.trim() || userId.length > 256))) {
        throw fail("Luma file upload requires a supported media type, bounded size and valid metadata.", "LUMA_FILE_INPUT_INVALID");
      }
      const body = await request("/files", { method: "POST", body: JSON.stringify({
        mime_type: normalizedMime, size_bytes: sizeBytes, purpose,
        ...(filename ? { filename: filename.trim() } : {}),
        ...(userId ? { user_id: userId.trim() } : {})
      }) });
      return validateUploadReceipt(body, { mimeType: normalizedMime, sizeBytes });
    },
    async uploadFileBytes({ upload, bytes, mimeType } = {}) {
      const expected = plain(upload) ? issuedUploadReceipts.get(upload) : null;
      if (!expected || upload.method !== "PUT" || typeof upload.url !== "string" ||
          !(bytes instanceof Uint8Array) || bytes.byteLength !== expected.sizeBytes ||
          typeof mimeType !== "string" || mimeType.toLowerCase() !== expected.mimeType) {
        throw fail("Luma file upload requires a valid upload receipt and bounded media bytes.", "LUMA_FILE_INPUT_INVALID");
      }
      const url = new URL(upload.url);
      if (url.protocol !== "https:" || !(url.hostname === "amazonaws.com" || url.hostname.endsWith(".amazonaws.com") ||
          url.hostname === "amazonaws.com.cn" || url.hostname.endsWith(".amazonaws.com.cn")) ||
          !Number.isFinite(Date.parse(upload.expiresAt || "")) || Date.parse(upload.expiresAt) <= now()) {
        throw fail("Luma presigned upload receipt is invalid or expired.", "LUMA_FILE_UPLOAD_URL_INVALID");
      }
      const headers = { ...(upload.headers || {}), "content-type": mimeType.toLowerCase(), "content-length": String(bytes.byteLength) };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), { method: "PUT", headers, body: Buffer.from(bytes), redirect: "error", signal: controller.signal });
        if (!response.ok) {
          const error = fail("Luma object-storage upload failed with HTTP " + response.status + ".", "LUMA_FILE_UPLOAD_FAILED");
          error.status = response.status;
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return { uploadedBytes: bytes.byteLength, mimeType: mimeType.toLowerCase() };
      } catch (error) {
        if (error?.name === "AbortError") throw fail("Luma object-storage upload timed out.", "LUMA_FILE_UPLOAD_OUTCOME_UNKNOWN");
        throw error;
      } finally { clearTimeout(timer); }
    },
    async completeFileUpload(fileId) {
      if (typeof fileId !== "string" || !FILE_ID.test(fileId)) throw fail("Luma file ID is invalid.", "LUMA_FILE_ID_INVALID");
      const body = await request("/files/" + encodeURIComponent(fileId) + "/complete", { method: "POST" });
      const file = body.file || body;
      if (file.id !== fileId || !["pending", "ready"].includes(file.state)) throw fail("Luma file completion returned an invalid resource.", "LUMA_FILE_RESPONSE_INVALID");
      return { fileId, state: file.state };
    },
    async getFile(fileId) {
      if (typeof fileId !== "string" || !FILE_ID.test(fileId)) throw fail("Luma file ID is invalid.", "LUMA_FILE_ID_INVALID");
      const body = await request("/files/" + encodeURIComponent(fileId));
      const file = body.file || body;
      if (file.id !== fileId || !["pending", "ready", "failed", "deleted"].includes(file.state)) throw fail("Luma file lookup returned an invalid resource.", "LUMA_FILE_RESPONSE_INVALID");
      return { fileId, state: file.state, mimeType: file.mime_type || null, sizeBytes: Number.isSafeInteger(Number(file.size_bytes)) ? Number(file.size_bytes) : null,
        failureReason: typeof file.failure_reason === "string" ? file.failure_reason.slice(0, 500) : null };
    },
    async deleteFile(fileId) {
      if (typeof fileId !== "string" || !FILE_ID.test(fileId)) throw fail("Luma file ID is invalid.", "LUMA_FILE_ID_INVALID");
      await request("/files/" + encodeURIComponent(fileId), { method: "DELETE", allowEmptyResponse: true });
      return { fileId, deleted: true };
    },
    async prepareInput(input) { return validateInput(input); },
    async submit(payload) {
      const body = await request("/generations", { method: "POST", body: JSON.stringify(payload) });
      if (typeof body.id !== "string" || !body.id.trim() || body.id.length > 128) {
        throw fail("Luma did not return a valid generation ID.", "LUMA_VIDEO_TASK_ID_MISSING");
      }
      return { taskId: body.id, status: body.state || "queued" };
    },
    async getStatus(taskId, context = {}) {
      if (typeof taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
        throw fail("Luma generation ID is invalid.", "LUMA_VIDEO_TASK_ID_INVALID");
      }
      const body = await request("/generations/" + encodeURIComponent(taskId));
      if (body.id !== taskId) throw fail("Luma returned a generation record that does not match the requested task.", "LUMA_VIDEO_RESPONSE_MISMATCH");
      const state = body.state;
      if (state === "failed") {
        return { taskId, status: "failed", failure: String(body.failure_reason || "Luma generation failed.").slice(0, 500), failureCode: String(body.failure_code || "LUMA_GENERATION_FAILED").slice(0, 100), usage: body.usage || null };
      }
      if (state === "completed") {
        const usage = body.usage || null;
        if (usage?.credits_charged === null || usage?.credits_charged === undefined) {
          const createdAt = Date.parse(body.created_at || context.job?.created_at || "");
          const ageMs = Number.isFinite(createdAt) ? Math.max(0, now() - createdAt) : billingSettlementMaxWaitMs;
          if (ageMs < billingSettlementMaxWaitMs) {
            const attempts = Number.isSafeInteger(context.job?.attempt_count) ? Math.max(0, context.job.attempt_count - 1) : 0;
            const retryAfterSeconds = Math.min(300, 30 * (2 ** Math.min(4, attempts)));
            return { taskId, status: "running", providerState: "completed_billing_pending", billingPending: true, retryAfterSeconds };
          }
        }
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
        return { taskId, status: "succeeded", outputUrls, usage, providerGenerationId: body.id };
      }
      return { taskId, status: state === "queued" ? "queued" : "running", providerState: typeof state === "string" ? state.slice(0, 80) : "unknown" };
    }
  });
}
