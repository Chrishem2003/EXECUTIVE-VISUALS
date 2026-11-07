import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
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
  let expectedOrigin;
  try {
    const base = new URL(supabaseUrl);
    if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error();
    expectedOrigin = base.origin;
  } catch { throw new Error("Runway source resolver requires a safe Supabase origin."); }

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
    const allowed = kinds === "image" ? IMAGE_TYPES : VIDEO_TYPES;
    if (!allowed.has(asset.mediaType)) throw fail("Source asset media type is not supported for this operation.", "VIDEO_INPUT_ASSET_TYPE_INVALID");
    const signed = await assets.createSignedUrl({ ownerId, assetId, expiresIn: 300 });
    if (!signed?.asset || signed.asset.id !== assetId || signed.asset.objectPath !== asset.objectPath ||
        signed.asset.storageBucket !== "executive-visuals-media") {
      throw fail("Private source signing returned a mismatched asset record.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED");
    }
    let url;
    try { url = new URL(signed.url); } catch { throw fail("Private source signing returned an invalid URL.", "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"); }
    if (url.origin !== expectedOrigin || url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.pathname.startsWith("/storage/v1/object/sign/") || url.username || url.password || url.hash) {
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
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size || bytes.length > maxBytes) {
      throw fail("Private source asset size does not match its stored record.", "VIDEO_INPUT_ASSET_INTEGRITY_FAILED");
    }
    return { asset, bytes };
  }

  async function probeVideo(bytes) {
    const dir = await mkdtemp(join(tmpdir(), "ev-runway-probe-"));
    const file = join(dir, "source-video");
    try {
      await writeFile(file, bytes, { flag: "wx" });
      const output = await new Promise((resolve, reject) => {
        execFileImpl(ffprobePath, [
          "-v", "error", "-count_frames", "-show_entries",
          "format=duration:stream=codec_type,width,height,nb_read_frames,nb_frames,r_frame_rate,color_transfer,color_primaries,color_space",
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
      let frameCount = Number(video?.nb_read_frames || video?.nb_frames);
      if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
        const rate = parseRate(video?.r_frame_rate);
        frameCount = rate ? Math.ceil(rate * durationSeconds) : NaN;
      }
      if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30 ||
          !Number.isInteger(width) || width < 16 || width > 8192 ||
          !Number.isInteger(height) || height < 16 || height > 8192 ||
          !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 100000) {
        throw fail("Source video metadata failed server-side media validation.", "VIDEO_INPUT_ASSET_PROBE_INVALID");
      }
      const transfer = String(video.color_transfer || "").toLowerCase();
      return Object.freeze({
        durationSeconds, frameCount, width, height,
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

  return Object.freeze({
    async prepare(input, context = {}) {
      const job = context.job || {};
      const ownerId = job.owner_id;
      const projectId = input?.projectId || null;
      if (input?.operation === "image-to-video" || input?.startFrameAssetId) {
        const resolved = await resolveAsset({ ownerId, projectId, assetId: input.startFrameAssetId, kinds: "image" });
        return { firstFrame: { buffer: resolved.bytes, filename: resolved.asset.name, mimeType: resolved.asset.mediaType } };
      }
      if (["video-to-video", "video-upscale", "video-to-hdr"].includes(input?.operation)) {
        const resolved = await resolveAsset({ ownerId, projectId, assetId: input.sourceVideoAssetId, kinds: "video" });
        return { sourceVideo: { buffer: resolved.bytes, filename: resolved.asset.name, mimeType: resolved.asset.mediaType } };
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
    }
  });
}
