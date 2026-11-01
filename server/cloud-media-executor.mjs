import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { buildMediaOperationArgs, executableAvailable } from "./media.mjs";

const EXTENSION = Object.freeze({
  "image/jpeg": "jpg", "audio/mpeg": "mp3", "audio/wav": "wav", "video/mp4": "mp4"
});
const SUPPORTED = new Set([
  "media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean",
  "media.denoise", "media.color", "media.resize", "media.interpolate",
  "media.upscale", "media.transcode", "media.proxy"
]);

function parseInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw Object.assign(new Error("Cloud media job input is invalid."), { code: "INVALID_JOB_INPUT" });
  }
}

function runProcess(binary, args, { signal, timeoutMs = 30 * 60 * 1000, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" }));
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => {
      if (!child.killed) child.kill("SIGTERM");
      const killTimer = setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
      killTimer.unref?.();
      finish(Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" }));
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      finish(Object.assign(new Error("Media operation timed out."), { code: "MEDIA_TIMEOUT" }));
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-16000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.on("error", error => finish(Object.assign(new Error("Media engine could not start."), { code: "MEDIA_ENGINE_MISSING", cause: error })));
    child.on("close", code => code === 0
      ? finish(null, { stdout, stderr })
      : finish(Object.assign(new Error((stderr || "Media operation failed.").slice(-3000)), { code: "MEDIA_PROCESS_FAILED" })));
    onProgress(10);
  });
}

async function checksum(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); }
  }), new Transform({ transform(chunk, encoding, callback) { callback(); } }));
  return hash.digest("hex");
}

function outputPlan(jobType, input, source, sourcePath, outputPath) {
  const baseName = String(source.name || "media").replace(/\.[^.]+$/, "").slice(0, 140);
  if (jobType === "media.thumbnail") {
    const seconds = Number(input.seconds ?? 1);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw Object.assign(new Error("Thumbnail time is outside the supported range."), { code: "INVALID_MEDIA_OPTIONS" });
    return { args: ["-hide_banner", "-y", "-ss", String(seconds), "-i", sourcePath, "-frames:v", "1", "-q:v", "2", outputPath], name: baseName + "-thumbnail.jpg", mediaType: "image/jpeg" };
  }
  if (jobType === "media.audio_extract") {
    return { args: ["-hide_banner", "-y", "-i", sourcePath, "-vn", "-c:a", "libmp3lame", "-q:a", "2", outputPath], name: baseName + "-audio.mp3", mediaType: "audio/mpeg" };
  }
  if (jobType === "media.audio-clean" || ["media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale"].includes(jobType)) {
    const isAudio = jobType === "media.audio-clean";
    if (isAudio !== String(source.mediaType).startsWith("audio/") || (!isAudio && !String(source.mediaType).startsWith("video/"))) {
      throw Object.assign(new Error("The selected media operation does not support this source type."), { code: "UNSUPPORTED_MEDIA_TYPE" });
    }
    const extension = isAudio ? "wav" : "mp4";
    return {
      args: buildMediaOperationArgs({ jobType, input, sourcePath, outputPath }),
      name: baseName + "-" + jobType.split(".")[1] + "." + extension,
      mediaType: isAudio ? "audio/wav" : "video/mp4"
    };
  }
  if (jobType === "media.proxy" || jobType === "media.transcode") {
    const container = String(jobType === "media.proxy" ? "mp4" : input.container || "mp4").toLowerCase();
    const allowed = new Set(["mp4", "webm", "mov", "mkv", "mp3", "wav"]);
    if (!allowed.has(container) || (["mp3", "wav"].includes(container) && jobType !== "media.transcode")) {
      throw Object.assign(new Error("Unsupported output container."), { code: "INVALID_MEDIA_OPTIONS" });
    }
    const codecs = { mp4: ["libx264", "aac"], webm: ["libvpx-vp9", "libopus"], mov: ["libx264", "aac"], mkv: ["libx264", "aac"], mp3: ["libx264", "libmp3lame"], wav: ["libx264", "pcm_s16le"] };
    const [videoCodec, audioCodec] = codecs[container];
    const args = ["-hide_banner", "-y", "-i", sourcePath];
    if (jobType === "media.proxy") args.push("-vf", "scale='min(1280,iw)':-2");
    if (["mp3", "wav"].includes(container)) args.push("-vn");
    else args.push("-c:v", videoCodec);
    args.push("-c:a", audioCodec, outputPath);
    const mediaType = container === "mp3" ? "audio/mpeg" : container === "wav" ? "audio/wav" : container === "webm" ? "video/webm" : container === "mov" ? "video/quicktime" : container === "mkv" ? "video/x-matroska" : "video/mp4";
    return { args, name: baseName + (jobType === "media.proxy" ? "-proxy." : "-transcoded.") + container, mediaType };
  }
  throw Object.assign(new Error("This cloud worker does not yet support the requested media job."), { code: "CLOUD_MEDIA_OPERATION_UNSUPPORTED" });
}

/**
 * Executor for cloud queue jobs that use the shared asset repository. The job's
 * owner_id/project_id come from the leased database row, never from job input.
 * Timeline rendering remains deliberately separate until its timeline document
 * and asset references are migrated to the cloud repository.
 */
