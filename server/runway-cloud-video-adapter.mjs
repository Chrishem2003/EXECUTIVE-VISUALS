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
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const UPLOAD_TYPES = Object.freeze({
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
});
const isRunwayUri = value => typeof value === "string" && /^runway:\/\/[A-Za-z0-9._~:/?@!const fail = (message, code) => Object.assign(new Error(message), { code });'()*+,;=%-]{1,4980}$/.test(value);

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
  if (!["gen4.5", "aleph2", "magnific_video_upscaler_creative", "ruby"].includes(selectedModel)) {
    throw fail("This Runway cloud adapter supports only verified Gen-4.5 generation, Aleph2 editing, Magnific upscaling and Ruby HDR profiles.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
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


  async function uploadEphemeral({ buffer, filename, mimeType } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 512 || buffer.length > MAX_UPLOAD_BYTES) {
      throw fail("Runway ephemeral uploads must be between 512 bytes and 200 MiB.", "RUNWAY_INPUT_INVALID");
    }
    const type = String(mimeType || "").toLowerCase();
    const extension = UPLOAD_TYPES[type];
    const name = typeof filename === "string" ? filename.trim() : "";
    if (!extension || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name) || name.includes("..") ||
        name.slice(name.lastIndexOf(".")).toLowerCase() !== extension) {
      throw fail("Upload filename extension and media type must match.", "RUNWAY_INPUT_INVALID");
    }
    const created = await request("/uploads", {
      method: "POST",
      submission: true,
      body: { filename: name, type: "ephemeral" }
    });
    if (!isRunwayUri(created.runwayUri)) throw fail("Runway returned an invalid ephemeral URI.", "RUNWAY_INVALID_RESPONSE");
    let uploadUrl;
    try { uploadUrl = new URL(created.uploadUrl); } catch {
      throw fail("Runway returned an invalid ephemeral upload URL.", "RUNWAY_INVALID_RESPONSE");
    }
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.port || uploadUrl.hash) {
      throw fail("Runway returned an unsafe ephemeral upload URL.", "RUNWAY_INVALID_RESPONSE");
    }
    if (!created.fields || typeof created.fields !== "object" || Array.isArray(created.fields) ||
        Object.keys(created.fields).length > 30 ||
        Object.entries(created.fields).some(([field, value]) =>
          !/^[A-Za-z0-9_-]{1,128}$/.test(field) || typeof value !== "string" || value.length > 4096)) {
      throw fail("Runway returned invalid ephemeral upload fields.", "RUNWAY_INVALID_RESPONSE");
    }
    const form = new FormData();
    for (const [field, value] of Object.entries(created.fields)) form.append(field, value);
    form.append("file", new Blob([buffer], { type }), name);
    let response;
    try { response = await fetchImpl(uploadUrl, { method: "POST", body: form, redirect: "error" }); }
    catch { throw fail("Runway ephemeral upload failed; allocate a new upload before retrying.", "RUNWAY_UPLOAD_FAILED"); }
    if (!response.ok) throw fail("Runway ephemeral upload failed; allocate a new upload before retrying.", "RUNWAY_UPLOAD_FAILED");
    return created.runwayUri;
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
      const isVideoEdit = input.operation === "video-to-video";
      const isVideoUpscale = input.operation === "video-upscale";
      const isVideoHdr = input.operation === "video-to-hdr";
      const isImageToVideo = input.operation === "image-to-video" || Boolean(input.startFrameAssetId);
      const hasReferences = (Array.isArray(input.referenceAssetIds) && input.referenceAssetIds.length > 0) ||
        Boolean(input.referenceImageDataUrl) || Boolean(input.sourceVideoAssetId) ||
        Boolean(input.startFrameAssetId) ||
        (Array.isArray(input.keyframeAssetIds) && input.keyframeAssetIds.length > 0);
      if ((hasReferences || isVideoEdit || isVideoUpscale || isVideoHdr || isImageToVideo) && typeof prepareInput !== "function") {
        throw fail("Runway source and reference assets require an authenticated project-scoped input resolver.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      if (typeof prepareInput !== "function") return input;
      const prepared = await prepareInput(input, context);
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
        throw fail("Runway private input preparation returned an invalid payload.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
      }
      if (isImageToVideo) {
        if (selectedModel !== "gen4.5") throw fail("First-frame generation currently requires the verified Gen-4.5 profile.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
        let promptImageUri = prepared.promptImageUri;
        if (prepared.firstFrame) promptImageUri = await uploadEphemeral(prepared.firstFrame);
        if (!isRunwayUri(promptImageUri)) throw fail("Image-to-video requires a Runway ephemeral first-frame upload resolved from the authorized asset.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        return { ...input, promptImageUri };
      }
      if (isVideoHdr) {
        if (selectedModel !== "ruby") throw fail("HDR conversion requires the verified Ruby profile.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
        let videoUri = prepared.videoUri;
        if (prepared.sourceVideo) videoUri = await uploadEphemeral(prepared.sourceVideo);
        if (!isRunwayUri(videoUri)) throw fail("HDR conversion requires a Runway ephemeral URI resolved from the authorized source asset.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        return { ...input, videoUri };
      }
      if (!isVideoEdit && !isVideoUpscale) return prepared;
      if (isVideoUpscale) {
        if (selectedModel !== "magnific_video_upscaler_creative") throw fail("Video upscaling requires the verified Magnific video-upscaler profile.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
        let videoUri = prepared.videoUri;
        if (prepared.sourceVideo) videoUri = await uploadEphemeral(prepared.sourceVideo);
        if (!isRunwayUri(videoUri)) throw fail("Video upscaling requires a Runway ephemeral URI resolved from the authorized source asset.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        return { ...input, videoUri };
      }
      if (selectedModel !== "aleph2") throw fail("Video-to-video currently requires the verified Aleph2 adapter profile.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
      let videoUri = prepared.videoUri;
      if (prepared.sourceVideo) videoUri = await uploadEphemeral(prepared.sourceVideo);
      if (!isRunwayUri(videoUri)) throw fail("Video-to-video requires a Runway ephemeral URI resolved from the authorized source asset.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      const sourceFrames = Array.isArray(prepared.keyframes) ? prepared.keyframes : [];
      if (sourceFrames.length > 5) throw fail("Video-to-video accepts at most five keyframe assets.", "RUNWAY_INPUT_INVALID");
      const keyframes = [];
      for (const frame of sourceFrames) {
        const uri = frame?.buffer
          ? await uploadEphemeral({ buffer: frame.buffer, filename: frame.filename, mimeType: frame.mimeType })
          : frame?.uri;
        if (!isRunwayUri(uri) || !Number.isFinite(frame?.at) || frame.at < 0 || frame.at > 30) {
          throw fail("Video-to-video keyframes must be authorized Runway uploads with valid timestamps.", "RUNWAY_INPUT_INVALID");
        }
        keyframes.push({ uri, at: frame.at });
      }
      return { ...input, videoUri, keyframes };
    },

    async submit(input) {
      assertEnabled();
      if (!input || input.provider !== "runway" || input.model !== selectedModel) {
        throw fail("Runway job identity does not match the selected adapter.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      if (input.operation === "video-to-hdr") {
        if (selectedModel !== "ruby" || !isRunwayUri(input.videoUri)) {
          throw fail("Ruby HDR requires a prepared source video upload.", "RUNWAY_INPUT_INVALID");
        }
        const outputFormat = input.outputFormat ?? "hdr10";
        if (!["hdr10", "hlg"].includes(outputFormat)) throw fail("Ruby HDR output must be hdr10 or hlg in this MP4 worker.", "RUNWAY_INPUT_INVALID");
        const submitted = await request("/video_to_hdr", {
          method: "POST", submission: true,
          body: { model: "ruby", videoUri: input.videoUri, outputFormat }
        });
        return { taskId: taskId(submitted.id), status: "queued" };
      }
      if (input.operation === "video-upscale") {
        if (selectedModel !== "magnific_video_upscaler_creative" || !isRunwayUri(input.videoUri)) {
          throw fail("Magnific video upscaling requires a prepared source video upload.", "RUNWAY_INPUT_INVALID");
        }
        const resolution = input.resolution ?? "2k";
        if (!["720p", "1k", "2k", "4k"].includes(resolution)) throw fail("Video upscale resolution must be 720p, 1k, 2k or 4k.", "RUNWAY_INPUT_INVALID");
        const bounded = (value, label) => {
          if (value == null) return undefined;
          if (!Number.isInteger(value) || value < 0 || value > 100) throw fail(label + " must be an integer from 0 to 100.", "RUNWAY_INPUT_INVALID");
          return value;
        };
        const flavor = input.flavor ?? "natural";
        if (!["vivid", "natural"].includes(flavor)) throw fail("Video upscale flavor must be vivid or natural.", "RUNWAY_INPUT_INVALID");
        const creativity = bounded(input.creativity, "Creativity");
        const sharpen = bounded(input.sharpen, "Sharpen");
        const smartGrain = bounded(input.smartGrain, "Smart grain");
        const submitted = await request("/video_upscale", {
          method: "POST", submission: true,
          body: {
            model: selectedModel, videoUri: input.videoUri, resolution, flavor,
            ...(creativity !== undefined ? { creativity } : {}),
            ...(sharpen !== undefined ? { sharpen } : {}),
            ...(smartGrain !== undefined ? { smartGrain } : {}),
            ...(typeof input.fpsBoost === "boolean" ? { fpsBoost: input.fpsBoost } : {})
          }
        });
        return { taskId: taskId(submitted.id), status: "queued" };
      }
      if (selectedModel === "aleph2") {
        if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 1000) {
          throw fail("Video-edit prompts must contain 1 to 1,000 characters.", "RUNWAY_INPUT_INVALID");
        }
        if (input.operation !== "video-to-video" || !isRunwayUri(input.videoUri)) {
          throw fail("Aleph2 requires a prepared video-to-video source upload.", "RUNWAY_INPUT_INVALID");
        }
        const keyframes = Array.isArray(input.keyframes) ? input.keyframes : [];
        if (keyframes.length > 5 || keyframes.some((frame, index) =>
          !isRunwayUri(frame?.uri) || !Number.isFinite(frame.at) || frame.at < 0 || frame.at > 30 ||
          (index > 0 && frame.at <= keyframes[index - 1].at))) {
          throw fail("Video-edit keyframes must be ordered, valid Runway uploads (maximum five).", "RUNWAY_INPUT_INVALID");
        }
        const submitted = await request("/video_to_video", {
          method: "POST", submission: true,
          body: {
            model: selectedModel, videoUri: input.videoUri, promptText: input.prompt.trim(),
            ...(keyframes.length ? { keyframes } : {}), outputFormat: "mp4"
          }
        });
        return { taskId: taskId(submitted.id), status: "queued" };
      }
      if (input.operation && !["text-to-video", "image-to-video"].includes(input.operation)) {
        throw fail("The selected Runway model does not support this operation.", "RUNWAY_INPUT_INVALID");
      }
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 1000) {
        throw fail("Runway Gen-4.5 requires a prompt of 1 to 1,000 characters.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      const ratio = RATIOS[input.aspectRatio || "16:9"];
      if (!ratio) throw fail("Runway aspect ratio is not supported by the Gen-4.5 text-to-video contract.", "RUNWAY_INPUT_INVALID");
      const duration = input.durationSeconds === undefined ? 5 : input.durationSeconds;
      if (![5, 10].includes(duration)) throw fail("Runway Gen-4.5 duration must be 5 or 10 seconds.", "RUNWAY_INPUT_INVALID");
      if (input.referenceAssetIds?.length || input.referenceImageDataUrl) {
        throw fail("Runway text-to-video does not accept unresolved reference media.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      const imageToVideo = input.operation === "image-to-video" || Boolean(input.startFrameAssetId);
      if (imageToVideo && !isRunwayUri(input.promptImageUri)) {
        throw fail("Gen-4.5 image-to-video requires a prepared Runway first-frame upload.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      const submitted = await request(imageToVideo ? "/image_to_video" : "/text_to_video", {
        method: "POST",
        submission: true,
        body: {
          model: selectedModel,
          promptText: input.prompt.trim(),
          ...(imageToVideo ? { promptImage: input.promptImageUri } : {}),
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
