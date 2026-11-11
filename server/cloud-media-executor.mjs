import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createC2paTransformationPreserver } from "./c2pa-transformation-preserver.mjs";
import { buildMediaOperationArgs, executableAvailable } from "./media.mjs";
import { createRealEsrganAdapter } from "./ai-upscale-engine.mjs";

const EXTENSION = Object.freeze({
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav", "video/mp4": "mp4"
});
const SUPPORTED = new Set([
  "media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean",
  "media.denoise", "media.color", "media.resize", "media.interpolate",
  "media.upscale", "media.ai-upscale", "media.transcode", "media.proxy"
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
    let stdout = "", stderr = "", settled = false, pendingTerminationError = null, killTimer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const isRunning = () => child.exitCode === null && child.signalCode === null;
    const terminate = error => {
      if (settled || pendingTerminationError) return;
      pendingTerminationError = error;
      if (!isRunning()) return finish(error);
      child.kill(error.code === "JOB_CANCELLED" ? "SIGTERM" : "SIGKILL");
      if (error.code === "JOB_CANCELLED") {
        killTimer = setTimeout(() => {
          if (isRunning()) child.kill("SIGKILL");
        }, 3000);
        killTimer.unref?.();
      }
    };
    const abort = () => terminate(Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" }));
    const timer = setTimeout(() => terminate(Object.assign(new Error("Media operation timed out."), { code: "MEDIA_TIMEOUT" })), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-16000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.on("error", error => finish(Object.assign(new Error("Media engine could not start."), { code: "MEDIA_ENGINE_MISSING", cause: error })));
    child.on("close", code => {
      if (pendingTerminationError) return finish(pendingTerminationError);
      if (code === 0) return finish(null, { stdout, stderr });
      finish(Object.assign(new Error((stderr || "Media operation failed.").slice(-3000)), { code: "MEDIA_PROCESS_FAILED" }));
    });
    try { onProgress(10); }
    catch (error) { terminate(error instanceof Error ? error : new Error("Media progress reporting failed.")); }
  });
}

async function checksum(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); }
  }), new Transform({ transform(chunk, encoding, callback) { callback(); } }));
  return hash.digest("hex");
}