export function createCloudMediaExecutor({ mediaIO, tempRoot, ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", ffprobe = process.env.FFPROBE_PATH || "ffprobe", timeoutMs = 30 * 60 * 1000 } = {}) {
  if (!mediaIO || typeof mediaIO.materialize !== "function" || typeof mediaIO.publish !== "function") throw new Error("Cloud media executor requires cloud media IO.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) throw new Error("Cloud media execution timeout is invalid.");

  return async function execute({ job, signal, onProgress = () => {} }) {
    if (!job || typeof job.id !== "string" || typeof job.owner_id !== "string" || !SUPPORTED.has(job.job_type)) {
      throw Object.assign(new Error("Cloud media job is missing required lease-scoped fields or uses an unsupported operation."), { code: "CLOUD_MEDIA_OPERATION_UNSUPPORTED" });
    }
    if (signal?.aborted) throw Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" });
    const input = parseInput(job.input ?? job.input_json);
    const sourceId = String(input.sourceAssetId || "");
    if (!sourceId) throw Object.assign(new Error("Cloud media job requires a source asset."), { code: "SOURCE_ASSET_NOT_FOUND" });
    const materialized = await mediaIO.materialize({ ownerId: job.owner_id, assetId: sourceId });
    const directory = tempRoot || undefined;
    const workDir = await mkdtemp(join(tempRoot || tmpdir(), "ev-cloud-job-"));
    const extension = extname(materialized.asset.name || "").slice(0, 12);
    const sourcePath = join(workDir, "source" + extension);
    const outputExtension = job.job_type === "media.thumbnail" ? "jpg"
      : job.job_type === "media.audio_extract" ? "mp3"
      : job.job_type === "media.audio-clean" ? "wav"
      : ["media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.proxy"].includes(job.job_type) ? "mp4"
      : String(input.container || "mp4").toLowerCase();
    const outputPath = join(workDir, randomUUID() + "." + outputExtension);
    try {
      await copyFile(materialized.path, sourcePath);
      if (job.job_type === "media.probe") {
        if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is not installed on this worker."), { code: "MEDIA_ENGINE_MISSING" });
        const result = await runProcess(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", sourcePath], { signal, timeoutMs, onProgress });
        let metadata;
        try { metadata = JSON.parse(result.stdout || "{}"); } catch { throw Object.assign(new Error("FFprobe returned invalid metadata."), { code: "MEDIA_PROBE_INVALID" }); }
        return { sourceAssetId: sourceId, metadata };
      }
      if (!executableAvailable("ffmpeg")) throw Object.assign(new Error("FFmpeg is not installed on this worker."), { code: "MEDIA_ENGINE_MISSING" });
      const plan = outputPlan(job.job_type, input, materialized.asset, sourcePath, outputPath);
      await runProcess(ffmpeg, plan.args, { signal, timeoutMs, onProgress });
      if (signal?.aborted) throw Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" });
      const info = await stat(outputPath);
      if (!info.isFile() || info.size < 1) throw Object.assign(new Error("Media engine produced an empty output."), { code: "MEDIA_OUTPUT_EMPTY" });
      let outputProbe = null;
      if (job.job_type === "media.upscale") {
        if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is required to verify upscaled output."), { code: "MEDIA_ENGINE_MISSING" });
        const probe = await runProcess(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", outputPath], { signal, timeoutMs, onProgress });
        try { outputProbe = JSON.parse(probe.stdout || "{}"); }
        catch { throw Object.assign(new Error("FFprobe returned invalid upscaling metadata."), { code: "MEDIA_PROBE_INVALID" }); }
        const video = (outputProbe.streams || []).find(stream => stream.codec_type === "video");
        // Match buildMediaOperationArgs exactly: validate bounds, then round to an even pixel count.
        const requestedWidth = Number(input.width ?? 2560);
        const requestedHeight = Number(input.height ?? 1440);
        if (!Number.isFinite(requestedWidth) || requestedWidth < 256 || requestedWidth > 4320 ||
            !Number.isFinite(requestedHeight) || requestedHeight < 144 || requestedHeight > 4320) {
          throw Object.assign(new Error("Upscale dimensions are outside the supported range."), { code: "INVALID_MEDIA_OPTIONS" });
        }
        const expectedWidth = Math.round(Math.round(requestedWidth) / 2) * 2;
        const expectedHeight = Math.round(Math.round(requestedHeight) / 2) * 2;
        if (!video || Number(video.width) !== expectedWidth || Number(video.height) !== expectedHeight) {
          throw Object.assign(new Error("Upscale output dimensions do not match the requested dimensions; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
      }
      onProgress(85);
      const digest = await checksum(outputPath);
      const processing = job.job_type === "media.upscale" ? {
        method: "classical-resampling",
        algorithm: ["lanczos", "bicubic", "spline36"].includes(input.algorithm) ? input.algorithm : "lanczos",
        sharpness: Number(input.sharpness ?? 0),
        targetWidth: expectedWidth,
        targetHeight: expectedHeight,
        outputVideo: outputProbe?.streams?.find(stream => stream.codec_type === "video") || null
      } : null;
      const asset = await mediaIO.publish({
        ownerId: job.owner_id,
        projectId: job.project_id || null,
        filename: plan.name,
        mediaType: plan.mediaType,
        path: outputPath,
        derivativeOf: sourceId,
        metadata: { operation: job.job_type, sourceSha256: materialized.asset.sha256, sha256: digest, ...(processing ? { processing } : {}) }
      });
      onProgress(100);
      return { sourceAssetId: sourceId, outputAsset: asset, sha256: digest, byteSize: info.size, operation: job.job_type, ...(processing ? { processing } : {}) };
    } finally {
      await materialized.cleanup?.().catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
