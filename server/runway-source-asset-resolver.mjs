import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VIDEO_TYPES = new Set([
  "video/mp4", "video/quicktime", "video/webm", "video/x-matroska",
  "video/3gpp", "video/ogg", "video/x-msvideo", "video/x-flv", "video/mpeg"
]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/wav", "audio/wave", "audio/x-wav", "audio/aac", "audio/x-aac", "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac"]);
const SEEDANCE_AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/wave", "audio/x-wav", "audio/aac", "audio/x-aac", "audio/flac", "audio/x-flac"]);
const fail = (message, code) => Object.assign(new Error(message), { code });

function parseRate(value) {
  const match = String(value || "").match(/^(\d+)\/(\d+)$/);
  if (!match || Number(match[2]) === 0) return null;
  const rate = Number(match[1]) / Number(match[2]);
  return Number.isFinite(rate) && rate > 0 && rate <= 240 ? rate : null;
}

export function createRunwaySourceAssetResolver({
  assets,
  fetchImpl = globalThis.fetch,
  supabaseUrl = process.env.SUPABASE_URL,
  storageProvider = process.env.CLOUD_MEDIA_STORAGE_PROVIDER || "supabase",
  r2AccountId = process.env.R2_ACCOUNT_ID,
  r2Bucket = process.env.R2_BUCKET || "executive-visuals-media",
  b2Region = process.env.B2_REGION,
  b2Bucket = process.env.B2_BUCKET || "executive-visuals-media",
  neonEndpoint = process.env.NEON_STORAGE_ENDPOINT,
  neonBucket = process.env.NEON_STORAGE_BUCKET || "executive-visuals-media",
  ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
  execFileImpl = execFile,
  maxBytes = 200 * 1024 * 1024,
  timeoutMs = 30000
} = {}) {
  if (!assets || typeof assets.get !== "function" || typeof assets.createSignedUrl !== "function") {
    throw new Error("Runway source resolver requires the authorized private cloud asset repository.");
  }
  if (typeof fetchImpl !== "function" || typeof execFileImpl !== "function") throw new Error("Runway source resolver requires fetch and ffprobe execution.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 500 * 1024 * 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Runway source resolver limits are invalid.");
  let expectedOrigin, expectedPathPrefix;
  try {
    if (String(storageProvider).toLowerCase() === "r2") {
      if (!/^[a-f0-9]{32}$/i.test(String(r2AccountId || "")) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(r2Bucket))) throw new Error();
      expectedOrigin = "https://" + r2AccountId + ".r2.cloudflarestorage.com";
      expectedPathPrefix = "/" + r2Bucket + "/";
    } else if (String(storageProvider).toLowerCase() === "b2") {
      if (!/^[a-z0-9]+-[a-z0-9]+-\d{3}$/.test(String(b2Region || "")) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(b2Bucket))) throw new Error();
      expectedOrigin = "https://s3." + b2Region + ".backblazeb2.com";
      expectedPathPrefix = "/" + b2Bucket + "/";
    } else if (String(storageProvider).toLowerCase() === "neon") {
      const base = new URL(neonEndpoint);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
          !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(String(neonBucket || ""))) throw new Error();
      expectedOrigin = base.origin;
      expectedPathPrefix = "/" + neonBucket + "/";
    } else {
      const base = new URL(supabaseUrl);
      if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error();
      expectedOrigin = base.origin;
      expectedPathPrefix = "/storage/v1/object/sign/";
    }
  } catch { throw new Error("Runway source resolver requires a safe private-storage origin."); }

  async function resolveAsset({ ownerId, projectId = null, assetId, kinds = "video" } = {}) {
    if (typeof ownerId !== "string" || !ownerId || typeof assetId !== "string" || !assetId) {
      throw fail("A job owner and source asset ID are required.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
    }
    const asset = await assets.get({ ownerId, assetId });
    if (!asset || asset.id !== assetId || (asset.projectId || null) !== (projectId || null) ||
        asset.storageBucket !== "executive-visuals-media" ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes) {
      throw fail("Source asset is not available in this job's exact owner/project scope.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
    }
    const allowed = kinds === "image" ? IMAGE_TYPES : kinds === "audio" ? AUDIO_TYPES : VIDEO_TYPES;
    if (!allowed.has(asset.mediaType)) throw fail("Source asset media type is not supported for this operation.", "VIDEO_INPUT_ASSET_TYPE_INVALID");
    const signed = await assets.createSignedUrl({ ownerId, assetId, expiresIn: 300 });
    if (!signed?.asset || signed.asset.id !== assetId ||
        (signed.asset.projectId || null) !== (asset.projectId || null) ||
        signed.asset.objectPath !== asset.objectPath ||
        signed.asset.storageBucket !== "executive-visuals-media") {
      throw fail("Private source signing returned a mismatched asset record.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
    }
    let url;
    try { url = new URL(signed.url); } catch { throw fail("Private source signing returned an invalid URL.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"); }
    if (url.origin !== expectedOrigin || url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.pathname.startsWith(expectedPathPrefix) || url.username || url.password || url.hash) {
      throw fail("Private source signing returned an untrusted storage URL.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
    }
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw fail("Private source asset download failed.", "VIDEO_INPUT_ASSET_DOWNLOAD_FAILED");
    }
    if (!response.ok) throw fail("Private source asset download failed.", "VIDEO_INPUT_ASSET_DOWNLOAD_FAILED");
    const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const declared = Number(response.headers.get("content-length") || 0);
    if (type !== asset.mediaType || declared > maxBytes || (declared && declared !== asset.size)) {
      throw fail("Private source asset headers do not match stored metadata.", "VIDEO_INPUT_ASSET_INTEGRITY_FAILED");
    }
    // Stream with a hard byte ceiling. Do not call arrayBuffer() on an
    // untrusted storage response: a missing/false Content-Length must not let
    // a compromised endpoint allocate an unbounded buffer in the API worker.
    const reader = response.body?.getReader?.();
    if (!reader) {
      throw fail("Private source asset response is not stream-readable.", "VIDEO_INPUT_ASSET_DOWNLOAD_FAILED");
    }
    const chunks = [];
    let totalBytes = 0;
    const byteLimit = Math.min(maxBytes, asset.size);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > byteLimit) {
          await reader.cancel().catch(() => {});
          throw fail("Private source asset exceeded its stored byte limit.", "VIDEO_INPUT_ASSET_INTEGRITY_FAILED");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error?.code === "VIDEO_INPUT_ASSET_INTEGRITY_FAILED") throw error;
      throw fail("Private source asset download failed while streaming.", "VIDEO_INPUT_ASSET_DOWNLOAD_FAILED");
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    if (bytes.length !== asset.size || bytes.length > maxBytes) {
      throw fail("Private source asset size does not match its stored record.", "VIDEO_INPUT_ASSET_INTEGRITY_FAILED");
    }
    return { asset, bytes, url: url.toString() };
  }

  async function probeVideo(bytes) {
    const dir = await mkdtemp(join(tmpdir(), "ev-runway-probe-"));
    const file = join(dir, "source-video");
    try {
      await writeFile(file, bytes, { flag: "wx" });
      const output = await new Promise((resolve, reject) => {
        execFileImpl(ffprobePath, [
          "-v", "error", "-count_frames", "-show_entries",
          "format=duration:stream=codec_type,width,height,nb_read_frames,nb_frames,r_frame_rate,avg_frame_rate,color_transfer,color_primaries,color_space",
          "-of", "json", file
        ], { timeout: Math.min(timeoutMs, 20000), maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) reject(error); else resolve(stdout);
        });
      });
      const parsed = JSON.parse(String(output));
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const video = streams.find(stream => stream.codec_type === "video");
      const durationSeconds = Number(parsed?.format?.duration);
      const width = Number(video?.width), height = Number(video?.height);
      const frameRate = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate);
      let frameCount = Number(video?.nb_read_frames || video?.nb_frames);
      if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
        frameCount = frameRate ? Math.ceil(frameRate * durationSeconds) : NaN;
      }
      if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30 ||
          !Number.isInteger(width) || width < 16 || width > 8192 ||
          !Number.isInteger(height) || height < 16 || height > 8192 ||
          !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 100000) {
        throw fail("Source video metadata failed server-side media validation.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
      }
      const transfer = String(video.color_transfer || "").toLowerCase();
      return Object.freeze({
        durationSeconds, frameCount, frameRate, width, height,
        sourceWidth: width, sourceHeight: height,
        sourceDynamicRange: ["smpte2084", "arib-std-b67"].includes(transfer) ? "hdr" : "sdr",
        colorTransfer: transfer || "unknown",
        colorPrimaries: String(video.color_primaries || "").slice(0, 40),
        colorSpace: String(video.color_space || "").slice(0, 40)
      });
    } catch (error) {
      if (error?.code === "VIDEO_INPUT_ASSET_PROBE_INVALID") throw error;
      throw fail("Source video could not be probed by the server.", "VIDEO_INPUT_ASSET_PROBE_FAILED");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function probeAudioDuration(bytes) {
    const dir = await mkdtemp(join(tmpdir(), "ev-runway-audio-probe-"));
    const file = join(dir, "reference-audio");
    try {
      await writeFile(file, bytes, { flag: "wx" });
      const output = await new Promise((resolve, reject) => {
        execFileImpl(ffprobePath, [
          "-v", "error", "-show_entries", "format=duration",
          "-of", "json", file
        ], { timeout: Math.min(timeoutMs, 20000), maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) reject(error); else resolve(stdout);
        });
      });
      const duration = Number(JSON.parse(String(output))?.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 30) {
        throw fail("Each Seedance reference audio clip must be no longer than 30 seconds.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
      }
      return duration;
    } catch (error) {
      if (error?.code === "VIDEO_INPUT_ASSET_PROBE_INVALID") throw error;
      throw fail("Seedance reference audio could not be probed by the server.", "VIDEO_INPUT_ASSET_PROBE_FAILED");
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return Object.freeze({
    async prepare(input, context = {}) {
      const job = context.job || {};
      const ownerId = job.owner_id;
      const projectId = input?.projectId || null;
      if (input?.model === "seedance2_5" && ["text-to-video", "image-to-video"].includes(input?.operation)) {
        const imageIds = input.referenceImageAssetIds ?? input.referenceAssetIds ?? [];
        const videoIds = input.referenceVideoAssetIds ?? [];
        const audioIds = input.referenceAudioAssetIds ?? (input.referenceAudioAssetId ? [input.referenceAudioAssetId] : []);
        const imageReferenceMode = input.operation === "image-to-video" &&
          !input.startFrameAssetId && !input.endFrameAssetId;
        if (!Array.isArray(imageIds) || imageIds.length > 30 || new Set(imageIds).size !== imageIds.length ||
            imageReferenceMode && imageIds.length === 0) {
          throw fail("Seedance 2.5 reference mode requires 1–30 distinct owner-scoped image references.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        if (!Array.isArray(videoIds) || videoIds.length > 10 || new Set(videoIds).size !== videoIds.length ||
            videoIds.length > 0 && input.operation !== "text-to-video") {
          throw fail("Seedance 2.5 accepts up to 10 distinct video references in text-to-video mode only.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        if (!Array.isArray(audioIds) || audioIds.length > 10 || new Set(audioIds).size !== audioIds.length) {
          throw fail("Seedance 2.5 accepts at most 10 distinct owner-scoped audio references.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        if (imageReferenceMode && audioIds.length && !String(input.prompt || "").trim()) {
          throw fail("Seedance image-to-video reference audio requires prompt text.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        }
        if (imageReferenceMode && (input.startFrameAssetId || input.endFrameAssetId)) {
          throw fail("Seedance reference images cannot be mixed with first/last keyframes.", "VIDEO_INPUT_KEYFRAMES_INVALID");
        }
        let firstFrame = null;
        let lastFrame = null;
        if (input.operation === "image-to-video" && !imageReferenceMode) {
          if (!input.startFrameAssetId || imageIds.length || audioIds.length) {
            throw fail("Seedance keyframe mode requires a first frame and cannot be mixed with reference images or audio.", "VIDEO_INPUT_KEYFRAMES_INVALID");
          }
          if (input.endFrameAssetId && input.endFrameAssetId === input.startFrameAssetId) {
            throw fail("Seedance first and last keyframes must be distinct assets.", "VIDEO_INPUT_KEYFRAMES_INVALID");
          }
          const first = await resolveAsset({ ownerId, projectId, assetId: input.startFrameAssetId, kinds: "image" });
          firstFrame = { buffer: first.bytes, filename: first.asset.name, mimeType: first.asset.mediaType };
          if (input.endFrameAssetId) {
            const last = await resolveAsset({ ownerId, projectId, assetId: input.endFrameAssetId, kinds: "image" });
            lastFrame = { buffer: last.bytes, filename: last.asset.name, mimeType: last.asset.mediaType };
          }
        }
        const referenceImages = [];
        for (const assetId of imageIds) {
          const image = await resolveAsset({ ownerId, projectId, assetId, kinds: "image" });
          referenceImages.push({ buffer: image.bytes, filename: image.asset.name, mimeType: image.asset.mediaType });
        }
        const referenceAudio = [];
        for (const assetId of audioIds) {
          const audio = await resolveAsset({ ownerId, projectId, assetId, kinds: "audio" });
          if (!SEEDANCE_AUDIO_TYPES.has(audio.asset.mediaType)) {
            throw fail("Seedance reference audio must use a documented MP3, WAV, M4A, AAC or FLAC media type.", "VIDEO_INPUT_ASSET_TYPE_INVALID");
          }
          await probeAudioDuration(audio.bytes);
          referenceAudio.push({ buffer: audio.bytes, filename: audio.asset.name, mimeType: audio.asset.mediaType });
        }
        if (input.operation === "text-to-video" && !referenceImages.length && !referenceAudio.length && !String(input.prompt || "").trim()) {
          throw fail("Seedance text-to-video requires a prompt or at least one image/audio reference.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        }
        const referenceVideos = [];
        let referenceVideoSeconds = 0;
        for (const assetId of videoIds) {
          const video = await resolveAsset({ ownerId, projectId, assetId, kinds: "video" });
          const metadata = await probeVideo(video.bytes);
          if (metadata.durationSeconds < 2 || Math.min(metadata.width, metadata.height) < 480) {
            throw fail("Seedance reference videos must be at least 2 seconds long and at least 480p.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
          }
          const billableDurationSeconds = metadata.durationSeconds < 4 ? 4.25 : metadata.durationSeconds;
          referenceVideoSeconds += billableDurationSeconds;
          referenceVideos.push({
            buffer: video.bytes, filename: video.asset.name, mimeType: video.asset.mediaType,
            durationSeconds: metadata.durationSeconds, billableDurationSeconds
          });
        }
        if (referenceVideoSeconds > 30) {
          throw fail("Seedance reference videos exceed the combined 30-second billable input limit.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
        }
        return {
          ...input, referenceImages, referenceAudio,
          ...(referenceVideos.length ? { referenceVideos, referenceVideoSeconds } : {}),
          ...(imageReferenceMode ? { imageReferenceMode: true } : {}),
          ...(firstFrame ? { firstFrame } : {}),
          ...(lastFrame ? { lastFrame } : {})
        };
      }
      if (input?.model === "model-router") {
        const referenceImages = [];
        const firstFrameId = input.startFrameAssetId || null;
        if (firstFrameId) {
          const first = await resolveAsset({ ownerId, projectId, assetId: firstFrameId, kinds: "image" });
          referenceImages.push({ uri: first.url, role: "first" });
        }
        const imageIds = input.referenceImageAssetIds || input.referenceAssetIds || [];
        if (!Array.isArray(imageIds) || imageIds.length > (firstFrameId ? 3 : 4) ||
            new Set(imageIds).size !== imageIds.length || firstFrameId && imageIds.includes(firstFrameId)) {
          throw fail("Runway Model Router accepts at most four owner-scoped reference images including the first frame.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        for (const assetId of imageIds) {
          const image = await resolveAsset({ ownerId, projectId, assetId, kinds: "image" });
          referenceImages.push({ uri: image.url, role: "reference" });
        }
        const sourceVideoId = input.sourceVideoAssetId || null;
        const videoIds = input.referenceVideoAssetIds || [];
        if (!Array.isArray(videoIds) || videoIds.length > (sourceVideoId ? 1 : 2) ||
            new Set(videoIds).size !== videoIds.length || sourceVideoId && videoIds.includes(sourceVideoId)) {
          throw fail("Runway Model Router accepts one source video and at most one distinct reference video.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        const referenceVideos = [];
        if (sourceVideoId) {
          if (input.operation !== "video-to-video") {
            throw fail("A source video is only valid for the video-to-video operation.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
          }
          const source = await resolveAsset({ ownerId, projectId, assetId: sourceVideoId, kinds: "video" });
          referenceVideos.push({ uri: source.url, role: "source" });
        } else if (input.operation === "video-to-video") {
          throw fail("Video-to-video requires an owner-scoped source video asset.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        for (const assetId of videoIds) {
          const video = await resolveAsset({ ownerId, projectId, assetId, kinds: "video" });
          referenceVideos.push({ uri: video.url, role: "reference" });
        }
        const audioIds = input.referenceAudioAssetIds || (input.referenceAudioAssetId ? [input.referenceAudioAssetId] : []);
        if (!Array.isArray(audioIds) || audioIds.length > 1) {
          throw fail("Runway Model Router accepts at most one owner-scoped reference audio asset.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        const referenceAudio = [];
        for (const assetId of audioIds) {
          const audio = await resolveAsset({ ownerId, projectId, assetId, kinds: "audio" });
          referenceAudio.push({ uri: audio.url });
        }
        if (input.audioMode === "reference" && referenceAudio.length !== 1) {
          throw fail("Reference audio mode requires exactly one owner-scoped audio asset.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
        }
        return {
          ...input,
          ...(referenceImages.length ? { referenceImages } : {}),
          ...(referenceVideos.length ? { referenceVideos } : {}),
          ...(referenceAudio.length ? { referenceAudio } : {})
        };
      }
      if (input?.operation === "image-to-video" || input?.startFrameAssetId || input?.endFrameAssetId) {
        const firstFrameId = input.startFrameAssetId || null;
        const lastFrameId = input.endFrameAssetId || null;
        if (!firstFrameId) throw fail("Image-to-video requires an owner-scoped first-frame asset.", "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
        if (lastFrameId && lastFrameId === firstFrameId) throw fail("First and last frame assets must be distinct.", "VIDEO_INPUT_KEYFRAMES_INVALID");
        const first = await resolveAsset({ ownerId, projectId, assetId: firstFrameId, kinds: "image" });
        const prepared = {
          firstFrame: { buffer: first.bytes, filename: first.asset.name, mimeType: first.asset.mediaType }
        };
        if (lastFrameId) {
          const last = await resolveAsset({ ownerId, projectId, assetId: lastFrameId, kinds: "image" });
          prepared.lastFrame = { buffer: last.bytes, filename: last.asset.name, mimeType: last.asset.mediaType };
        }
        return prepared;
      }
      if (["video-to-video", "video-upscale", "video-to-hdr"].includes(input?.operation)) {
        const resolved = await resolveAsset({ ownerId, projectId, assetId: input.sourceVideoAssetId, kinds: "video" });
        const needsSourceMetadata = ["seedance2_5", "kling_4"].includes(String(input.model || ""));
        const sourceMetadata = needsSourceMetadata ? await probeVideo(resolved.bytes) : null;
        const prepared = {
          sourceVideo: { buffer: resolved.bytes, filename: resolved.asset.name, mimeType: resolved.asset.mediaType },
          ...(sourceMetadata ? { sourceMetadata } : {})
        };
        if (Array.isArray(input.keyframes) && input.keyframes.length) {
          if (input.operation !== "video-to-video" || input.keyframes.length > 5) {
            throw fail("Timestamped keyframes are supported only for video-to-video and are limited to five.", "VIDEO_INPUT_KEYFRAMES_INVALID");
          }
          prepared.keyframes = [];
          let previousAt = -1;
          for (const frame of input.keyframes) {
            if (!Number.isFinite(frame?.at) || frame.at <= previousAt || frame.at > 30) {
              throw fail("Video edit keyframe timestamps must be strictly increasing and within the source window.", "VIDEO_INPUT_KEYFRAMES_INVALID");
            }
            previousAt = frame.at;
            const image = await resolveAsset({ ownerId, projectId, assetId: frame.assetId, kinds: "image" });
            prepared.keyframes.push({
              buffer: image.bytes, filename: image.asset.name,
              mimeType: image.asset.mediaType, at: frame.at
            });
          }
        }
        return prepared;
      }
      return input;
    },
    async resolveMetadata({ ownerId, projectId = null, assetId } = {}) {
      const resolved = await resolveAsset({ ownerId, projectId, assetId, kinds: "video" });
      const metadata = await probeVideo(resolved.bytes);
      return {
        ownerId,
        projectId,
        assetId,
        mediaType: resolved.asset.mediaType,
        ...metadata
      };
    },
    async resolveReferenceVideoMetadata({ ownerId, projectId = null, assetIds } = {}) {
      if (!Array.isArray(assetIds) || assetIds.length > 10 || new Set(assetIds).size !== assetIds.length) {
        throw fail("Seedance accepts up to 10 distinct reference videos.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
      }
      const videos = [];
      let totalBillableDurationSeconds = 0;
      for (const assetId of assetIds) {
        const resolved = await resolveAsset({ ownerId, projectId, assetId, kinds: "video" });
        const metadata = await probeVideo(resolved.bytes);
        if (metadata.durationSeconds < 2 || Math.min(metadata.width, metadata.height) < 480) {
          throw fail("Seedance reference videos must be at least 2 seconds long and at least 480p.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
        }
        const billableDurationSeconds = metadata.durationSeconds < 4 ? 4.25 : metadata.durationSeconds;
        totalBillableDurationSeconds += billableDurationSeconds;
        videos.push(Object.freeze({
          ownerId, projectId, assetId, mediaType: resolved.asset.mediaType,
          durationSeconds: metadata.durationSeconds, billableDurationSeconds
        }));
      }
      if (totalBillableDurationSeconds > 30) {
        throw fail("Seedance reference videos exceed the combined 30-second billable input limit.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
      }
      return Object.freeze({ ownerId, projectId, videos: Object.freeze(videos), totalBillableDurationSeconds });
    }
  });
}
