import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { captionStyle, buildSrt, escapeFilterPath, run } from "./media.mjs";
import { buildTimelineClipEffects } from "./timeline-clip-effects.mjs";

const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};
const seconds=(time)=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)return 0;return Math.max(0,Math.min(86400,value/rate));};
const rawSeconds=(time)=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)return null;const result=value/rate;return Number.isFinite(result)?result:null;};
const validateClipTiming=(clip)=>{
 const start=rawSeconds(clip?.timelineStart),duration=rawSeconds(clip?.duration),sourceStart=rawSeconds(clip?.sourceRange?.start),sourceDuration=rawSeconds(clip?.sourceRange?.duration),speed=Number(clip?.speed??1);
 if(start===null||duration===null||sourceStart===null||sourceDuration===null||start<0||duration<=0||sourceStart<0||sourceDuration<=0||start+duration>86400||sourceStart+sourceDuration>86400||!Number.isFinite(speed)||speed<=0)fail("Timeline clip has invalid or out-of-range timing values.","INVALID_TIMELINE_TIMING");
 const sourceRate=Number(clip?.sourceRange?.duration?.rate);if(!Number.isFinite(sourceRate)||sourceRate<=0)fail("Timeline clip source frame rate is invalid.","INVALID_TIMELINE_TIMING");
 if(Math.abs(duration-sourceDuration)>Math.max(0.0001,0.5/sourceRate))fail("Clip source and timeline durations must match within half a source frame until time remapping is implemented.","INVALID_TIMELINE_TIMING");
};
export function parseAudioLoudnessMeasurement(stderr=""){
 const integratedMatch=String(stderr).match(/^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS\s*$/m);
 const rangeMatch=String(stderr).match(/^\s*LRA:\s*(-?\d+(?:\.\d+)?)\s*LU\s*$/m);
 const truePeakSection=String(stderr).split(/True peak:/i).at(-1);
 const peakMatch=truePeakSection?.match(/^\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS\s*$/m);
 const integratedLoudness=integratedMatch?Number(integratedMatch[1]):null;
 const loudnessRange=rangeMatch?Number(rangeMatch[1]):null;
 const truePeak=peakMatch?Number(peakMatch[1]):null;
 return{integratedLoudness:Number.isFinite(integratedLoudness)?integratedLoudness:null,loudnessRange:Number.isFinite(loudnessRange)?loudnessRange:null,truePeak:Number.isFinite(truePeak)?truePeak:null};
}
export function evaluateAudioMasteringQuality(measured,{profile="custom",integratedLoudness=-16,loudnessRange=11,truePeak=-1.5}={}){
 const integratedLoudnessTolerance=profile==="ebu-r128"?0.5:1;
 const loudnessRangeTolerance=1;
 const truePeakLimit=profile==="ebu-r128"?-1:truePeak;
 const qualityControl={
  integratedLoudnessWithinTolerance:Math.abs(measured.integratedLoudness-integratedLoudness)<=integratedLoudnessTolerance,
  loudnessRangeWithinLimit:measured.loudnessRange<=loudnessRange+loudnessRangeTolerance,
  truePeakWithinLimit:measured.truePeak<=truePeakLimit,
  integratedLoudnessTolerance,
  loudnessRangeLimit:loudnessRange+loudnessRangeTolerance,
  truePeakLimit
 };
 qualityControl.passed=qualityControl.integratedLoudnessWithinTolerance&&qualityControl.loudnessRangeWithinLimit&&qualityControl.truePeakWithinLimit;
 return qualityControl;
}
export function buildAudioMasteringFilter(settings){
 if(settings===undefined||settings===null||settings.enabled!==true)return "";
 const profile=settings.profile??"custom";
 if(!["web-podcast","ebu-r128","custom"].includes(profile))fail("Audio mastering profile is not supported.","INVALID_AUDIO_MASTERING");
 // Named delivery profiles are server-enforced; never trust client-supplied LUFS.
 const integrated=profile==="ebu-r128"?-23:profile==="web-podcast"?-16:Number(settings.integratedLoudness??-16);
 const range=Number(settings.loudnessRange??11),truePeak=Number(settings.truePeak??-1.5);
 if(profile==="ebu-r128"&&truePeak> -1)fail("EBU R128 true peak must not exceed -1 dBTP.","INVALID_AUDIO_MASTERING");
 if(!Number.isFinite(integrated)||integrated< -70||integrated> -5||!Number.isFinite(range)||range<1||range>50||!Number.isFinite(truePeak)||truePeak< -9||truePeak>0)fail("Audio mastering targets are outside supported EBU R128 ranges.","INVALID_AUDIO_MASTERING");
 return `loudnorm=I=${integrated}:LRA=${range}:TP=${truePeak}:dual_mono=${settings.dualMono===true?"true":"false"}:linear=false:print_format=summary`;
}
const enabled=(clip)=>clip?.enabled!==false;
const ordered=(tracks)=>tracks.flatMap(track=>(track.clips||[]).filter(enabled)).sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
const safeName=(value)=>String(value||"sequence").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"").trim().replace(/[ .]+$/,"").slice(0,100)||"sequence";

