import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { addJobEvent, getOwnedAsset, json, parseJson } from "./db.mjs";

const ALLOWED_JOBS = new Set(["media.probe", "media.thumbnail", "media.transcode", "media.audio_extract", "media.proxy"]);
const CONTAINERS = new Set(["mp4", "webm", "mov", "mkv", "mp3", "wav"]);
const VIDEO_CODECS = new Set(["libx264", "libx265", "libvpx-vp9", "copy"]);
const AUDIO_CODECS = new Set(["aac", "libmp3lame", "libopus", "copy"]);
const PRESETS = new Set(["ultrafast", "veryfast", "fast", "medium", "slow"]);
const MIME_BY_EXT = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", mp4:"video/mp4", webm:"video/webm", mov:"video/quicktime", mkv:"video/x-matroska", mp3:"audio/mpeg", wav:"audio/wav" };

export function executableAvailable(name) {
  const result = spawnSync(name, ["-version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
  return !result.error && result.status === 0;
}
function run(bin, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", timer;
    const append = (current, chunk) => (current + chunk.toString()).slice(-16000);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(Object.assign(new Error("Media operation timed out."), { code:"MEDIA_TIMEOUT" })); }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); reject(Object.assign(new Error("Media engine could not start."), { code:"MEDIA_ENGINE_MISSING", cause:error })); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error((stderr || "Media operation failed.").slice(-3000)), { code:"MEDIA_PROCESS_FAILED" }));
    });
  });
}
function safeExtension(name, fallback) {
  const ext = extname(name || "").replace(".","").toLowerCase();
  return CONTAINERS.has(ext) || ["jpg","jpeg","png","webp"].includes(ext) ? ext : fallback;
}
function addAsset(db, job, filePath, originalName, mediaType, size, sha256, derivativeOf, metadata = {}) {
  const id = randomUUID();
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,derivative_of,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, job.owner_id, job.project_id, originalName, mediaType, size, sha256, filePath, derivativeOf, json(metadata));
  return { id, name:originalName, mediaType, size, sha256, derivativeOf, metadata };
}
export async function executeMediaJob({ db, job, mediaRoot, activeProcesses = new Map() }) {
  if (!ALLOWED_JOBS.has(job.job_type)) throw Object.assign(new Error("No execution adapter is registered for this job type."), { code:"ENGINE_UNAVAILABLE" });
  if (!executableAvailable("ffmpeg") && job.job_type !== "media.probe") throw Object.assign(new Error("FFmpeg is not installed on this worker."), { code:"MEDIA_ENGINE_MISSING" });
  if (!executableAvailable("ffprobe")) throw Object.assign(new Error("FFprobe is not installed on this worker."), { code:"MEDIA_ENGINE_MISSING" });
  const input = parseJson(job.input_json);
  const source = getOwnedAsset(db, job.owner_id, input.sourceAssetId);
  if (!source) throw Object.assign(new Error("Source asset does not exist or is not accessible."), { code:"SOURCE_ASSET_NOT_FOUND" });
  const sourcePath = join(mediaRoot, source.storage_path);
  const id = randomUUID();
  const outputDir = join(mediaRoot, "derived");
  await mkdir(outputDir, { recursive:true });
  const cancelled = () => db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)?.status === "cancelled";
  const emit = (type, data) => addJobEvent(db, job.id, job.owner_id, type, data);
  emit("media.started", { operation:job.job_type, sourceAssetId:source.id });

  if (job.job_type === "media.probe") {
    const result = await run("ffprobe", ["-v","error","-show_format","-show_streams","-of","json",sourcePath]);
    const metadata = JSON.parse(result.stdout || "{}");
    return { metadata, outputAsset:null };
  }

  let ext, args, outputName, mime;
  if (job.job_type === "media.thumbnail") {
    const seconds = Math.max(0, Math.min(3600, Number(input.seconds ?? 1) || 0));
    ext = "jpg"; outputName = source.original_name.replace(/\.[^.]+$/, "")+"-frame-"+seconds+"s.jpg"; mime = "image/jpeg";
    args = ["-hide_banner","-y","-ss",String(seconds),"-i",sourcePath,"-frames:v","1","-q:v","2",join(outputDir,id+"."+ext)];
  } else if (job.job_type === "media.audio_extract") {
    ext = "mp3"; outputName = source.original_name.replace(/\.[^.]+$/, "")+"-audio.mp3"; mime = "audio/mpeg";
    args = ["-hide_banner","-y","-i",sourcePath,"-vn","-c:a","libmp3lame","-q:a","2",join(outputDir,id+"."+ext)];
  } else {
    const container = String(input.container || (job.job_type === "media.proxy" ? "mp4" : "mp4")).toLowerCase();
    if (!CONTAINERS.has(container) || ["mp3","wav"].includes(container) && job.job_type !== "media.transcode") {
      throw Object.assign(new Error("Unsupported output container."), { code:"INVALID_MEDIA_OPTIONS" });
    }
    const videoCodec = String(input.videoCodec || "libx264");
    const audioCodec = String(input.audioCodec || "aac");
    const preset = String(input.preset || "veryfast");
    if (!VIDEO_CODECS.has(videoCodec) || !AUDIO_CODECS.has(audioCodec) || !PRESETS.has(preset)) {
      throw Object.assign(new Error("Unsupported codec or preset."), { code:"INVALID_MEDIA_OPTIONS" });
    }
    ext = container; mime = MIME_BY_EXT[ext] || "application/octet-stream";
    outputName = source.original_name.replace(/\.[^.]+$/, "")+(job.job_type === "media.proxy" ? "-proxy" : "-transcoded")+"."+ext;
    const outputPath = join(outputDir,id+"."+ext);
    args = ["-hide_banner","-y","-i",sourcePath];
    if (job.job_type === "media.proxy") args.push("-vf","scale='min(1280,iw)':-2");
    if (["mp3","wav"].includes(ext)) args.push("-vn");
    if (videoCodec !== "copy" && !["mp3","wav"].includes(ext)) args.push("-c:v",videoCodec,"-preset",preset);
    else if (videoCodec === "copy" && !["mp3","wav"].includes(ext)) args.push("-c:v","copy");
    if (audioCodec !== "copy") args.push("-c:a",audioCodec);
    else args.push("-c:a","copy");
    args.push(outputPath);
  }
  const outputPath = join(outputDir,id+"."+ext);
  await run("ffmpeg", args);
  if (cancelled()) { await unlink(outputPath).catch(()=>{}); throw Object.assign(new Error("Job cancelled."), { code:"JOB_CANCELLED" }); }
  const { stat, createHash } = await import("node:fs/promises").then(async fs => ({ stat:fs.stat, createHash:(await import("node:crypto")).createHash }));
  const fileStat = await stat(outputPath);
  const hash = createHash("sha256");
  await pipeline(createReadStream(outputPath), new Transform({ transform(chunk, enc, cb) { hash.update(chunk); cb(null, chunk); } }), new Transform({ transform(chunk, enc, cb) { cb(); } }));
  const outputAsset = addAsset(db, job, "derived/"+id+"."+ext, outputName, mime, fileStat.size, hash.digest("hex"), source.id, { operation:job.job_type });
  emit("media.output_created", { assetId:outputAsset.id, sha256:outputAsset.sha256 });
  return { outputAsset };
}
