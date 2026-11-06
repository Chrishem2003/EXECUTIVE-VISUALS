import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, unlink, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { addJobEvent, getAccessibleAsset, json, parseJson } from "./db.mjs";
import { createRealEsrganAdapter } from "./ai-upscale-engine.mjs";
import { analyzeVoiceActivityFile } from "./voice-activity-detection.mjs";
import { parseBlackFrameEvents, parseSilenceEvents, parseAudioMetrics, parseFreezeEvents, parseSceneChangeTimes, runOptionalSignalCheck } from "./media-signal-analysis.mjs";

const ALLOWED_JOBS = new Set(["media.probe", "media.thumbnail", "media.transcode", "media.audio_extract", "media.proxy", "media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.audio-clean", "media.ai-upscale", "timeline.render"]);
const CONTAINERS = new Set(["mp4", "webm", "mov", "mkv", "mp3", "wav"]);
const VIDEO_CODECS = new Set(["libx264", "libx265", "libvpx-vp9", "copy"]);
const AUDIO_CODECS = new Set(["aac", "libmp3lame", "libopus", "copy"]);
const PRESETS = new Set(["ultrafast", "veryfast", "fast", "medium", "slow"]);
const MIME_BY_EXT = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", mp4:"video/mp4", webm:"video/webm", mov:"video/quicktime", mkv:"video/x-matroska", mp3:"audio/mpeg", wav:"audio/wav" };