/**
 * FFmpeg timeline renderer for cloud-materialized assets.
 * It shares the local renderer's caption and process primitives but has no
 * SQLite, local asset repository, or local media-root dependency.
 */
export async function renderCloudTimeline({timeline,assets,workDir,signal,onProgress=()=>{},activeProcesses=new Map(),jobId=null}={}){
 if(!timeline||!Array.isArray(timeline.tracks)||!(assets instanceof Map)||typeof workDir!=="string")throw new Error("Cloud timeline renderer received invalid inputs.");
 if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
 const masteringFilter=buildAudioMasteringFilter(timeline.audioMastering);
 const tracks=timeline.tracks.filter(track=>track.enabled!==false&&(track.clips||[]).some(enabled));
 for(const track of tracks)for(const clip of track.clips||[])if(enabled(clip))validateClipTiming(clip);
 const videos=tracks.filter(track=>track.kind==="video"),audios=tracks.filter(track=>track.kind==="audio"),overlays=tracks.filter(track=>track.kind==="overlay"),captions=tracks.filter(track=>track.kind==="caption");
 const unsupported=tracks.filter(track=>!["video","audio","overlay","caption"].includes(track.kind));
 if(videos.length!==1||unsupported.length)fail("The master renderer requires exactly one primary video track and supported audio, overlay and caption tracks.","UNSUPPORTED_TIMELINE_FEATURE");
 const clips=ordered(videos),audioClips=audios.flatMap(track=>ordered([track])),overlayClips=overlays.flatMap(track=>ordered([track])),captionClips=captions.flatMap(track=>ordered([track]));
 if(timeline.audioMastering?.enabled===true&&!audioClips.length)fail("Audio mastering requires at least one enabled audio clip.","AUDIO_MASTERING_REQUIRES_AUDIO");
 if(!clips.length)fail("Add at least one enabled clip to the primary video track.","EMPTY_TIMELINE");
 const width=Math.max(256,Math.min(7680,Math.floor(Number(timeline.width)||1920)));
 const height=Math.max(144,Math.min(4320,Math.floor(Number(timeline.height)||1080)));
 const fpsNum=Math.max(1,Math.min(120,Math.floor(Number(timeline.frameRate?.numerator)||24)));
 const fpsDen=Math.max(1,Math.min(1001,Math.floor(Number(timeline.frameRate?.denominator)||1)));
 const outputId=randomUUID(),outputPath=join(workDir,outputId+".mp4");
 await mkdir(workDir,{recursive:true});
 const args=["-hide_banner","-y"],segments=[],audioFilters=[],videoEffects=[],captionTempPaths=[],overlayInputs=[];
 let cursor=0,inputIndex=0,segmentIndex=0,captionIndex=0;
 const getAsset=(assetId)=>{
  const entry=assets.get(String(assetId));
  if(!entry||typeof entry.path!=="string"||!entry.asset)fail("A timeline source asset is missing or inaccessible.","SOURCE_ASSET_NOT_FOUND");
  const asset=entry.asset;
  return{path:entry.path,id:asset.id,mediaType:asset.mediaType||asset.media_type,originalName:asset.originalName||asset.original_name||asset.name||"",size:asset.size,sha256:asset.sha256};
 };
 try{
  for(const clip of clips){
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const start=seconds(clip.timelineStart),duration=seconds(clip.duration);
   if(duration<=0)continue;
   if(Math.abs(Number(clip.speed??1)-1)>0.000001)fail("Speed changes require the time-remapping renderer milestone.","UNSUPPORTED_TIME_REMAP");
   if(start+0.000001<cursor)fail("Primary video track contains overlapping clips.","TIMELINE_OVERLAP");
   if(start>cursor+0.000001){
    const gap=start-cursor;args.push("-f","lavfi","-t",gap.toFixed(6),"-i",`color=c=black:s=${width}x${height}:r=${fpsNum}/${fpsDen}`);
    const label="v"+segmentIndex++;segments.push({label,filter:`[${inputIndex}:v]fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`});inputIndex++;
   }
   const asset=getAsset(clip.assetId),mediaType=String(asset.mediaType||"");
   if(mediaType.startsWith("image/"))args.push("-loop","1","-t",duration.toFixed(6),"-i",asset.path);
   else if(mediaType.startsWith("video/"))args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",duration.toFixed(6),"-i",asset.path);
   else fail("Only still images and video clips are supported on the primary video track.","UNSUPPORTED_MEDIA_TYPE");
   const label="v"+segmentIndex++;
   const effect=buildTimelineClipEffects(clip.metadata||{});
   const filters=["trim=duration="+duration.toFixed(6),"setpts=PTS-STARTPTS",...effect.preScale,"scale="+width+":"+height+":force_original_aspect_ratio=decrease","pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2","fps="+fpsNum+"/"+fpsDen,"format=yuv420p",...effect.postScale,"setsar=1"];
   segments.push({label,filter:`[${inputIndex}:v]${filters.join(",")}[${label}]`,effectsEnabled:effect.enabled});
   inputIndex++;cursor=start+duration;onProgress(Math.min(65,8+Math.round(segmentIndex/Math.max(clips.length,1)*55)));
  }
  if(!segments.length)fail("No renderable clips were found.","EMPTY_TIMELINE");
  let audioIndex=0;
  for(const clip of audioClips){
   const start=seconds(clip.timelineStart);if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   if(Math.abs(Number(clip.speed??1)-1)>0.000001)fail("Audio speed changes require the time-remapping renderer milestone.","UNSUPPORTED_TIME_REMAP");
   const asset=getAsset(clip.assetId);if(!String(asset.mediaType||"").startsWith("audio/"))fail("Audio tracks require audio source assets.","UNSUPPORTED_AUDIO_SOURCE");
   args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",duration.toFixed(6),"-i",asset.path);
   const delay=Math.round(start*1000),label="a"+audioIndex++,gain=Math.pow(10,Math.max(-60,Math.min(24,Number(clip.gainDb)||0))/20);
   audioFilters.push(`[${inputIndex}:a]atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(6)},adelay=${delay}|${delay},apad=whole_dur=${cursor.toFixed(6)},atrim=duration=${cursor.toFixed(6)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`);
   inputIndex++;
  }
  for(const clip of overlayClips){
   const start=seconds(clip.timelineStart);if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   const asset=getAsset(clip.assetId);if(!String(asset.mediaType||"").startsWith("image/"))fail("Overlay tracks require still-image assets.","UNSUPPORTED_OVERLAY_SOURCE");
   args.push("-loop","1","-t",(start+duration).toFixed(6),"-i",asset.path);
   overlayInputs.push({inputIndex,clip});inputIndex++;
  }
  const concat=segments.map(item=>`[${item.label}]`).join("")+`concat=n=${segments.length}:v=1:a=0[vbase]`;
  const videoGraph=segments.map(item=>item.filter).join(";")+";"+concat;
  let currentVideo="[vbase]";
  for(const [index,item] of overlayInputs.entries()){
   const clip=item.clip,start=seconds(clip.timelineStart);
   if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   const asset=getAsset(clip.assetId),metadata=clip.metadata||{};
   const ow=Math.max(16,Math.min(width,Math.round(Number(metadata.width)||width*.24))),oh=Math.max(16,Math.min(height,Math.round(Number(metadata.height)||height*.24)));
   const x=Math.max(0,Math.min(width-ow,Number.isFinite(Number(metadata.x))?Math.round(Number(metadata.x)):width-ow-24)),y=Math.max(0,Math.min(height-oh,Number.isFinite(Number(metadata.y))?Math.round(Number(metadata.y)):24)),opacity=Math.max(0,Math.min(1,Number(metadata.opacity??1)));
   const imageLabel="overlay-image-"+index,videoLabel="overlay-video-"+index;
   videoEffects.push(`[${item.inputIndex}:v]scale=${ow}:${oh}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[${imageLabel}]`);
   videoEffects.push(`${currentVideo}[${imageLabel}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${start.toFixed(6)},${(start+duration).toFixed(6)})'[${videoLabel}]`);
   currentVideo=`[${videoLabel}]`;
  }
  for(const clip of captionClips){
   const start=seconds(clip.timelineStart);if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   const asset=getAsset(clip.assetId),extension=extname(asset.originalName).toLowerCase();
   if(!["text/plain","text/vtt"].includes(asset.mediaType)||![".srt",".vtt"].includes(extension))fail("Caption tracks require SRT or VTT text assets.","UNSUPPORTED_CAPTION_SOURCE");
   const captionContent=await readFile(asset.path,"utf8");
   if(Buffer.byteLength(captionContent,"utf8")>2*1024*1024)fail("Caption source exceeds the 2 MB limit.","CAPTION_LIMIT_EXCEEDED");
   const adjusted=buildSrt(captionContent,clip);if(!adjusted)continue;
   const tempPath=join(workDir,outputId+"-captions-"+captionIndex+".srt");await writeFile(tempPath,adjusted,"utf8");captionTempPaths.push(tempPath);
   const videoLabel="caption-video-"+captionIndex++,style=captionStyle(clip.metadata||{});
   const nextLabel="caption-chain-"+captionIndex;
   videoEffects.push(`${currentVideo}subtitles=filename='${escapeFilterPath(tempPath)}':force_style='${style}'[${nextLabel}]`);
   currentVideo=`[${nextLabel}]`;
  }
  const filters=[videoGraph,...videoEffects,audioFilters.length?audioFilters.join(";")+";"+audioFilters.map((_,i)=>`[a${i}]`).join("")+`amix=inputs=${audioFilters.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95${masteringFilter?","+masteringFilter:""}[aout]`:""].filter(Boolean).join(";");
  args.push("-filter_complex_threads","1","-filter_complex",filters,"-map",currentVideo);
  if(audioFilters.length)args.push("-map","[aout]","-c:a","aac","-b:a","192k");else args.push("-an");
  args.push("-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-r",`${fpsNum}/${fpsDen}`,outputPath);
  await run("ffmpeg",args,60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
  if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
  onProgress(90);
  const name=safeName(timeline.name);
  let masteringEvidence={applied:false};
  if(masteringFilter){
   const measurementRun=await run("ffmpeg",["-hide_banner","-nostats","-i",outputPath,"-map","0:a:0","-filter_complex","ebur128=peak=true","-f","null","-"],60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const measured=parseAudioLoudnessMeasurement(measurementRun.stderr);
   if(measured.integratedLoudness===null||measured.loudnessRange===null||measured.truePeak===null)fail("The rendered audio could not be measured for integrated loudness, loudness range and true peak.","AUDIO_MASTERING_QC_UNAVAILABLE");
   const masteringProfile=timeline.audioMastering?.profile??"custom";
   const targetLoudness=masteringProfile==="ebu-r128"?-23:masteringProfile==="web-podcast"?-16:Number(timeline.audioMastering?.integratedLoudness??-16);
   const targetTruePeak=Number(timeline.audioMastering?.truePeak??-1.5);
   const targetLoudnessRange=Number(timeline.audioMastering?.loudnessRange??11);
   masteringEvidence={applied:true,profile:masteringProfile,integratedLoudness:targetLoudness,loudnessRange:targetLoudnessRange,truePeak:targetTruePeak,dualMono:timeline.audioMastering?.dualMono===true,measurement:measured,qualityControl:evaluateAudioMasteringQuality(measured,{profile:masteringProfile,integratedLoudness:targetLoudness,loudnessRange:targetLoudnessRange,truePeak:targetTruePeak})};
  }
  return{path:outputPath,filename:name+"-master.mp4",mediaType:"video/mp4",render:{width,height,frameRate:{numerator:fpsNum,denominator:fpsDen},videoClips:clips.length,audioClips:audioClips.length,overlayClips:overlayClips.length,captionClips:captionClips.length,effectClips:segments.filter(segment=>segment.effectsEnabled).length,durationSeconds:cursor,audioMastering:masteringEvidence}};
 }catch(error){
  await unlink(outputPath).catch(()=>{});
  if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
  throw error;
 }finally{await Promise.all(captionTempPaths.map(path=>unlink(path).catch(()=>{})));}
}