export function buildCloudMediaOutputPlan(jobType, input, source, sourcePath, outputPath) {
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
    if (jobType === "media.proxy") {
      const proxyWidth = Number(input.proxyWidth ?? 960);
      const proxyCrf = Number(input.proxyCrf ?? 28);
      const preset = String(input.preset ?? "veryfast");
      if (!Number.isInteger(proxyWidth) || proxyWidth < 320 || proxyWidth > 1920 ||
          !Number.isInteger(proxyCrf) || proxyCrf < 18 || proxyCrf > 35 ||
          !["ultrafast", "veryfast", "fast"].includes(preset)) {
        throw Object.assign(new Error("Cloud proxy settings are outside the supported range."), { code: "INVALID_MEDIA_OPTIONS" });
      }
      args.push("-vf", "scale='min(" + proxyWidth + ",iw)':-2");
    }
    if (["mp3", "wav"].includes(container)) args.push("-vn");
    else args.push("-c:v", videoCodec);
    if (jobType === "media.proxy") args.push("-preset", String(input.preset ?? "veryfast"), "-crf", String(input.proxyCrf ?? 28), "-pix_fmt", "yuv420p", "-movflags", "+faststart");
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
async function preserveC2paOutput({c2paPreserver,c2paSigner,c2paSignerMode,sourcePath,outputPath,sourceMimeType,outputMimeType,expectedSourceSha256,operation,signal}){
  return c2paPreserver({sourcePath,outputPath,sourceMimeType,outputMimeType,expectedSourceSha256,signer:c2paSigner,signerMode:c2paSignerMode,operation,signal});
}
export function createCloudMediaExecutor({ mediaIO, tempRoot, ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", ffprobe = process.env.FFPROBE_PATH || "ffprobe", timeoutMs = 30 * 60 * 1000, c2paPreserver = createC2paTransformationPreserver(), c2paSigner = null, c2paSignerMode = "local" } = {}) {
  if (!mediaIO || typeof mediaIO.materialize !== "function" || typeof mediaIO.publish !== "function") throw new Error("Cloud media executor requires cloud media IO.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) throw new Error("Cloud media execution timeout is invalid.");
  if(typeof c2paPreserver!=="function")throw new Error("Cloud media executor requires a C2PA preservation adapter.");

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
    const outputExtension = job.job_type === "media.ai-upscale" ? String(input.format || "png")
      : job.job_type === "media.thumbnail" ? "jpg"
      : job.job_type === "media.audio_extract" ? "mp3"
      : job.job_type === "media.audio-clean" ? "wav"
      : ["media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.proxy"].includes(job.job_type) ? "mp4"
      : String(input.container || "mp4").toLowerCase();
    const outputPath = join(workDir, randomUUID() + "." + outputExtension);
    try {
      await copyFile(materialized.path, sourcePath);
      if (job.job_type === "media.ai-upscale") {
        if (!String(materialized.asset.mediaType || "").startsWith("image/")) {
          throw Object.assign(new Error("AI super-resolution currently accepts still images only; video frame processing is not enabled."), { code: "UNSUPPORTED_MEDIA_TYPE" });
        }
        const adapter = createRealEsrganAdapter({ timeoutMs, maxOutputBytes: 250 * 1024 * 1024 });
        const format = String(input.format || "png");
        if (!["png", "jpg", "webp"].includes(format)) throw Object.assign(new Error("AI upscale output format is unsupported."), { code: "INVALID_MEDIA_OPTIONS" });
        if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is required to verify AI-upscaled image dimensions."), { code: "MEDIA_ENGINE_MISSING" });
        if (!executableAvailable("ffmpeg")) throw Object.assign(new Error("FFmpeg is required to fully decode and validate AI-upscaled images."), { code: "MEDIA_ENGINE_MISSING" });
        const sourceProbe = await runProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", sourcePath], { signal, timeoutMs, onProgress });
        let sourceImage;
        try { sourceImage = JSON.parse(sourceProbe.stdout || "{}").streams?.[0]; } catch {}
        const sourceWidth = Number(sourceImage?.width), sourceHeight = Number(sourceImage?.height);
        if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) throw Object.assign(new Error("FFprobe could not verify the source image dimensions."), { code: "MEDIA_PROBE_INVALID" });
        const result = await adapter.execute({
          inputPath: sourcePath, outputPath, model: input.model || "realesrgan-x4plus",
          scale: input.scale ?? 4, tile: input.tile ?? 0, format
        });
        if (signal?.aborted) throw Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" });
        const outputProbe = await runProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", outputPath], { signal, timeoutMs, onProgress });
        let outputImage;
        try { outputImage = JSON.parse(outputProbe.stdout || "{}").streams?.[0]; } catch {}
        const expectedWidth = sourceWidth * result.scale, expectedHeight = sourceHeight * result.scale;
        if (Number(outputImage?.width) !== expectedWidth || Number(outputImage?.height) !== expectedHeight) throw Object.assign(new Error("AI-upscaled image dimensions do not match the requested scale; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        await runProcess(ffmpeg, ["-v", "error", "-i", outputPath, "-f", "null", "-"], { signal, timeoutMs: Math.min(timeoutMs, 120000), onProgress });
        if (signal?.aborted) throw Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" });
        const mediaType = format === "jpg" ? "image/jpeg" : "image/" + format;
        const sourceName = String(materialized.asset.name || "image");
        const plan = { name: sourceName.replace(/\.[^.]+$/, "").slice(0, 140) + "-ai-upscaled." + format, mediaType };
        const processing = { engine: result.engine, method: result.method, model: result.model, scale: result.scale, tile: Number(input.tile ?? 0), sourceWidth, sourceHeight, outputWidth: expectedWidth, outputHeight: expectedHeight, dimensionsVerified: true };
        if (signal?.aborted) throw Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" });
        const c2paPreservation=await preserveC2paOutput({c2paPreserver,c2paSigner,c2paSignerMode,sourcePath,outputPath,sourceMimeType:materialized.asset.mediaType,outputMimeType:mediaType,expectedSourceSha256:materialized.asset.sha256,operation:job.job_type,signal});
        const info=await stat(outputPath);
        const digest=await checksum(outputPath);
       const asset = await mediaIO.publish({
          ownerId: job.owner_id, projectId: job.project_id || null, filename: plan.name,
          mediaType, path: outputPath, derivativeOf: sourceId,
          metadata: { operation: job.job_type, sourceSha256: materialized.asset.sha256, sha256: digest, processing, c2paPreservation },
          publicationKey: job.id + ":output:v1"
        });
        onProgress(100);
        return { sourceAssetId: sourceId, outputAsset: asset, sha256: digest, byteSize: info.size, operation: job.job_type, processing, c2paPreservation };
      }
      if (job.job_type === "media.probe") {
        if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is not installed on this worker."), { code: "MEDIA_ENGINE_MISSING" });
        const result = await runProcess(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", sourcePath], { signal, timeoutMs, onProgress });
        let metadata;
        try { metadata = JSON.parse(result.stdout || "{}"); } catch { throw Object.assign(new Error("FFprobe returned invalid metadata."), { code: "MEDIA_PROBE_INVALID" }); }
        return { sourceAssetId: sourceId, metadata };
      }
      if (!executableAvailable("ffmpeg")) throw Object.assign(new Error("FFmpeg is not installed on this worker."), { code: "MEDIA_ENGINE_MISSING" });
      let sourceAudioStreamCount = null;
      let sourceDurationSeconds = null;
      let expectedWidth = null;
      let expectedHeight = null;
      if (job.job_type === "media.upscale") {
        if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is required to verify upscaled output."), { code: "MEDIA_ENGINE_MISSING" });
        const sourceProbe = await runProcess(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", sourcePath], { signal, timeoutMs, onProgress });
        let sourceMetadata;
        try { sourceMetadata = JSON.parse(sourceProbe.stdout || "{}"); }
        catch { throw Object.assign(new Error("FFprobe returned invalid source metadata."), { code: "MEDIA_PROBE_INVALID" }); }
        sourceAudioStreamCount = (sourceMetadata.streams || []).filter(stream => stream.codec_type === "audio").length;
        const parsedSourceDuration = Number(sourceMetadata.format?.duration);
        if (!Number.isFinite(parsedSourceDuration) || parsedSourceDuration <= 0) {
          throw Object.assign(new Error("Upscale source has no valid media duration; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
        sourceDurationSeconds = parsedSourceDuration;
      }
      const plan = buildCloudMediaOutputPlan(job.job_type, input, materialized.asset, sourcePath, outputPath);
      if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is required to validate cloud media derivatives before publication."), { code: "MEDIA_ENGINE_MISSING" });
      await runProcess(ffmpeg, plan.args, { signal, timeoutMs, onProgress });
      if (signal?.aborted) throw Object.assign(new Error("Media job was cancelled."), { code: "JOB_CANCELLED" });
      const preSignInfo=await stat(outputPath);
      if (!preSignInfo.isFile() || preSignInfo.size < 1) throw Object.assign(new Error("Media engine produced an empty output."), { code: "MEDIA_OUTPUT_EMPTY" });
      let outputProbe = null;
      const structuralProbe = await runProcess(ffprobe, ["-v","error","-show_format","-show_streams","-of","json",outputPath], { signal, timeoutMs, onProgress });
      let structuralMetadata;
      try { structuralMetadata = JSON.parse(structuralProbe.stdout || "{}"); }
      catch { throw Object.assign(new Error("FFprobe returned malformed derivative metadata; derivative was not published."), { code: "MEDIA_PROBE_INVALID" }); }
      const structuralStreams = Array.isArray(structuralMetadata.streams) ? structuralMetadata.streams : [];
      const expectedStream = plan.mediaType.startsWith("audio/") ? "audio" : "video";
      const matchingStream = structuralStreams.find(stream => stream?.codec_type === expectedStream);
      if (!matchingStream) throw Object.assign(new Error("Derivative is missing its expected "+expectedStream+" stream; it was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
      if (plan.mediaType.startsWith("image/") && (!Number.isInteger(Number(matchingStream.width)) || Number(matchingStream.width)<1 || !Number.isInteger(Number(matchingStream.height)) || Number(matchingStream.height)<1))
        throw Object.assign(new Error("Image derivative dimensions could not be verified; it was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
      if (!plan.mediaType.startsWith("image/")) {
        const duration=Number(structuralMetadata.format?.duration);
        const streamDuration=Number(matchingStream.duration);
        if (!(Number.isFinite(duration)&&duration>0) && !(Number.isFinite(streamDuration)&&streamDuration>0))
          throw Object.assign(new Error("Derivative has no valid, verifiable duration; it was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
      }
      outputProbe = structuralMetadata;
      if (job.job_type === "media.upscale") {
        if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is required to verify upscaled output."), { code: "MEDIA_ENGINE_MISSING" });
        const probe = await runProcess(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,codec_name,pix_fmt:format=duration", "-of", "json", outputPath], { signal, timeoutMs, onProgress });
        try { outputProbe = JSON.parse(probe.stdout || "{}"); }
        catch { throw Object.assign(new Error("FFprobe returned invalid upscaling metadata."), { code: "MEDIA_PROBE_INVALID" }); }
        const video = (outputProbe.streams || []).find(stream => stream.codec_type === "video");
        if (!video || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p") {
          throw Object.assign(new Error("Upscale output must be H.264 with yuv420p pixel format; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
        const outputAudioStreamCount = (outputProbe.streams || []).filter(stream => stream.codec_type === "audio").length;
        if (sourceAudioStreamCount > 0 && outputAudioStreamCount === 0) {
          throw Object.assign(new Error("Upscale output lost the source audio stream; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
        const outputDuration = Number(outputProbe.format?.duration);
        if (!Number.isFinite(outputDuration) || outputDuration <= 0) {
          throw Object.assign(new Error("Upscale output has no valid media duration; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
        const durationDeltaSeconds = Math.abs(outputDuration - sourceDurationSeconds);
        const durationToleranceSeconds = Math.max(0.25, sourceDurationSeconds * 0.02);
        if (durationDeltaSeconds > durationToleranceSeconds) {
          throw Object.assign(new Error("Upscale output duration differs materially from the source; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
        // Match buildMediaOperationArgs exactly: validate bounds, then round to an even pixel count.
        const requestedWidth = Number(input.width ?? 2560);
        const requestedHeight = Number(input.height ?? 1440);
        if (!Number.isFinite(requestedWidth) || requestedWidth < 256 || requestedWidth > 4320 ||
            !Number.isFinite(requestedHeight) || requestedHeight < 144 || requestedHeight > 4320) {
          throw Object.assign(new Error("Upscale dimensions are outside the supported range."), { code: "INVALID_MEDIA_OPTIONS" });
        }
        expectedWidth = Math.round(Math.round(requestedWidth) / 2) * 2;
        expectedHeight = Math.round(Math.round(requestedHeight) / 2) * 2;
        if (!video || Number(video.width) !== expectedWidth || Number(video.height) !== expectedHeight) {
          throw Object.assign(new Error("Upscale output dimensions do not match the requested dimensions; derivative was not published."), { code: "MEDIA_OUTPUT_VALIDATION_FAILED" });
        }
      }
      onProgress(85);
      const processing = job.job_type === "media.upscale" ? {
        method: "classical-resampling",
        algorithm: ["lanczos", "bicubic", "spline36"].includes(input.algorithm) ? input.algorithm : "lanczos",
        sharpness: Number(input.sharpness ?? 0),
        targetWidth: expectedWidth,
        targetHeight: expectedHeight,
        sourceDurationSeconds,
        outputDurationSeconds: Number(outputProbe?.format?.duration),
        durationDeltaSeconds: Math.abs(Number(outputProbe?.format?.duration) - sourceDurationSeconds),
        sourceAudioStreamCount,
        outputAudioStreamCount: (outputProbe?.streams || []).filter(stream => stream.codec_type === "audio").length,
        audioPreserved: sourceAudioStreamCount === null ? null : sourceAudioStreamCount === 0 || (outputProbe?.streams || []).some(stream => stream.codec_type === "audio"),
        outputVideo: outputProbe?.streams?.find(stream => stream.codec_type === "video") || null
      } : null;
      const c2paPreservation=await preserveC2paOutput({c2paPreserver,c2paSigner,c2paSignerMode,sourcePath,outputPath,sourceMimeType:materialized.asset.mediaType,outputMimeType:plan.mediaType,expectedSourceSha256:materialized.asset.sha256,operation:job.job_type,signal});
      const info=await stat(outputPath);
      const digest=await checksum(outputPath);
      const asset = await mediaIO.publish({
        ownerId: job.owner_id,
        projectId: job.project_id || null,
        filename: plan.name,
        mediaType: plan.mediaType,
        path: outputPath,
        derivativeOf: sourceId,
        metadata: { operation: job.job_type, sourceSha256: materialized.asset.sha256, sha256: digest, ...(processing ? { processing } : {}), c2paPreservation },
        publicationKey: job.id + ":output:v1"
      });
      onProgress(100);
      return { sourceAssetId: sourceId, outputAsset: asset, sha256: digest, byteSize: info.size, operation: job.job_type, ...(processing ? { processing } : {}), c2paPreservation };
    } finally {
      await materialized.cleanup?.().catch(() => {});
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