function parseSubtitleTime(value){
 const parts=String(value||"").trim().replace(",",".").split(":");
 if(parts.length===3)return Number(parts[0])*3600+Number(parts[1])*60+Number(parts[2]);
 if(parts.length===2)return Number(parts[0])*60+Number(parts[1]);
 return NaN;
}
function formatSubtitleTime(value){
 const ms=Math.max(0,Math.round(value*1000)),hours=Math.floor(ms/3600000),minutes=Math.floor(ms%3600000/60000),seconds=Math.floor(ms%60000/1000),millis=ms%1000;
 return String(hours).padStart(2,"0")+":"+String(minutes).padStart(2,"0")+":"+String(seconds).padStart(2,"0")+","+String(millis).padStart(3,"0");
}
export function buildSrt(content,clip){
 const sourceStart=Number(clip.sourceRange?.start?.value)/Number(clip.sourceRange?.start?.rate);
 const sourceDuration=Number(clip.sourceRange?.duration?.value)/Number(clip.sourceRange?.duration?.rate);
 const timelineStart=Number(clip.timelineStart?.value)/Number(clip.timelineStart?.rate);
 const timelineDuration=Number(clip.duration?.value)/Number(clip.duration?.rate);
 const sourceEnd=sourceStart+sourceDuration,timelineEnd=timelineStart+timelineDuration;
 const blocks=String(content||"").replace(/^\uFEFF/,"").replace(/\r/g,"").split(/\n\s*\n/);
 const cues=[];
 for(const block of blocks){
  const lines=block.split("\n"),timeIndex=lines.findIndex(line=>line.includes("-->"));
  if(timeIndex<0)continue;
  const timing=lines[timeIndex].split("-->"),start=parseSubtitleTime(timing[0]?.trim().split(/\s+/)[0]),end=parseSubtitleTime(timing[1]?.trim().split(/\s+/)[0]);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
  const clippedStart=Math.max(start,sourceStart),clippedEnd=Math.min(end,sourceEnd);
  if(clippedEnd<=clippedStart)continue;
  const outStart=timelineStart+clippedStart-sourceStart,outEnd=Math.min(timelineEnd,timelineStart+clippedEnd-sourceStart);
  if(outEnd<=outStart)continue;
  const text=lines.slice(timeIndex+1).join("\n").replace(/<[^>]*>/g,"").replace(/\{[^}]*\}/g,"").trim().slice(0,2000);
  if(text)cues.push({start:outStart,end:outEnd,text});
  if(cues.length>5000)throw Object.assign(new Error("Caption file exceeds the 5,000 cue limit."),{code:"CAPTION_LIMIT_EXCEEDED"});
 }
 return cues.map((cue,index)=>(index+1)+"\n"+formatSubtitleTime(cue.start)+" --> "+formatSubtitleTime(cue.end)+"\n"+cue.text).join("\n\n");
}
export function escapeFilterPath(value){
 return String(value).replace(/\\/g,"\\\\").replace(/:/g,"\\:").replace(/'/g,"\\'").replace(/,/g,"\\,").replace(/\[/g,"\\[").replace(/\]/g,"\\]");
}
export function captionStyle(metadata={}){
 const fontName=String(metadata.fontName||"DejaVu Sans").replace(/[^A-Za-z0-9 _-]/g,"").slice(0,48)||"DejaVu Sans";
 const fontSize=Math.max(12,Math.min(96,Math.round(Number(metadata.fontSize)||32)));
 const alignment=Math.max(1,Math.min(9,Math.round(Number(metadata.alignment)||2)));
 const marginV=Math.max(0,Math.min(240,Math.round(Number(metadata.marginV)||42)));
 const outline=Math.max(0,Math.min(8,Number(metadata.outline??2)));
 const shadow=Math.max(0,Math.min(8,Number(metadata.shadow??1)));
 const colour=value=>/^&H[0-9A-Fa-f]{8}$/.test(String(value||""))?String(value):null;
 const hex=value=>{const match=String(value||"").match(/^#([0-9A-Fa-f]{6})$/);if(!match)return null;const rgb=match[1];return "&H00"+rgb.slice(4,6)+rgb.slice(2,4)+rgb.slice(0,2);};
 const primary=colour(metadata.primaryColour)||hex(metadata.primaryColor)||"&H00FFFFFF";
 const outlineColour=colour(metadata.outlineColour)||"&H00000000";
 const backgroundHex=String(metadata.backgroundColor||"#000000").match(/^#([0-9A-Fa-f]{6})$/)?.[1]||"000000";
 const opacity=Math.max(0,Math.min(1,Number(metadata.backgroundOpacity??0.68)));
 const alpha=Math.round((1-opacity)*255).toString(16).padStart(2,"0").toUpperCase();
 const backColour="&H"+alpha+backgroundHex.slice(4,6)+backgroundHex.slice(2,4)+backgroundHex.slice(0,2);
 const box=metadata.backgroundMode!=="none";
 return ["FontName="+fontName,"FontSize="+fontSize,"PrimaryColour="+primary,"OutlineColour="+outlineColour,"BackColour="+backColour,"BorderStyle="+(box?3:1),"Outline="+outline,"Shadow="+shadow,"Alignment="+alignment,"MarginV="+marginV].join(",");
}
export function buildMediaOperationArgs({jobType,input={},sourcePath,outputPath}){
 const fail=message=>{throw Object.assign(new Error(message),{code:"INVALID_MEDIA_OPTIONS"})};
 const number=(value,fallback,min,max)=>{const parsed=Number(value??fallback);if(!Number.isFinite(parsed)||parsed<min||parsed>max)fail("Media operation parameter is outside the supported range.");return parsed};
 const base=["-hide_banner","-y","-i",sourcePath],video=["-c:v","libx264","-preset","veryfast","-crf","19","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-movflags","+faststart",outputPath];
 let filter;
 if(jobType==="media.audio-clean"){
  const noiseFloor=number(input.noiseFloor,-25,-60,-5),target=number(input.targetLufs,-16,-24,-12);
  const audioFilter="afftdn=nf="+noiseFloor.toFixed(1)+":tn=1,loudnorm=I="+target.toFixed(1)+":TP=-1.5:LRA=11";
  return [...base,"-vn","-af",audioFilter,"-c:a","pcm_s16le","-ar","48000",outputPath];
 }else if(jobType==="media.denoise"){
  const luma=number(input.luma,4,0,10),chroma=number(input.chroma,3,0,10);
  filter=`hqdn3d=${luma.toFixed(2)}:${chroma.toFixed(2)}:${(luma*0.75).toFixed(2)}:${(chroma*0.75).toFixed(2)}`;
 }else if(jobType==="media.color"){
  const brightness=number(input.brightness,0,-1,1),contrast=number(input.contrast,1,0,2),saturation=number(input.saturation,1,0,3);
  filter=`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`;
 }else if(jobType==="media.resize"||jobType==="media.upscale"){
  const width=Math.round(number(input.width,jobType==="media.upscale"?2560:1920,256,4320)/2)*2;
  const height=Math.round(number(input.height,jobType==="media.upscale"?1440:1080,144,4320)/2)*2;
  const mode=String(input.fit||"contain");
  if(!["contain","cover"].includes(mode))fail("Choose contain or cover for the resize fit mode.");
  const algorithm=jobType==="media.upscale"?String(input.algorithm||"lanczos"):"lanczos";
  if(!["lanczos","bicubic","spline36"].includes(algorithm))fail("Choose lanczos, bicubic, or spline36 for scaling.");
  const ffmpegScaleFlag=algorithm==="spline36"?"spline":algorithm;
  filter=mode==="cover"?`scale=${width}:${height}:force_original_aspect_ratio=increase:flags=${ffmpegScaleFlag},crop=${width}:${height}`:`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=${ffmpegScaleFlag},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  if(jobType==="media.upscale"){
   const sharpness=number(input.sharpness,0,0,1.5);
   if(sharpness>0)filter+=`,unsharp=5:5:${sharpness.toFixed(2)}:5:5:0.0`;
  }
  filter+=",setsar=1";
 }else if(jobType==="media.interpolate"){
  const fps=number(input.fps,30,24,60);
  filter=`minterpolate=fps=${fps.toFixed(3)}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
 }else fail("Unsupported local media operation.");
 return [...base,"-vf",filter,...video];
}
export function executableAvailable(name) {
  const executable=name==="ffmpeg"?(process.env.FFMPEG_PATH||name):name==="ffprobe"?(process.env.FFPROBE_PATH||name):name;
  const result = spawnSync(executable, ["-version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
  return !result.error && result.status === 0;
}
export function run(bin, args, timeoutMs = 30 * 60 * 1000, jobId = null, activeProcesses = null, shouldCancel = null, maxCaptureBytes = 16000) {
  return new Promise((resolve, reject) => {
    const executable=bin==="ffmpeg"?(process.env.FFMPEG_PATH||bin):bin==="ffprobe"?(process.env.FFPROBE_PATH||bin):bin;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if(jobId&&activeProcesses)activeProcesses.set(jobId,child);
    let stdout = "", stderr = "", timer, cancellationTimer;
    const append = (current, chunk) => (current + chunk.toString()).slice(-maxCaptureBytes);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    timer = setTimeout(() => { child.kill("SIGKILL"); reject(Object.assign(new Error("Media operation timed out."), { code:"MEDIA_TIMEOUT" })); }, timeoutMs);
    if(shouldCancel)cancellationTimer=setInterval(()=>{try{if(shouldCancel()&&!child.killed)child.kill("SIGTERM");}catch{}},500);
    child.on("error", error => { clearTimeout(timer); if(cancellationTimer)clearInterval(cancellationTimer); if(jobId&&activeProcesses)activeProcesses.delete(jobId); reject(Object.assign(new Error("Media engine could not start."), { code:"MEDIA_ENGINE_MISSING", cause:error })); });
    child.on("close", code => {
      clearTimeout(timer);
      if(cancellationTimer)clearInterval(cancellationTimer);
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
export function validateMediaOutputProbe(metadata, mediaType) {
  const streams=Array.isArray(metadata?.streams)?metadata.streams:[];
  const expected=String(mediaType||"").startsWith("video/")?"video":
    String(mediaType||"").startsWith("audio/")?"audio":
    String(mediaType||"").startsWith("image/")?"video":null;
  if(!expected||!streams.some(stream=>stream?.codec_type===expected))
    throw Object.assign(new Error("Media output failed stream validation."),{code:"MEDIA_OUTPUT_VALIDATION_FAILED"});
  const duration=Number(metadata?.format?.duration);
  if(Number.isFinite(duration)&&duration<=0)
    throw Object.assign(new Error("Media output has an invalid duration."),{code:"MEDIA_OUTPUT_VALIDATION_FAILED"});
  if(!Number.isFinite(duration)&&!streams.some(stream=>Number(stream?.duration)>0))
    throw Object.assign(new Error("Media output has no verifiable duration."),{code:"MEDIA_OUTPUT_VALIDATION_FAILED"});
  return {streamCount:streams.length,durationSeconds:Number.isFinite(duration)?duration:null,validatedStreamType:expected};
}

export function buildMediaProcessingProvenance({jobType,input={},sourceAsset={}}={}) {
  const allowed = {
    "media.denoise":["luma","chroma"],
    "media.color":["brightness","contrast","saturation"],
    "media.resize":["width","height","fit"],
    "media.upscale":["width","height","fit","algorithm","sharpness"],
    "media.interpolate":["fps"],
    "media.audio-clean":["noiseFloor","targetLufs"],
    "media.transcode":["container","videoCodec","audioCodec","preset"],
    "media.proxy":["container","videoCodec","audioCodec","preset"],
    "media.audio_extract":[],
    "media.thumbnail":["seconds"]
  };
  if (!Object.hasOwn(allowed,jobType)) return null;
  const parameters={};
  for(const key of allowed[jobType]) {
    const value=input?.[key];
    if(typeof value==="string"&&value.length<=32) parameters[key]=value;
    else if(typeof value==="number"&&Number.isFinite(value)) parameters[key]=value;
    else if(typeof value==="boolean") parameters[key]=value;
  }
  return {
    schemaVersion:1,
    operation:jobType,
    engine:"ffmpeg",
    method:jobType==="media.upscale"||jobType==="media.resize"?"deterministic-resampling":
      jobType==="media.interpolate"?"optical-flow-frame-interpolation":
      jobType==="media.denoise"?"classical-video-denoising":
      jobType==="media.color"?"deterministic-color-adjustment":
      jobType==="media.audio-clean"?"classical-audio-filtering":
      jobType==="media.audio_extract"?"audio-stream-extraction":
      jobType==="media.thumbnail"?"frame-extraction":"deterministic-transcoding",
    sourceAssetId:typeof sourceAsset.id==="string"?sourceAsset.id:null,
    sourceSha256:typeof sourceAsset.sha256==="string"?sourceAsset.sha256:null,
    parameters,
    aiInferencePerformed:false
  };
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
    if(!access||access.owner_id!==job.owner_id&&!["editor","owner"].includes(access.role))throw Object.assign(new Error("Timeline is not accessible for rendering."),{code:"TIMELINE_ACCESS_DENIED"});
  }else if(record.owner_id!==job.owner_id)throw Object.assign(new Error("Timeline is not accessible for rendering."),{code:"TIMELINE_ACCESS_DENIED"});
  const timeline=parseJson(record.timeline_json);
  const activeTracks=(timeline.tracks||[]).filter(track=>track.enabled!==false&&(track.clips||[]).some(clip=>clip.enabled!==false));
  const videoTracks=activeTracks.filter(track=>track.kind==="video");
  const audioTracks=activeTracks.filter(track=>track.kind==="audio");
  const overlayTracks=activeTracks.filter(track=>track.kind==="overlay");
  const captionTracks=activeTracks.filter(track=>track.kind==="caption");
  const unsupported=activeTracks.filter(track=>!["video","audio","overlay","caption"].includes(track.kind));
  if(videoTracks.length!==1||unsupported.length)throw Object.assign(new Error("The master renderer requires exactly one primary video track. Unsupported track types: "+unsupported.map(track=>track.kind).join(", ")),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
  const clips=videoTracks[0].clips.filter(clip=>clip.enabled!==false).sort((a,b)=>Number(a.timelineStart.value)/Number(a.timelineStart.rate)-Number(b.timelineStart.value)/Number(b.timelineStart.rate));
  const audioClips=audioTracks.flatMap(track=>track.clips.filter(clip=>clip.enabled!==false)).sort((a,b)=>Number(a.timelineStart.value)/Number(a.timelineStart.rate)-Number(b.timelineStart.value)/Number(b.timelineStart.rate));
  const overlayClips=overlayTracks.flatMap(track=>track.clips.filter(clip=>clip.enabled!==false)).sort((a,b)=>Number(a.timelineStart.value)/Number(a.timelineStart.rate)-Number(b.timelineStart.value)/Number(b.timelineStart.rate));
  const captionClips=captionTracks.flatMap(track=>track.clips.filter(clip=>clip.enabled!==false)).sort((a,b)=>Number(a.timelineStart.value)/Number(a.timelineStart.rate)-Number(b.timelineStart.value)/Number(b.timelineStart.rate));
  if(!clips.length)throw Object.assign(new Error("Add at least one enabled clip to the primary video track."),{code:"EMPTY_TIMELINE"});
  const width=Math.max(256,Math.min(7680,Math.floor(Number(timeline.width)||1920)));
  const height=Math.max(144,Math.min(4320,Math.floor(Number(timeline.height)||1080)));
  const fpsNum=Number(timeline.frameRate?.numerator)||24,fpsDen=Number(timeline.frameRate?.denominator)||1;
  const outputDir=join(mediaRoot,"derived");await mkdir(outputDir,{recursive:true});
  const outputId=randomUUID(),outputPath=join(outputDir,outputId+".mp4"),args=["-hide_banner","-y"];
  const segments=[];let cursor=0,inputIndex=0,segmentIndex=0;
  const safeSeconds=value=>Math.max(0,Math.min(86400,Number(value)||0));
  for(const clip of clips){
    const start=safeSeconds(Number(clip.timelineStart.value)/Number(clip.timelineStart.rate));
    const duration=safeSeconds(Number(clip.duration.value)/Number(clip.duration.rate));
    if(duration<=0)continue;
    if(Math.abs(Number(clip.speed??1)-1)>0.000001)throw Object.assign(new Error("Speed changes require the time-remapping renderer milestone."),{code:"UNSUPPORTED_TIME_REMAP"});
    if(start+0.000001<cursor)throw Object.assign(new Error("Primary video track contains overlapping clips."),{code:"TIMELINE_OVERLAP"});
    if(start>cursor+0.000001){
      const gap=start-cursor;
      args.push("-f","lavfi","-t",gap.toFixed(6),"-i",`color=c=black:s=${width}x${height}:r=${fpsNum}/${fpsDen}`);
      const label="v"+segmentIndex++;
      segments.push({label,filter:`[${inputIndex}:v]fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`});
      inputIndex++;
    }
    const asset=getAccessibleAsset(db,job.owner_id,String(clip.assetId),true);
    if(!asset)throw Object.assign(new Error("A timeline source asset is no longer accessible."),{code:"SOURCE_ASSET_NOT_FOUND"});
    const file=join(mediaRoot,asset.storage_path);
    const label="v"+segmentIndex++;
    const sourceStart=safeSeconds(Number(clip.sourceRange?.start?.value)/Number(clip.sourceRange?.start?.rate));
    if(asset.media_type.startsWith("image/"))args.push("-loop","1","-t",duration.toFixed(6),"-i",file);
    else if(asset.media_type.startsWith("video/"))args.push("-ss",sourceStart.toFixed(6),"-t",duration.toFixed(6),"-i",file);
    else throw Object.assign(new Error("Only still images and video clips are supported on the primary video track."),{code:"UNSUPPORTED_MEDIA_TYPE"});
    const filter=`[${inputIndex}:v]trim=duration=${duration.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`;
    segments.push({label,filter});
    inputIndex++;cursor=start+duration;
    onProgress(Math.min(70,10+Math.round(segmentIndex/Math.max(clips.length,1)*55)));
  }
  if(!segments.length)throw Object.assign(new Error("No renderable clips were found."),{code:"EMPTY_TIMELINE"});
  const audioFilters=[];let audioIndex=0;
  for(const clip of audioClips){
    const start=safeSeconds(Number(clip.timelineStart.value)/Number(clip.timelineStart.rate));
    if(start>=cursor)continue;
    const requested=safeSeconds(Number(clip.duration.value)/Number(clip.duration.rate)),duration=Math.min(requested,cursor-start);
    if(duration<=0)continue;
    if(Math.abs(Number(clip.speed??1)-1)>0.000001)throw Object.assign(new Error("Audio speed changes require the time-remapping renderer milestone."),{code:"UNSUPPORTED_TIME_REMAP"});
    const asset=getAccessibleAsset(db,job.owner_id,String(clip.assetId),true);
    if(!asset||!asset.media_type.startsWith("audio/"))throw Object.assign(new Error("Audio tracks require accessible audio-only source assets."),{code:"UNSUPPORTED_AUDIO_SOURCE"});
    const file=join(mediaRoot,asset.storage_path),sourceStart=safeSeconds(Number(clip.sourceRange?.start?.value)/Number(clip.sourceRange?.start?.rate));
    args.push("-ss",sourceStart.toFixed(6),"-t",duration.toFixed(6),"-i",file);
    const delay=Math.max(0,Math.round(start*1000)),label="a"+audioIndex++,gain=Math.pow(10,Math.max(-60,Math.min(24,Number(clip.gainDb)||0))/20);
    audioFilters.push(`[${inputIndex}:a]atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(6)},adelay=${delay}|${delay},apad=whole_dur=${cursor.toFixed(6)},atrim=duration=${cursor.toFixed(6)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`);
    inputIndex++;
  }
  const videoEffects=[],captionTempPaths=[];
  let currentVideo="[vbase]",overlayIndex=0,captionIndex=0;
  for(const clip of overlayClips){
    const start=safeSeconds(Number(clip.timelineStart.value)/Number(clip.timelineStart.rate));
    if(start>=cursor)continue;
    const duration=Math.min(safeSeconds(Number(clip.duration.value)/Number(clip.duration.rate)),cursor-start);
    if(duration<=0)continue;
    const asset=getAccessibleAsset(db,job.owner_id,String(clip.assetId),true);
    if(!asset||!asset.media_type.startsWith("image/"))throw Object.assign(new Error("Overlay tracks currently require accessible still-image assets."),{code:"UNSUPPORTED_OVERLAY_SOURCE"});
    const metadata=clip.metadata||{},overlayWidth=Math.max(16,Math.min(width,Math.round(Number(metadata.width)||width*0.24))),overlayHeight=Math.max(16,Math.min(height,Math.round(Number(metadata.height)||height*0.24)));
    const rawX=Number(metadata.x),rawY=Number(metadata.y),x=Math.max(0,Math.min(width-overlayWidth,Number.isFinite(rawX)?Math.round(rawX):width-overlayWidth-24)),y=Math.max(0,Math.min(height-overlayHeight,Number.isFinite(rawY)?Math.round(rawY):24));
    const opacity=Math.max(0,Math.min(1,Number(metadata.opacity??1)));
    const file=join(mediaRoot,asset.storage_path);
    args.push("-loop","1","-t",(start+duration).toFixed(6),"-i",file);
    const imageLabel="overlay-image-"+overlayIndex,videoLabel="overlay-video-"+overlayIndex++;
    videoEffects.push(`[${inputIndex}:v]scale=${overlayWidth}:${overlayHeight}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[${imageLabel}]`);
    videoEffects.push(`${currentVideo}[${imageLabel}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${start.toFixed(6)},${(start+duration).toFixed(6)})'[${videoLabel}]`);
    currentVideo=`[${videoLabel}]`;inputIndex++;
  }
  for(const clip of captionClips){
    const start=safeSeconds(Number(clip.timelineStart.value)/Number(clip.timelineStart.rate));
    if(start>=cursor)continue;
    const duration=Math.min(safeSeconds(Number(clip.duration.value)/Number(clip.duration.rate)),cursor-start);
    if(duration<=0)continue;
    const asset=getAccessibleAsset(db,job.owner_id,String(clip.assetId),true);
    const extension=extname(asset?.original_name||"").toLowerCase();
    if(!asset||!["text/plain","text/vtt"].includes(asset.media_type)||![".srt",".vtt"].includes(extension))throw Object.assign(new Error("Caption tracks require accessible SRT or VTT text assets."),{code:"UNSUPPORTED_CAPTION_SOURCE"});
    const captionPath=join(mediaRoot,asset.storage_path),captionContent=await readFile(captionPath,"utf8");
    if(Buffer.byteLength(captionContent,"utf8")>2*1024*1024)throw Object.assign(new Error("Caption source exceeds the 2 MB limit."),{code:"CAPTION_LIMIT_EXCEEDED"});
    const adjusted=buildSrt(captionContent,clip);
    if(!adjusted)continue;
    const tempPath=join(outputDir,outputId+"-captions-"+captionIndex+".srt");
    await writeFile(tempPath,adjusted,"utf8");captionTempPaths.push(tempPath);
    const videoLabel="caption-video-"+captionIndex++,style=captionStyle(clip.metadata||{}),escaped=escapeFilterPath(tempPath);
    videoEffects.push(`${currentVideo}subtitles=filename='${escaped}':force_style='${style}'[${videoLabel}]`);
    currentVideo=`[${videoLabel}]`;
  }
  const concatGraph=segments.map(item=>`[${item.label}]`).join("")+`concat=n=${segments.length}:v=1:a=0[vbase]`;
  const videoGraph=segments.map(item=>item.filter).join(";")+";"+concatGraph+(videoEffects.length?";"+videoEffects.join(";"):"");
  const audioGraph=audioFilters.length?audioFilters.join(";")+";"+audioFilters.map((_,i)=>`[a${i}]`).join("")+`amix=inputs=${audioFilters.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]`:"";
  const filterGraph=[videoGraph,audioGraph].filter(Boolean).join(";");
  args.push("-filter_complex_threads","1","-filter_complex",filterGraph,"-map",currentVideo);
  if(audioFilters.length)args.push("-map","[aout]","-c:a","aac","-b:a","192k");else args.push("-an");
  args.push("-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-r",`${fpsNum}/${fpsDen}`,outputPath);
  const cancelled=()=>db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)?.status==="cancelled";
  try {
    await run("ffmpeg",args,60*60*1000,job.id,activeProcesses,cancelled);
  } catch(error) {
    await unlink(outputPath).catch(()=>{});
    throw error;
  } finally {
    await Promise.all(captionTempPaths.map(path=>unlink(path).catch(()=>{})));
  }
  if(cancelled()){
    await unlink(outputPath).catch(()=>{});
    throw Object.assign(new Error("Job cancelled."),{code:"JOB_CANCELLED"});
  }
  onProgress(92);
  const fileStat=await stat(outputPath),hash=createHash("sha256");
  await pipeline(createReadStream(outputPath),new Transform({transform(chunk,enc,cb){hash.update(chunk);cb(null,chunk);}}),new Transform({transform(chunk,enc,cb){cb();}}));
  const outputAsset=addAsset(db,job,"derived/"+outputId+".mp4",String(timeline.name||record.name||"sequence")+"-master.mp4","video/mp4",fileStat.size,hash.digest("hex"),null,{operation:"timeline.render",timelineId:record.id,timelineRevision:record.revision,width,height,frameRate:{numerator:fpsNum,denominator:fpsDen}});
  return {outputAsset,render:{timelineId:record.id,width,height,frameRate:{numerator:fpsNum,denominator:fpsDen},videoClips:clips.length,audioClips:audioClips.length,overlayClips:overlayClips.length,captionClips:captionClips.length,durationSeconds:cursor}};
}

export async function executeMediaJob({ db, job, mediaRoot, activeProcesses = new Map(), onProgress = () => {} }) {
  if (!ALLOWED_JOBS.has(job.job_type)) throw Object.assign(new Error("No execution adapter is registered for this job type."), { code:"ENGINE_UNAVAILABLE" });
  if(job.job_type==="timeline.render"){
    if(!executableAvailable("ffmpeg"))throw Object.assign(new Error("FFmpeg is not installed on this worker."),{code:"MEDIA_ENGINE_MISSING"});
    const result=await renderTimelineJob({db,job,mediaRoot,activeProcesses,onProgress});
    return result;
  }
  if (!executableAvailable("ffmpeg") && job.job_type !== "media.probe" && job.job_type !== "media.ai-upscale") throw Object.assign(new Error("FFmpeg is not installed on this worker."), { code:"MEDIA_ENGINE_MISSING" });
  if (!executableAvailable("ffprobe") && job.job_type !== "media.ai-upscale") throw Object.assign(new Error("FFprobe is not installed on this worker."), { code:"MEDIA_ENGINE_MISSING" });
  const input = parseJson(job.input_json);
  const source = getAccessibleAsset(db, job.owner_id, input.sourceAssetId, true);
  if (!source) throw Object.assign(new Error("Source asset does not exist or is not accessible."), { code:"SOURCE_ASSET_NOT_FOUND" });
  const sourcePath = join(mediaRoot, source.storage_path);
  const id = randomUUID();
  const outputDir = join(mediaRoot, "derived");
  await mkdir(outputDir, { recursive:true });
  const cancelled = () => db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)?.status === "cancelled";
  const emit = (type, data) => addJobEvent(db, job.id, job.owner_id, type, data);
  emit("media.started", { operation:job.job_type, sourceAssetId:source.id });
  if (job.job_type === "media.ai-upscale") {
    if (!source.media_type.startsWith("image/")) throw Object.assign(new Error("AI super-resolution currently accepts still images only."), { code:"UNSUPPORTED_MEDIA_TYPE" });
    const format = String(input.format || "png");
    if (!["png","jpg","webp"].includes(format)) throw Object.assign(new Error("Unsupported AI upscale output format."), { code:"INVALID_MEDIA_OPTIONS" });
    const outputPath = join(outputDir,id+"."+format);
    const controller = new AbortController();
    const poll = setInterval(() => { if (cancelled()) controller.abort(); }, 500);
    poll.unref?.();
    try {
      const adapter = createRealEsrganAdapter({ timeoutMs:30*60*1000, maxOutputBytes:250*1024*1024 });
      const result = await adapter.execute({
        inputPath:sourcePath, outputPath, model:input.model||"realesrgan-x4plus",
        scale:input.scale??4, tile:input.tile??0, format, signal:controller.signal
      });
      if (controller.signal.aborted || cancelled()) throw Object.assign(new Error("Job cancelled."), { code:"JOB_CANCELLED" });
      const fileStat = await stat(outputPath);
      const hash = createHash("sha256");
      await pipeline(createReadStream(outputPath),new Transform({transform(chunk,enc,cb){hash.update(chunk);cb(null,chunk);}}),new Transform({transform(chunk,enc,cb){cb();}}));
      const mime = format==="jpg"?"image/jpeg":"image/"+format;
      const baseName = source.original_name.split(".").slice(0,-1).join(".") || source.original_name;
      const processing = {engine:result.engine,method:result.method,model:result.model,scale:result.scale,tile:result.tile};
      const outputAsset = addAsset(db,job,"derived/"+id+"."+format,baseName+"-ai-upscaled."+format,mime,fileStat.size,hash.digest("hex"),source.id,{operation:job.job_type,processing});
      emit("media.output_created",{assetId:outputAsset.id,sha256:outputAsset.sha256});
      onProgress(100);
      return {outputAsset,processing};
    } finally { clearInterval(poll); }
  }

  if (job.job_type === "media.probe") {
    const result = await run("ffprobe", ["-v","error","-show_format","-show_streams","-of","json",sourcePath],30*60*1000,job.id,activeProcesses,cancelled);
    const metadata = JSON.parse(result.stdout || "{}");
    const streams=Array.isArray(metadata.streams)?metadata.streams:[];
    const signalAnalysis={schemaVersion:2,method:"ffmpeg-signal-analysis-with-optional-silero-vad",blackFrames:[],silence:[],freezes:[],sceneChanges:[],audioMetrics:null,voiceActivity:null,performed:[],unavailable:[],limitations:["Black-frame and silence detection are heuristic signal checks. They cannot determine whether an intentional pause, fade, or black transition is creatively correct.","Audio clipping and loudness metrics depend on installed FFmpeg filters and are not a substitute for mastering or perceptual review.","Neural voice activity detection estimates speech presence; it does not transcribe words, identify speakers, infer emotion or certify dialogue quality."]};
    if(streams.some(stream=>stream.codec_type==="video")){
      const check=await runOptionalSignalCheck(()=>run("ffmpeg",["-hide_banner","-i",sourcePath,"-map","0:v:0","-vf","blackdetect=d=0.1:pix_th=0.10","-an","-f","null","-"],10*60*1000,job.id,activeProcesses,cancelled,2_000_000),{isCancelled:cancelled});
      if(check.status==="completed"){signalAnalysis.blackFrames=parseBlackFrameEvents(check.result.stderr);signalAnalysis.performed.push("black-frame");}
      else signalAnalysis.unavailable.push({check:"black-frame",reason:check.reason});
      const motion=await runOptionalSignalCheck(()=>run("ffmpeg",["-hide_banner","-i",sourcePath,"-map","0:v:0","-vf","freezedetect=n=-60dB:d=2,select='gt(scene,0.3)',showinfo","-an","-f","null","-"],10*60*1000,job.id,activeProcesses,cancelled,2_000_000),{isCancelled:cancelled});
      if(motion.status==="completed"){signalAnalysis.freezes=parseFreezeEvents(motion.result.stderr);signalAnalysis.sceneChanges=parseSceneChangeTimes(motion.result.stderr);signalAnalysis.performed.push("freeze-detect","scene-change");}
      else signalAnalysis.unavailable.push({check:"freeze-and-scene-change",reason:motion.reason});
    }
    if(streams.some(stream=>stream.codec_type==="audio")){
      const check=await runOptionalSignalCheck(()=>run("ffmpeg",["-hide_banner","-i",sourcePath,"-map","0:a:0","-af","silencedetect=n=-50dB:d=0.5,astats=metadata=0:reset=0,ebur128=peak=true","-vn","-f","null","-"],10*60*1000,job.id,activeProcesses,cancelled,2_000_000),{isCancelled:cancelled});
      if(check.status==="completed"){
        signalAnalysis.silence=parseSilenceEvents(check.result.stderr,Number(metadata.format?.duration)||0);
        signalAnalysis.audioMetrics=parseAudioMetrics(check.result.stderr);signalAnalysis.performed.push("silence","audio-metrics");
      } else signalAnalysis.unavailable.push({check:"audio-signal-and-metrics",reason:check.reason});
      const vadCheck=await runOptionalSignalCheck(async()=>{
        const tempDir=await mkdtemp(join(tmpdir(),"executive-visuals-vad-"));
        try{
          const wavPath=join(tempDir,"analysis.wav");
          await run("ffmpeg",["-hide_banner","-y","-i",sourcePath,"-map","0:a:0","-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",wavPath],10*60*1000,job.id,activeProcesses,cancelled,2_000_000);
          if(cancelled())throw Object.assign(new Error("Job cancelled."),{code:"JOB_CANCELLED"});
          return await analyzeVoiceActivityFile({filePath:wavPath,durationSeconds:Number(metadata.format?.duration),threshold:0.5,holdoffMs:300});
        }finally{await rm(tempDir,{recursive:true,force:true});}
      },{isCancelled:cancelled});
      if(vadCheck.status==="completed"){signalAnalysis.voiceActivity=vadCheck.result;signalAnalysis.performed.push("silero-vad");}
      else signalAnalysis.unavailable.push({check:"voice-activity-detection",reason:vadCheck.reason});
    }
    metadata.signalAnalysis=signalAnalysis;
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
  } else if(job.job_type==="media.audio-clean"){
    if(!source.media_type.startsWith("audio/"))throw Object.assign(new Error("Audio cleanup requires an audio source."),{code:"UNSUPPORTED_MEDIA_TYPE"});
    ext="wav";mime="audio/wav";outputName=(source.original_name.includes(".")?source.original_name.slice(0,source.original_name.lastIndexOf(".")):source.original_name)+"-cleaned.wav";
    args=buildMediaOperationArgs({jobType:job.job_type,input,sourcePath,outputPath:join(outputDir,id+"."+ext)});
  } else if(["media.denoise","media.color","media.resize","media.interpolate","media.upscale"].includes(job.job_type)){
    if(!source.media_type.startsWith("video/"))throw Object.assign(new Error("This enhancement operation currently requires a video source."),{code:"UNSUPPORTED_MEDIA_TYPE"});
    ext="mp4";mime="video/mp4";outputName=(source.original_name.includes(".")?source.original_name.slice(0,source.original_name.lastIndexOf(".")):source.original_name)+"-"+job.job_type.split(".")[1]+".mp4";
    args=buildMediaOperationArgs({jobType:job.job_type,input,sourcePath,outputPath:join(outputDir,id+"."+ext)});
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
  onProgress(35);
  await run("ffmpeg", args,30*60*1000,job.id,activeProcesses,cancelled);
  onProgress(85);
  if (cancelled()) { await unlink(outputPath).catch(()=>{}); throw Object.assign(new Error("Job cancelled."), { code:"JOB_CANCELLED" }); }
  
  const probeResult=await run("ffprobe",["-v","error","-show_format","-show_streams","-of","json",outputPath],60000,job.id,activeProcesses,cancelled);
  let outputMetadata;
  try { outputMetadata=JSON.parse(probeResult.stdout||"{}"); }
  catch { throw Object.assign(new Error("Media output metadata could not be parsed."),{code:"MEDIA_OUTPUT_VALIDATION_FAILED"}); }
  const validation=validateMediaOutputProbe(outputMetadata,mime);
  const fileStat = await stat(outputPath);
  if(fileStat.size<=0)throw Object.assign(new Error("Media output is empty."),{code:"MEDIA_OUTPUT_VALIDATION_FAILED"});
  const hash = createHash("sha256");
  await pipeline(createReadStream(outputPath), new Transform({ transform(chunk, enc, cb) { hash.update(chunk); cb(null, chunk); } }), new Transform({ transform(chunk, enc, cb) { cb(); } }));
  const provenance=buildMediaProcessingProvenance({jobType:job.job_type,input,sourceAsset:source});
  const outputAsset = addAsset(db, job, "derived/"+id+"."+ext, outputName, mime, fileStat.size, hash.digest("hex"), source.id, { operation:job.job_type, ...(provenance?{processing:provenance}:{}) });
  emit("media.output_created", { assetId:outputAsset.id, sha256:outputAsset.sha256 });
  return { outputAsset, validation };
}
