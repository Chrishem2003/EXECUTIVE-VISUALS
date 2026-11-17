import { buildRunwayVideoPayload, buildRunwayImageToVideoPayload } from "./runway-video-gateway.mjs";

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
  assertActualCostReady,
  timeoutMs = 30000
} = {}) {
  const selectedModel = String(model || "").trim();
  if (!["gen4.5", "seedance2_5", "kling_4", "kling_4_flash", "kling3.0_standard", "kling3.0_pro", "kling3.0_4k", "gemini_omni_flash_1.2", "aleph2", "magnific_video_upscaler_creative", "ruby", "veo3.1", "veo3.1_fast"].includes(selectedModel)) {
    throw fail("This Runway cloud adapter supports only verified Gen-4.5, Seedance, Kling, Gemini Omni, Veo 3.1, Aleph2, Magnific and Ruby profiles.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
  }
  const key = String(apiKey || "").trim();
  if (typeof fetchImpl !== "function") throw new Error("Runway cloud adapter requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Runway timeout is invalid.");
  if (typeof ingestOutputs !== "function" || typeof resolveActualCost !== "function") {
    throw fail("Runway cloud adapter requires private output ingestion and an authoritative task-level billing resolver.", "RUNWAY_EXECUTION_GATES_MISSING");
  }
  if ((selectedModel === "veo3.1" || selectedModel === "veo3.1_fast") && typeof assertActualCostReady !== "function") {
    throw fail("Veo execution requires a live Enterprise task-billing readiness check before provider submission.", "RUNWAY_EXECUTION_GATES_MISSING");
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

  function buildVeoRequest(input) {
    if (!input || input.provider !== "runway" || input.model !== selectedModel) throw fail("Veo job identity does not match the selected adapter.", "VIDEO_JOB_INPUT_MISMATCH");
    if (input.operation && !["text-to-video", "image-to-video"].includes(input.operation)) throw fail("Veo supports only text-to-video and image-to-video operations.", "RUNWAY_INPUT_INVALID");
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt.length > 1000) throw fail("Veo prompts are limited to 1,000 characters.", "RUNWAY_INPUT_INVALID");
    const imageToVideo = input.operation === "image-to-video" || input.promptImage !== undefined;
    if (!prompt && !imageToVideo) throw fail("Veo text-to-video requires a prompt.", "RUNWAY_INPUT_INVALID");
    const duration = input.durationSeconds;
    if (![4, 6, 8].includes(duration)) throw fail("Veo duration must be 4, 6 or 8 seconds.", "RUNWAY_INPUT_INVALID");
    const aspect = input.aspectRatio || "16:9";
    if (!["16:9", "9:16"].includes(aspect)) throw fail("Veo supports 16:9 or 9:16 aspect ratios.", "RUNWAY_INPUT_INVALID");
    const resolution = input.resolution || "720p";
    if (!["720p", "1080p"].includes(resolution)) throw fail("Veo resolution must be 720p or 1080p.", "RUNWAY_INPUT_INVALID");
    if (resolution === "1080p" && duration !== 8) throw fail("Veo 1080p output is available only for 8-second clips.", "RUNWAY_INPUT_INVALID");
    if (input.audio !== undefined && typeof input.audio !== "boolean") throw fail("Veo audio must be a boolean.", "RUNWAY_INPUT_INVALID");
    if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4294967295)) throw fail("Veo seed must be an unsigned 32-bit integer.", "RUNWAY_INPUT_INVALID");
    if (input.negativePrompt !== undefined && (typeof input.negativePrompt !== "string" || !input.negativePrompt.trim() || input.negativePrompt.length > 1000)) throw fail("Veo negative prompts must contain 1 to 1,000 characters.", "RUNWAY_INPUT_INVALID");
    let promptImage;
    if (imageToVideo) {
      promptImage = input.promptImage;
      if (typeof promptImage === "string") promptImage = [{ uri: promptImage, position: "first" }];
      if (!Array.isArray(promptImage) || promptImage.length < 1 || promptImage.length > 2 ||
          promptImage.some(frame => !frame || !isRunwayUri(frame.uri) || !["first", "last"].includes(frame.position)) ||
          new Set(promptImage.map(frame => frame.position)).size !== promptImage.length ||
          !promptImage.some(frame => frame.position === "first")) {
        throw fail("Veo image-to-video requires one first frame and may include one last frame; last-frame-only requests are invalid.", "RUNWAY_INPUT_INVALID");
      }
    }
    const ratio = resolution === "1080p"
      ? (aspect === "16:9" ? "1920:1080" : "1080:1920")
      : (aspect === "16:9" ? "1280:720" : "720:1280");
    const body = {
      model: selectedModel,
      ...(prompt ? { promptText: prompt } : {}),
      ...(imageToVideo ? { promptImage } : {}),
      ratio, duration,
      ...(typeof input.audio === "boolean" ? { audio: input.audio } : {}),
      ...(input.negativePrompt ? { negativePrompt: input.negativePrompt.trim() } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {})
    };
    return Object.freeze({ endpoint: imageToVideo ? "/image_to_video" : "/text_to_video", body, duration, audio: input.audio !== false });
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
      const isVeo = selectedModel === "veo3.1" || selectedModel === "veo3.1_fast";
      const isImageToVideo = input.operation === "image-to-video" || Boolean(input.startFrameAssetId) || Boolean(input.endFrameAssetId);
      const hasReferences = (Array.isArray(input.referenceAssetIds) && input.referenceAssetIds.length > 0) ||
        Boolean(input.referenceImageDataUrl) || Boolean(input.sourceVideoAssetId) ||
        Boolean(input.startFrameAssetId) || Boolean(input.endFrameAssetId) ||
        (Array.isArray(input.keyframeAssetIds) && input.keyframeAssetIds.length > 0);
      if ((hasReferences || isVideoEdit || isVideoUpscale || isVideoHdr || isImageToVideo) && typeof prepareInput !== "function") {
        throw fail("Runway source and reference assets require an authenticated project-scoped input resolver.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      if (typeof prepareInput !== "function") return input;
      const prepared = await prepareInput(input, context);
      if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
        throw fail("Runway private input preparation returned an invalid payload.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
      }
      if (isVeo) {
        if (isImageToVideo) {
          let firstFrameUri = prepared.promptImageUri || prepared.firstFrameUri;
          let lastFrameUri = prepared.lastFrameUri;
          if (prepared.firstFrame) firstFrameUri = await uploadEphemeral(prepared.firstFrame);
          if (prepared.lastFrame) lastFrameUri = await uploadEphemeral(prepared.lastFrame);
          if (!isRunwayUri(firstFrameUri)) throw fail("Veo image-to-video requires an authorized first-frame upload.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
          if (input.endFrameAssetId && !isRunwayUri(lastFrameUri)) throw fail("Veo last-frame interpolation requires an authorized last-frame upload.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
          return { ...input, promptImage: [
            { uri: firstFrameUri, position: "first" },
            ...(lastFrameUri ? [{ uri: lastFrameUri, position: "last" }] : [])
          ] };
        }
        return input;
      }
      if (isImageToVideo) {
        if (!["gen4.5", "seedance2_5", "kling_4", "kling_4_flash", "kling3.0_standard", "kling3.0_pro", "kling3.0_4k", "gemini_omni_flash_1.2"].includes(selectedModel)) throw fail("The selected Runway model does not support the verified first-frame generation path.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
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
      if (selectedModel === "aleph2") return { ...input, videoUri, keyframes };
      const metadata = prepared.sourceMetadata;
      const sourceMetadata = metadata;
      if (!metadata || !Number.isFinite(metadata.durationSeconds) || !Number.isInteger(metadata.width) ||
          !Number.isInteger(metadata.height) || !Number.isFinite(metadata.frameRate)) {
        throw fail("Seedance and Kling video edits require probed source metadata before submission.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
      }
      if (selectedModel === "seedance2_5") {
        if (metadata.durationSeconds > 30 || Math.min(metadata.width, metadata.height) < 480) {
          throw fail("Seedance 2.5 source video must be at most 30 seconds and at least 480p.", "RUNWAY_INPUT_INVALID");
        }
        if (keyframes.length) throw fail("Seedance 2.5 video-to-video keyframe overlays are not supported by this worker path.", "RUNWAY_INPUT_INVALID");
        const mode = input.mode || "reference";
        if (!["reference", "extend", "edit"].includes(mode)) throw fail("Seedance 2.5 video mode must be reference, extend or edit.", "RUNWAY_INPUT_INVALID");
        if (mode === "edit" && input.duration !== "auto") throw fail("Seedance 2.5 edit mode requires duration='auto'.", "RUNWAY_INPUT_INVALID");
        return { ...input, videoUri, mode, sourceMetadata };
      }
      if (selectedModel === "kling_4") {
        const aspect = metadata.width / metadata.height;
        if (metadata.durationSeconds < 3 || metadata.durationSeconds > 30 ||
            Math.min(metadata.width, metadata.height) < 700 ||
            metadata.frameRate < 24 || metadata.frameRate > 60 || aspect < 0.4 || aspect > 2.5) {
          throw fail("Kling 4 source video must meet its duration, dimensions, frame-rate and aspect-ratio requirements.", "RUNWAY_INPUT_INVALID");
        }
        if (keyframes.length) throw fail("Kling 4 video-to-video does not accept this worker's timestamped keyframe payload.", "RUNWAY_INPUT_INVALID");
        return { ...input, videoUri, sourceMetadata };
      }
      if (selectedModel === "gemini_omni_flash_1.2") {
        const mode = input.mode || "reference";
        if (!["reference", "extend", "edit"].includes(mode)) throw fail("Gemini Omni 1.2 video mode must be reference, extend or edit.", "RUNWAY_INPUT_INVALID");
        const maxSourceSeconds = mode === "extend" ? 30 : 10;
        if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0 || metadata.durationSeconds > maxSourceSeconds || mode === "edit" && metadata.durationSeconds >= 10) {
          throw fail("Gemini Omni 1.2 reference sources must be at most 10 seconds, edit sources must be under 10 seconds, and extend sources must be at most 30 seconds.", "RUNWAY_INPUT_INVALID");
        }
        if (keyframes.length) throw fail("Gemini Omni 1.2 video-to-video does not accept timestamped keyframe uploads in this worker.", "RUNWAY_INPUT_INVALID");
        if (mode === "edit" && input.duration !== "auto") throw fail("Gemini Omni 1.2 edit mode requires duration='auto'.", "RUNWAY_INPUT_INVALID");
        if (mode === "extend" && input.duration !== "auto" && (!Number.isInteger(input.duration) || input.duration < 3 || input.duration > 15)) {
          throw fail("Gemini Omni 1.2 extend duration must be auto or 3–15 seconds.", "RUNWAY_INPUT_INVALID");
        }
        return { ...input, videoUri, mode, sourceMetadata };
      }
      if (selectedModel === "kling_4_flash") {
        const aspect = metadata.width / metadata.height;
        if (metadata.durationSeconds < 3 || metadata.durationSeconds > 21 ||
            Math.min(metadata.width, metadata.height) < 700 ||
            metadata.frameRate < 24 || metadata.frameRate > 60 || aspect < 0.4 || aspect > 2.5) {
          throw fail("Kling 4.0 Flash source video must be 3–21 seconds, at least 700px on each side, 24–60 fps and within 0.4–2.5 aspect ratio.", "RUNWAY_INPUT_INVALID");
        }
        if (keyframes.length) throw fail("Kling 4.0 Flash source editing does not accept this worker's timestamped keyframe payload.", "RUNWAY_INPUT_INVALID");
        return { ...input, videoUri, sourceMetadata };
      }
      throw fail("Video-to-video is not enabled for this Runway model profile.", "RUNWAY_ADAPTER_MODEL_UNSUPPORTED");
    },

    ...(selectedModel === "veo3.1" || selectedModel === "veo3.1_fast" ? {
      async preflight(input = {}) {
        // Run the exact model request validator during the non-billable quote
        // so invalid prompts, frame pairs, ratios, seeds and model identities
        // cannot be approved and fail only after the worker starts.
        const requestPlan = buildVeoRequest(input);
        const duration = requestPlan.duration;
        const audio = requestPlan.audio;
        const creditsPerSecond = selectedModel === "veo3.1"
          ? (audio ? 40 : 20)
          : (audio ? 15 : 10);
        const estimatedCredits = duration * creditsPerSecond;
        return Object.freeze({
          billable: false, provider: "runway", model: selectedModel,
          estimatedCredits, estimatedUsd: Number((estimatedCredits * 0.01).toFixed(2)), currency: "USD",
          pricingSource: "https://dev.runwayml.com/learn/veo-3-1-api",
          audio, durationSeconds: duration
        });
      }
    } : {}),

    async submit(input) {
      assertEnabled();
      if (!input || input.provider !== "runway" || input.model !== selectedModel) {
        throw fail("Runway job identity does not match the selected adapter.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      if (input.draft !== undefined && typeof input.draft !== "boolean") {
        throw fail("Draft mode must be an explicit boolean when supplied.", "RUNWAY_INPUT_INVALID");
      }
      if (input.draft === true && selectedModel !== "seedance2_5") {
        throw fail("Draft previews are supported only by Seedance 2.5.", "RUNWAY_INPUT_INVALID");
      }
      if (input.draft === true && input.resolution !== "480p") {
        throw fail("Seedance draft requests must explicitly reserve and select the 480p preview tier.", "RUNWAY_INPUT_INVALID");
      }
      if (input.draftTaskId !== undefined) {
        if (selectedModel !== "seedance2_5" || input.draft === true || input.resolution !== "1080p" ||
            typeof input.draftTaskId !== "string" || !UUID.test(input.draftTaskId) ||
            input.operation !== "text-to-video") {
          throw fail("Seedance draft enhancement requires a valid succeeded preview task, the 1080p tier and the text-to-video enhancement operation.", "RUNWAY_INPUT_INVALID");
        }
        const submitted = await request("/text_to_video", {
          method: "POST", submission: true,
          body: { model: "seedance2_5", draftTaskId: taskId(input.draftTaskId) }
        });
        return { taskId: taskId(submitted.id), status: "queued", metadata: { operation: "seedance-draft-enhancement", sourceDraftTaskId: input.draftTaskId } };
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
      if (input.operation === "video-to-video" && ["aleph2", "seedance2_5", "kling_4", "kling_4_flash", "gemini_omni_flash_1.2"].includes(selectedModel)) {
        const promptLimit = selectedModel === "seedance2_5" ? 15000 : ["kling_4", "kling_4_flash"].includes(selectedModel) ? 26000 : selectedModel === "gemini_omni_flash_1.2" ? 4000 : selectedModel.startsWith("kling3.0_") ? 2500 : 1000;
        const hasMultiPrompt = Array.isArray(input.multiPrompt) && input.multiPrompt.length > 0;
      if ((!hasMultiPrompt && (typeof input.prompt !== "string" || !input.prompt.trim())) || typeof input.prompt === "string" && input.prompt.length > promptLimit) {
          throw fail("Video-edit prompt is empty or exceeds the selected model's limit.", "RUNWAY_INPUT_INVALID");
        }
        if (!isRunwayUri(input.videoUri)) throw fail("Video-to-video requires a prepared private source upload.", "RUNWAY_INPUT_INVALID");
        let body;
        if (selectedModel === "aleph2") {
          const keyframes = Array.isArray(input.keyframes) ? input.keyframes : [];
          if (keyframes.length > 5 || keyframes.some((frame, index) =>
            !isRunwayUri(frame?.uri) || !Number.isFinite(frame.at) || frame.at < 0 || frame.at > 30 ||
            (index > 0 && frame.at <= keyframes[index - 1].at))) {
            throw fail("Video-edit keyframes must be ordered, valid Runway uploads (maximum five).", "RUNWAY_INPUT_INVALID");
          }
          body = { model: selectedModel, videoUri: input.videoUri, promptText: input.prompt.trim(),
            ...(keyframes.length ? { keyframes } : {}), outputFormat: "mp4" };
        } else if (selectedModel === "seedance2_5") {
          const mode = input.mode || "reference";
          if (input.draft === true && mode !== "reference") throw fail("Seedance draft previews are supported only in reference mode, not extend or edit mode.", "RUNWAY_INPUT_INVALID");
          if (input.draft === true && input.resolution !== "480p") throw fail("Seedance draft previews are fixed at 480p.", "RUNWAY_INPUT_INVALID");
          body = { model: selectedModel, videoUri: input.videoUri, promptText: input.prompt.trim(), mode,
            ...(input.draft === true ? { draft: true } : {}),
            ...(typeof input.audio === "boolean" ? { audio: input.audio } : {}) };
          if (mode === "reference") {
            const referencePayload = buildRunwayVideoPayload({
              model: selectedModel, prompt: String(input.prompt || "").trim(),
              durationSeconds: input.durationSeconds === undefined ? 5 : input.durationSeconds,
              aspectRatio: input.aspectRatio || "16:9",
              resolution: input.resolution || "provider_default", draft: input.draft === true
            });
            body = { ...body, duration: referencePayload.duration, ratio: referencePayload.ratio };
          } else if (mode === "extend") {
            const duration = input.duration !== undefined ? input.duration : input.durationSeconds === undefined ? "auto" : input.durationSeconds;
            if (duration !== "auto" && (!Number.isInteger(duration) || duration < 4 || duration > 30)) {
              throw fail("Seedance extend duration must be auto or 4–30 seconds.", "RUNWAY_INPUT_INVALID");
            }
            body.duration = duration;
          } else if (mode === "edit") {
            if (input.duration !== "auto") throw fail("Seedance edit mode requires duration='auto'.", "RUNWAY_INPUT_INVALID");
            body.duration = "auto";
          } else throw fail("Seedance video mode must be reference, extend or edit.", "RUNWAY_INPUT_INVALID");
        } else if (selectedModel === "kling_4_flash") {
          const duration = input.durationSeconds === undefined ? 5 : input.durationSeconds;
          if (!Number.isInteger(duration) || duration < 3 || duration > 20) {
            throw fail("Kling 4.0 Flash video edits require an output duration from 3 to 20 seconds.", "RUNWAY_INPUT_INVALID");
          }
          body = { model: selectedModel, videoUri: input.videoUri, promptText: input.prompt.trim(), duration };
        } else if (selectedModel === "gemini_omni_flash_1.2") {
          const mode = input.mode || "reference";
          body = { model: selectedModel, videoUri: input.videoUri, promptText: input.prompt.trim(), mode };
          if (mode === "reference") {
            const duration = input.durationSeconds === undefined ? 5 : input.durationSeconds;
            const resolution = input.resolution || "720p";
            const ratio = buildRunwayVideoPayload({
              model: selectedModel, prompt: input.prompt.trim(), durationSeconds: duration,
              aspectRatio: input.aspectRatio || "16:9", resolution
            });
            body.duration = duration;
            body.ratio = ratio.ratio;
          } else if (mode === "extend") {
            const duration = input.duration === undefined ? "auto" : input.duration;
            if (duration !== "auto" && (!Number.isInteger(duration) || duration < 3 || duration > 15)) {
              throw fail("Gemini Omni 1.2 extend duration must be auto or 3–15 seconds.", "RUNWAY_INPUT_INVALID");
            }
            body.duration = duration;
            body.resolution = input.resolution || "720p";
          } else if (mode === "edit") {
            if (input.duration !== "auto") throw fail("Gemini Omni 1.2 edit mode requires duration='auto'.", "RUNWAY_INPUT_INVALID");
            body.duration = "auto";
            body.resolution = input.resolution || "720p";
          } else {
            throw fail("Gemini Omni 1.2 video mode must be reference, extend or edit.", "RUNWAY_INPUT_INVALID");
          }
        } else {
          body = { model: selectedModel, videoUri: input.videoUri, promptText: input.prompt.trim() };
        }
        const submitted = await request("/video_to_video", { method: "POST", submission: true, body });
        return { taskId: taskId(submitted.id), status: "queued" };
      }
      if (selectedModel === "veo3.1" || selectedModel === "veo3.1_fast") {
        const requestPlan = buildVeoRequest(input);
        await assertActualCostReady();
        const submitted = await request(requestPlan.endpoint, { method: "POST", submission: true, body: requestPlan.body });
        return { taskId: taskId(submitted.id), status: "queued", metadata: { submittedAt: new Date().toISOString() } };
      }

      if (input.operation && !["text-to-video", "image-to-video"].includes(input.operation)) {
        throw fail("The selected Runway model does not support this operation.", "RUNWAY_INPUT_INVALID");
      }
      const promptLimit = selectedModel === "seedance2_5" ? 15000 : ["kling_4", "kling_4_flash"].includes(selectedModel) ? 26000 : selectedModel === "gemini_omni_flash_1.2" ? 4000 : selectedModel.startsWith("kling3.0_") ? 2500 : 1000;
      const hasMultiPrompt = Array.isArray(input.multiPrompt) && input.multiPrompt.length > 0;
      if ((!hasMultiPrompt && (typeof input.prompt !== "string" || !input.prompt.trim())) || typeof input.prompt === "string" && input.prompt.length > promptLimit) {
        throw fail("Runway prompt is empty or exceeds the selected model's limit.", "VIDEO_JOB_INPUT_MISMATCH");
      }
      if (input.referenceAssetIds?.length || input.referenceImageDataUrl) {
        throw fail("Reference collections require the dedicated Runway Model Router adapter.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
      }
      const imageToVideo = input.operation === "image-to-video" || Boolean(input.startFrameAssetId);
      let payload;
      if (imageToVideo) {
        if (!isRunwayUri(input.promptImageUri)) {
          throw fail("Image-to-video requires a prepared Runway first-frame upload.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        }
        // Reuse the direct gateway's model-specific validation and ratio mapping;
        // replace its validated placeholder with the private ephemeral upload URI.
        payload = {
          ...buildRunwayImageToVideoPayload({
            model: selectedModel,
            prompt: input.prompt.trim(),
            promptImage: "data:image/png;base64,AA==",
            durationSeconds: input.durationSeconds === undefined ? 5 : input.durationSeconds,
            aspectRatio: input.aspectRatio || "16:9",
            resolution: input.resolution || "provider_default", draft: input.draft === true,
            multiPrompt: input.multiPrompt,
            shotType: input.shotType || "customize"
          }),
          promptImage: input.promptImageUri
        };
      } else {
        payload = buildRunwayVideoPayload({
          model: selectedModel,
          prompt: input.prompt.trim(),
          durationSeconds: input.durationSeconds === undefined ? 5 : input.durationSeconds,
          aspectRatio: input.aspectRatio || "16:9",
          resolution: input.resolution || "provider_default", draft: input.draft === true,
          multiPrompt: input.multiPrompt,
          shotType: input.shotType || "customize"
        });
      }
      if (typeof input.audio === "boolean" && ["seedance2_5", "kling3.0_standard", "kling3.0_pro", "kling3.0_4k"].includes(selectedModel)) {
        payload = { ...payload, audio: input.audio };
      }
      const submitted = await request(imageToVideo ? "/image_to_video" : "/text_to_video", {
        method: "POST",
        submission: true,
        body: payload
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
