import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { addJobEvent, getOwnedAsset, json, parseJson } from "./db.mjs";

const ALLOWED_JOBS = new Set(["media.probe", "media.thumbnail", "media.transcode", "media.audio_extract", "media.proxy", "timeline.render"]);
const CONTAINERS = new Set(["mp4", "webm", "mov", "mkv", "mp3", "wav"]);
const VIDEO_CODECS = new Set(["libx264", "libx265", "libvpx-vp9", "copy"]);
const AUDIO_CODECS = new Set(["aac", "libmp3lame", "libopus", "copy"]);
const PRESETS = new Set(["ultrafast", "veryfast", "fast", "medium", "slow"]);
const MIME_BY_EXT = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", mp4:"video/mp4", webm:"video/webm", mov:"video/quicktime", mkv:"video/x-matroska", mp3:"audio/mpeg", wav:"audio/wav" };

export function executableAvailable(name) {
  const executable=name==="ffmpeg"?(process.env.FFMPEG_PATH||name):name==="ffprobe"?(process.env.FFPROBE_PATH||name):name;
  const result = spawnSync(executable, ["-version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
  return !result.error && result.status === 0;
}
function run(bin, args, timeoutMs = 30 * 60 * 1000, jobId = null, activeProcesses = null) {
  return new Promise((resolve, reject) => {
    const executable=bin==="ffmpeg"?(process.env.FFMPEG_PATH||bin):bin==="ffprobe"?(process.env.FFPROBE_PATH||bin):bin;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if(jobId&&activeProcesses)activeProcesses.set(jobId,child);
    let stdout = "", stderr = "", timer;
    const append = (current, chunk) => (current + chunk.toString()).slice(-16000);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(Object.assign(new Error("Media operation timed out."), { code:"MEDIA_TIMEOUT" })); }, timeoutMs);
    child.on("error", error => { clearTimeout(timer); if(jobId&&activeProcesses)activeProcesses.delete(jobId); reject(Object.assign(new Error("Media engine could not start."), { code:"MEDIA_ENGINE_MISSING", cause:error })); });
    child.on("close", code => {
      clearTimeout(timer);
      if(jobId&&activeProcesses)activeProcesses.delete(jobId);
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

async function renderTimelineJob({db,job,mediaRoot,activeProcesses,onProgress}){
  const input=parseJson(job.input_json);
  const record=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL").get(String(input.timelineId||""));
  if(!record)throw Object.assign(new Error("Timeline not found."),{code:"TIMELINE_NOT_FOUND"});
  if(record.project_id){
    const access=db.prepare("SELECT p.owner_id,m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.member_id=? WHERE p.id=? AND p.archived_at IS NULL").get(job.owner_id,record.project_id);
    if(!access||access.owner_id!==job.owner_id&& !["editor","owner"].includes(access.role))throw Object.assign(new Error("Timeline is not accessible for rendering."),{code:"TIMELINE_ACCESS_DENIED"});
  }else if(record.owner_id!==job.owner_id)throw Object.assign(new Error("Timeline is not accessible for rendering."),{code:"TIMELINE_ACCESS_DENIED"});
  const timeline=parseJson(record.timeline_json);
  const activeTracks=(timeline.tracks||[]).filter(track=>track.enabled!==false&&(track.clips||[]).some(clip=>clip.enabled!==false));
  const videoTracks=activeTracks.filter(track=>track.kind==="video");
  const unsupported=activeTracks.filter(track=>track.kind!=="video");
  if(videoTracks.length!==1||unsupported.length)throw Object.assign(new Error("This renderer currently supports one primary video track. Audio, overlay and caption tracks require the next render-engine milestone."),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
  const clips=videoTracks[0].clips.filter(clip=>clip.enabled!==false).sort((a,b)=>Number(a.timelineStart.value)/Number(a.timelineStart.rate)-Number(b.timelineStart.value)/Number(b.timelineStart.rate));
  if(!clips.length)throw Object.assign(new Error("Add at least one enabled clip to the primary video track."),{code:"EMPTY_TIMELINE"});
  const width=Math.max(256,Math.min(7680,Math.floor(Number(timeline.width)||1920)));
  const height=Math.max(144,Math.min(4320,Math.floor(Number(timeline.height)||1080)));
  const fpsNum=Number(timeline.frameRate?.numerator)||24,fpsDen=Number(timeline.frameRate?.denominator)||1;
  const fpsValue=fpsNum/fpsDen;
  const outputDir=join(mediaRoot,"derived");await mkdir(outputDir,{recursive:true});
  const outputId=randomUUID(),outputPath=join(outputDir,outputId+".mp4"),args=["-hide_banner","-y"];
  const segments=[];let cursor=0,inputIndex=0,segmentIndex=0;
  const safeSeconds=value=>Math.max(0,Math.min(86400,Number(value)||0));
  for(const clip of clips){
    const start=safeSeconds(Number(clip.timelineStart.value)/Number(clip.timelineStart.rate));
    const duration=safeSeconds(Number(clip.duration.value)/Number(clip.duration.rate));
    if(duration<=0)continue;
    if(start+0.000001<cursor)throw Object.assign(new Error("Primary video track contains overlapping clips."),{code:"TIMELINE_OVERLAP"});
    if(start>cursor+0.000001){
      const gap=start-cursor;
      args.push("-f","lavfi","-t",gap.toFixed(6),"-i",`color=c=black:s=${width}x${height}:r=${fpsNum}/${fpsDen}`);
      const label="v"+segmentIndex++;
      args.push();
      segments.push({index:inputIndex,label,filter:`[${inputIndex}:v]fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`});
      inputIndex++;
    }
    const asset=getAccessibleAsset(db,job.owner_id,String(clip.assetId),true);
    if(!asset)throw Object.assign(new Error("A timeline source asset is no longer accessible."),{code:"SOURCE_ASSET_NOT_FOUND"});
    const file=join(mediaRoot,asset.storage_path);
    const label="v"+segmentIndex++;
    const sourceStart=safeSeconds(Number(clip.sourceRange?.start?.value)/Number(clip.sourceRange?.start?.rate));
    if(asset.media_type.startsWith("image/")){
      args.push("-loop","1","-t",duration.toFixed(6),"-i",file);
    }else if(asset.media_type.startsWith("video/")){
      args.push("-ss",sourceStart.toFixed(6),"-t",duration.toFixed(6),"-i",file);
    }else{
      throw Object.assign(new Error("Only still images and video clips are supported on the primary video track."),{code:"UNSUPPORTED_MEDIA_TYPE"});
    }
    const filter=`[${inputIndex}:v]trim=duration=${duration.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`;
    segments.push({index:inputIndex,label,filter});
    inputIndex++;cursor=start+duration;
    onProgress(Math.min(80,10+Math.round(segmentIndex/Math.max(clips.length,1)*65)));
  }
  if(!segments.length)throw Object.assign(new Error("No renderable clips were found."),{code:"EMPTY_TIMELINE"});
  const filterGraph=segments.map(x=>x.filter).join(";")+";"+segments.map(x=>`[${x.label}]`).join("")+`concat=n=${segments.length}:v=1:a=0[vout]`;
  args.push("-filter_complex",filterGraph,"-map","[vout]","-an","-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-r",`${fpsNum}/${fpsDen}`,outputPath);
  await run("ffmpeg",args,60*60*1000,job.id,activeProcesses);
  onProgress(92);
  const fileStat=await stat(outputPath),hash=createHash("sha256");
  await pipeline(createReadStream(outputPath),new Transform({transform(chunk,enc,cb){hash.update(chunk);cb(null,chunk);}}),new Transform({transform(chunk,enc,cb){cb();}}));
  const outputAsset=addAsset(db,job,"derived/"+outputId+".mp4",String(timeline.name||record.name||"sequence")+"-master.mp4","video/mp4",fileStat.size,hash.digest("hex"),null,{operation:"timeline.render",timelineId:record.id,timelineRevision:record.revision,width,height,frameRate:{numerator:fpsNum,denominator:fpsDen}});
  return {outputAsset,render:{timelineId:record.id,width,height,frameRate:{numerator:fpsNum,denominator:fpsDen},videoClips:clips.length,durationSeconds:cursor}};
}

export async function executeMediaJob({ db, job, mediaRoot, activeProcesses = new Map(), onProgress = () => {} }) {
  if (!ALLOWED_JOBS.has(job.job_type)) throw Object.assign(new Error("No execution adapter is registered for this job type."), { code:"ENGINE_UNAVAILABLE" });
  if(job.job_type==="timeline.render"){
    if(!executableAvailable("ffmpeg"))throw Object.assign(new Error("FFmpeg is not installed on this worker."),{code:"MEDIA_ENGINE_MISSING"});
    const result=await renderTimelineJob({db,job,mediaRoot,activeProcesses,onProgress});
    return result;
  }
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
    const result = await run("ffprobe", ["-v","error","-show_format","-show_streams","-of","json",sourcePath],30*60*1000,job.id,activeProcesses);
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
    if (["mp3","wav"].includes(ext)) args.push("-c:a",ext==="mp3"?"libmp3lame":"pcm_s16le");
    else if (audioCodec !== "copy") args.push("-c:a",audioCodec);
    else args.push("-c:a","copy");
    args.push(outputPath);
  }
  const outputPath = join(outputDir,id+"."+ext);
  progress(35);
  await run("ffmpeg", args,30*60*1000,job.id,activeProcesses);
  progress(85);
  if (cancelled()) { await unlink(outputPath).catch(()=>{}); throw Object.assign(new Error("Job cancelled."), { code:"JOB_CANCELLED" }); }
  
  const fileStat = await stat(outputPath);
  const hash = createHash("sha256");
  await pipeline(createReadStream(outputPath), new Transform({ transform(chunk, enc, cb) { hash.update(chunk); cb(null, chunk); } }), new Transform({ transform(chunk, enc, cb) { cb(); } }));
  const outputAsset = addAsset(db, job, "derived/"+id+"."+ext, outputName, mime, fileStat.size, hash.digest("hex"), source.id, { operation:job.job_type });
  emit("media.output_created", { assetId:outputAsset.id, sha256:outputAsset.sha256 });
  return { outputAsset };
}
