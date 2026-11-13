import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { captionStyle, buildSrt, escapeFilterPath, run } from "./media.mjs";
import { buildTimelineClipEffects } from "./timeline-clip-effects.mjs";
import { normalizeClipSpeed, sourceDurationForTimeline, buildAtempoFilter } from "./time-remap.mjs";

const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};
const seconds=(time)=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)return 0;return Math.max(0,Math.min(86400,value/rate));};
const rawSeconds=(time)=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)return null;const result=value/rate;return Number.isFinite(result)?result:null;};
const speedNumber=(value)=>Number(value.toFixed(9)).toString();
const speedSegments=(clip,duration)=>{
 const curve=clip.speedCurve;
 if(curve===undefined)return null;
 if(!Array.isArray(curve)||curve.length<2||curve.length>64||curve[0]?.timeSeconds!==0||
    curve.some((point,index)=>!point||!Number.isFinite(point.timeSeconds)||!Number.isFinite(point.speed)||
      point.speed<0.25||point.speed>4||point.timeSeconds<0||point.timeSeconds>duration||
      (index>0&&point.timeSeconds<=curve[index-1].timeSeconds)))
  fail("Variable-speed keyframes require 2–64 ordered points, start at zero and stay within the clip at 0.25×–4×.","INVALID_SPEED_CURVE");
 const evaluate=time=>{
  if(time<=curve[0].timeSeconds)return curve[0].speed;
  for(let index=1;index<curve.length;index++){
   const left=curve[index-1],right=curve[index];
   if(time<=right.timeSeconds){
    const span=right.timeSeconds-left.timeSeconds,ratio=span>0?(time-left.timeSeconds)/span:1;
    return left.speed+(right.speed-left.speed)*ratio;
   }
  }
  return curve[curve.length-1].speed;
 };
 const points=curve.filter(point=>point.timeSeconds<duration).map(point=>({time:point.timeSeconds,speed:point.speed}));
 if(!points.length||points[0].time!==0)fail("Variable-speed keyframes must start at zero.","INVALID_SPEED_CURVE");
 points.push({time:duration,speed:evaluate(duration)});
 let source=0;
 return points.slice(1).map((point,index)=>{
  const previous=points[index],elapsed=point.time-previous.time,sourceStart=source;
  if(elapsed<=0)fail("Variable-speed keyframe intervals must have positive duration.","INVALID_SPEED_CURVE");
  source+=(previous.speed+point.speed)*0.5*elapsed;
  return{timelineStart:previous.time,timelineEnd:point.time,sourceStart,sourceEnd:source,startSpeed:previous.speed,endSpeed:point.speed,slope:(point.speed-previous.speed)/elapsed};
 });
};
export const sourceDurationForClip=(clip,duration)=>{
 const segments=speedSegments(clip,duration);
 return segments?segments.reduce((total,segment)=>total+segment.sourceEnd-segment.sourceStart,0):sourceDurationForTimeline(duration,normalizeClipSpeed(clip?.speed??1));
};
export const buildVariableSpeedSetptsExpression=(clip,duration)=>{
 const segments=speedSegments(clip,duration);
 if(!segments)return null;
 let expression="("+speedNumber(duration)+"+(T-"+speedNumber(segments[segments.length-1].sourceEnd)+")/"+speedNumber(segments[segments.length-1].endSpeed)+")";
 for(let index=segments.length-1;index>=0;index--){
  const segment=segments[index],delta="(T-"+speedNumber(segment.sourceStart)+")";
  const local=Math.abs(segment.slope)<1e-9?delta+"/"+speedNumber(segment.startSpeed):
   "2*"+delta+"/("+speedNumber(segment.startSpeed)+"+sqrt("+speedNumber(segment.startSpeed*segment.startSpeed)+"+2*"+speedNumber(segment.slope)+"*"+delta+"))";
  expression="if(lt(T,"+speedNumber(segment.sourceEnd)+"),("+speedNumber(segment.timelineStart)+"+("+local+")),"+expression+")";
 }
 return expression;
};

const validateClipTiming=(clip,kind)=>{
 const start=rawSeconds(clip?.timelineStart),duration=rawSeconds(clip?.duration),sourceStart=rawSeconds(clip?.sourceRange?.start),sourceDuration=rawSeconds(clip?.sourceRange?.duration);
 if(start===null||duration===null||sourceStart===null||sourceDuration===null||start<0||duration<=0||sourceStart<0||sourceDuration<=0||start+duration>86400||sourceStart+sourceDuration>86400)fail("Timeline clip has invalid or out-of-range timing values.","INVALID_TIMELINE_TIMING");
 const sourceRate=Number(clip?.sourceRange?.duration?.rate);if(!Number.isFinite(sourceRate)||sourceRate<=0)fail("Timeline clip source frame rate is invalid.","INVALID_TIMELINE_TIMING");
 let speed;try{speed=normalizeClipSpeed(clip?.speed??1);}catch{fail("Clip speed must be between 0.25× and 4×.","INVALID_CLIP_SPEED");}
 if(kind!=="video"&&kind!=="audio"&&speed!==1)fail("Speed changes are supported only for video and audio clips.","UNSUPPORTED_TIME_REMAP");
 if(clip?.speedCurve!==undefined&&kind!=="video")fail("Variable-speed curves are currently supported only for video clips.","UNSUPPORTED_SPEED_CURVE");
 const expected=clip?.speedCurve!==undefined?sourceDurationForClip(clip,duration):sourceDurationForTimeline(duration,speed);
 if(Math.abs(expected-sourceDuration)>Math.max(0.0001,0.5/sourceRate))fail("Clip source duration must equal timeline duration multiplied by playback speed.","INVALID_TIMELINE_TIMING");
};
export function parseAudioLoudnessMeasurement(stderr=""){
 const integratedMatch=String(stderr).match(/^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS\s*$/m);
 const rangeMatch=String(stderr).match(/^\s*LRA:\s*(-?\d+(?:\.\d+)?)\s*LU\s*$/m);
 const truePeakSection=String(stderr).match(/True peak:\s*([\s\S]*)/i)?.[1]??"";
 const peakMatch=truePeakSection.match(/^\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS\s*$/m);
 const integratedLoudness=integratedMatch?Number(integratedMatch[1]):null;
 const loudnessRange=rangeMatch?Number(rangeMatch[1]):null;
 const truePeak=peakMatch?Number(peakMatch[1]):null;
 return{integratedLoudness:Number.isFinite(integratedLoudness)?integratedLoudness:null,loudnessRange:Number.isFinite(loudnessRange)?loudnessRange:null,truePeak:Number.isFinite(truePeak)?truePeak:null};
}
export function evaluateAudioMasteringQuality(measured,{profile="custom",integratedLoudness=-16,loudnessRange=11,truePeak=-1.5}={}){
 const integratedLoudnessTolerance=profile==="ebu-r128"?0.5:1;
 const loudnessRangeTolerance=1;
 const truePeakLimit=profile==="ebu-r128"?-1:truePeak;
 const measurementComplete=[measured?.integratedLoudness,measured?.loudnessRange,measured?.truePeak].every(value=>typeof value==="number"&&Number.isFinite(value));
 const targetsValid=[integratedLoudness,loudnessRange,truePeakLimit].every(value=>typeof value==="number"&&Number.isFinite(value));
 const qualityControl={
  measurementComplete,
  integratedLoudnessWithinTolerance:measurementComplete&&targetsValid&&Math.abs(measured.integratedLoudness-integratedLoudness)<=integratedLoudnessTolerance,
  loudnessRangeWithinLimit:measurementComplete&&targetsValid&&measured.loudnessRange<=loudnessRange+loudnessRangeTolerance,
  truePeakWithinLimit:measurementComplete&&targetsValid&&measured.truePeak<=truePeakLimit,
  integratedLoudnessTolerance,
  loudnessRangeLimit:loudnessRange+loudnessRangeTolerance,
  truePeakLimit
 };
 qualityControl.passed=measurementComplete&&targetsValid&&qualityControl.integratedLoudnessWithinTolerance&&qualityControl.loudnessRangeWithinLimit&&qualityControl.truePeakWithinLimit;
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
const audioPoints=(clip,duration)=>{
 const points=clip.audioAutomation??[];
 if(!Array.isArray(points)||points.length>256)fail("Audio automation must contain at most 256 keyframes.","INVALID_AUDIO_AUTOMATION");
 let previous=-1;
 for(const point of points){
  if(!point||!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>duration||point.timeSeconds<=previous)fail("Audio automation keyframes must be sorted, unique and inside the clip.","INVALID_AUDIO_AUTOMATION");
  if(point.gainDb!==undefined&&(!Number.isFinite(point.gainDb)||point.gainDb< -60||point.gainDb>24))fail("Audio automation gain must be between -60 and 24 dB.","INVALID_AUDIO_AUTOMATION");
  if(point.pan!==undefined&&(!Number.isFinite(point.pan)||point.pan< -1||point.pan>1))fail("Audio automation pan must be between -1 and 1.","INVALID_AUDIO_AUTOMATION");
  if(point.gainDb===undefined&&point.pan===undefined)fail("Audio automation keyframes require gain or pan.","INVALID_AUDIO_AUTOMATION");
  previous=point.timeSeconds;
 }
 return points;
};
const n=(value)=>Number(value.toFixed(9)).toString();
const gainExpression=(points,baseDb)=>{
 const list=points.filter(point=>point.gainDb!==undefined),gain=db=>Math.pow(10,Math.max(-60,Math.min(24,Number(db)||0))/20);
 if(!list.length)return n(gain(baseDb));
 let expression=n(gain(list[list.length-1].gainDb));
 for(let i=list.length-1;i>=0;i--){
  const point=list[i],from=i?list[i-1].timeSeconds:0,to=point.timeSeconds,fromGain=i?gain(list[i-1].gainDb):gain(baseDb),toGain=gain(point.gainDb);
  const segment=point.interpolation==="step"||to<=from?n(fromGain):"("+n(fromGain)+"+("+n(toGain)+"-"+n(fromGain)+")*((t-"+n(from)+")/("+n(to)+"-"+n(from)+")))";
  expression="if(lt(t,"+n(to)+"),"+segment+","+expression+")";
 }
 return expression;
};
const panExpressions=(points,basePan,channels)=>{
 const list=points.filter(point=>point.pan!==undefined),pan=value=>Math.max(-1,Math.min(1,Number.isFinite(value)?value:0));
 if(channels!==1&&!list.length&&pan(basePan)===0)return null;
 let expression=n(pan(list.length?list[list.length-1].pan:basePan));
 for(let i=list.length-1;i>=0;i--){
  const point=list[i],from=i?list[i-1].timeSeconds:0,to=point.timeSeconds,fromPan=i?pan(list[i-1].pan):pan(basePan),toPan=pan(point.pan);
  const segment=point.interpolation==="step"||to<=from?n(fromPan):"("+n(fromPan)+"+("+n(toPan)+"-"+n(fromPan)+")*((t-"+n(from)+")/("+n(to)+"-"+n(from)+")))";
  expression="if(lt(t,"+n(to)+"),"+segment+","+expression+")";
 }
 const p="("+expression+")",halfPi=n(Math.PI/2);
 if(channels===1){const angle="((("+p+")+1)/2)*"+halfPi;return{left:"val(0)*cos("+angle+")",right:"val(0)*sin("+angle+")"};}
 const x="if(lte("+p+",0),("+p+")+1,"+p+")",angle="("+x+")*"+halfPi;
 return{left:"if(lte("+p+",0),val(0)+val(1)*cos("+angle+"),val(0)*cos("+angle+"))",right:"if(lte("+p+",0),val(1)*sin("+angle+"),val(1)+val(0)*sin("+angle+"))"};
};

const safeName=(value)=>String(value||"sequence").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"").trim().replace(/[ .]+$/,"").slice(0,100)||"sequence";
const usesOpticalFlow=(clip)=>{
 const mode=clip?.metadata?.motionInterpolation;
 if(mode===undefined||mode===null||mode===""||mode==="off")return false;
 if(mode!=="optical-flow")fail("Motion interpolation mode is invalid.","INVALID_MOTION_INTERPOLATION");
 const speed=normalizeClipSpeed(clip?.speed??1),curve=clip?.speedCurve;
 const hasSlowSection=speed<1||(Array.isArray(curve)&&curve.some(point=>Number(point?.speed)<1));
 if(!hasSlowSection)fail("Optical-flow interpolation is available only when the clip contains a slow-motion section below 1×.","MOTION_INTERPOLATION_REQUIRES_SLOW_MOTION");
 return true;
};

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
 for(const track of tracks)for(const clip of track.clips||[])if(enabled(clip))validateClipTiming(clip,track.kind);
 const videos=tracks.filter(track=>track.kind==="video"),audios=tracks.filter(track=>track.kind==="audio"),overlays=tracks.filter(track=>track.kind==="overlay"),captions=tracks.filter(track=>track.kind==="caption");
 const unsupported=tracks.filter(track=>!["video","audio","overlay","caption"].includes(track.kind));
 if(videos.length!==1||unsupported.length)fail("The master renderer requires exactly one primary video track and supported audio, overlay and caption tracks.","UNSUPPORTED_TIMELINE_FEATURE");
 const clips=ordered(videos),audioClips=audios.flatMap(track=>ordered([track])),overlayClips=overlays.flatMap(track=>ordered([track])),captionClips=captions.flatMap(track=>ordered([track]));
 const motionClips=clips.filter(usesOpticalFlow);
 if(motionClips.length){
  const capabilities=await run("ffmpeg",["-hide_banner","-filters"],15000,jobId,activeProcesses,()=>Boolean(signal?.aborted),262144);
  if(!/\bminterpolate\b/.test((capabilities.stdout||"")+"\n"+(capabilities.stderr||"")))fail("This FFmpeg worker does not include the minterpolate filter required for optical-flow slow motion.","MOTION_INTERPOLATION_UNAVAILABLE");
 }
 if(tracks.some(track=>track.kind!=="video"&&(track.clips||[]).some(clip=>enabled(clip)&&clip.transitionToNext!==undefined)))fail("Transitions are supported only on the primary video track.","INVALID_TIMELINE_TRANSITION");
 const fps=Math.max(1,Math.min(120,Math.floor(Number(timeline.frameRate?.numerator)||24)))/Math.max(1,Math.min(1001,Math.floor(Number(timeline.frameRate?.denominator)||1)));
 for(let index=0;index<clips.length;index++){
  const clip=clips[index],transition=clip.transitionToNext;
  if(transition===undefined)continue;
  const fadeFrames=Number(transition?.fadeFrames),durationFrames=Math.round(seconds(clip.duration)*fps),next=clips[index+1];
  if(transition?.type!=="dip-to-black"||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>durationFrames)fail("Video dip-to-black transitions require a positive integer fade length no longer than the outgoing clip.","INVALID_TIMELINE_TRANSITION");
  if(!next||Math.abs(seconds(next.timelineStart)-(seconds(clip.timelineStart)+seconds(clip.duration)))>0.5/fps)fail("A dip-to-black transition requires the next enabled video clip to begin immediately after this clip.","INVALID_TIMELINE_TRANSITION");
  if(fadeFrames>Math.round(seconds(next.duration)*fps))fail("The transition fade cannot be longer than the incoming clip.","INVALID_TIMELINE_TRANSITION");
 }
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
 const audioChannelCache=new Map();
 const getAudioChannels=async(path)=>{
  if(audioChannelCache.has(path))return audioChannelCache.get(path);
  const result=await run("ffprobe",["-v","error","-select_streams","a:0","-show_entries","stream=channels","-of","json",path],60000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
  let metadata;try{metadata=JSON.parse(result.stdout||"{}");}catch{fail("Audio channel metadata could not be read.","AUDIO_CHANNEL_METADATA_INVALID");}
  const channels=Number(metadata.streams?.[0]?.channels);
  if(!Number.isSafeInteger(channels)||channels<1)fail("Audio source has no supported audio channel layout.","AUDIO_CHANNEL_LAYOUT_UNSUPPORTED");
  audioChannelCache.set(path,channels);return channels;
 };
 const getAsset=(assetId)=>{
  const entry=assets.get(String(assetId));
  if(!entry||typeof entry.path!=="string"||!entry.asset)fail("A timeline source asset is missing or inaccessible.","SOURCE_ASSET_NOT_FOUND");
  const asset=entry.asset;
  return{path:entry.path,id:asset.id,mediaType:asset.mediaType||asset.media_type,originalName:asset.originalName||asset.original_name||asset.name||"",size:asset.size,sha256:asset.sha256};
 };
 try{
  for(const [clipPosition,clip] of clips.entries()){
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const start=seconds(clip.timelineStart),duration=seconds(clip.duration);
   if(duration<=0)continue;
   const speed=normalizeClipSpeed(clip.speed??1),sourceDuration=sourceDurationForClip(clip,duration),speedExpression=buildVariableSpeedSetptsExpression(clip,duration);
   if(start+0.000001<cursor)fail("Primary video track contains overlapping clips.","TIMELINE_OVERLAP");
   if(start>cursor+0.000001){
    const gap=start-cursor;args.push("-f","lavfi","-t",gap.toFixed(6),"-i",`color=c=black:s=${width}x${height}:r=${fpsNum}/${fpsDen}`);
    const label="v"+segmentIndex++;segments.push({label,filter:`[${inputIndex}:v]fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`});inputIndex++;
   }
   const asset=getAsset(clip.assetId),mediaType=String(asset.mediaType||"");
   if(mediaType.startsWith("image/")){if(speed!==1||clip.speedCurve!==undefined)fail("Still-image clips do not support speed changes.","UNSUPPORTED_IMAGE_TIME_REMAP");args.push("-loop","1","-t",duration.toFixed(6),"-i",asset.path);}
   else if(mediaType.startsWith("video/"))args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",sourceDuration.toFixed(6),"-i",asset.path);
   else fail("Only still images and video clips are supported on the primary video track.","UNSUPPORTED_MEDIA_TYPE");
   const label="v"+segmentIndex++;
   const effect=buildTimelineClipEffects(clip.metadata||{});
   const retimeFilter=speedExpression ? "setpts='"+speedExpression+"/TB'" : speed===1 ? null : "setpts=(PTS-STARTPTS)/"+speed.toFixed(6);
    const previous=clips[clipPosition-1],fadeInFrames=previous?.transitionToNext?.type==="dip-to-black"?previous.transitionToNext.fadeFrames:0,fadeOutFrames=clip.transitionToNext?.type==="dip-to-black"?clip.transitionToNext.fadeFrames:0;
    const fadeIn=fadeInFrames/fps,fadeOut=fadeOutFrames/fps;
    const filters=["trim=duration="+sourceDuration.toFixed(6),"setpts=PTS-STARTPTS",...(retimeFilter?[retimeFilter]:[]),...(usesOpticalFlow(clip)?["minterpolate=fps="+fpsNum+"/"+fpsDen+":mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"]:[]),...effect.preScale,"scale="+width+":"+height+":force_original_aspect_ratio=decrease","pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2","fps="+fpsNum+"/"+fpsDen,"format=yuv420p",...effect.postScale,"setsar=1",...(fadeIn>0?["fade=t=in:st=0:d="+fadeIn.toFixed(6)+":color=black"]:[]),...(fadeOut>0?["fade=t=out:st="+Math.max(0,duration-fadeOut).toFixed(6)+":d="+fadeOut.toFixed(6)+":color=black"]:[])];
   segments.push({label,filter:`[${inputIndex}:v]${filters.join(",")}[${label}]`,effectsEnabled:effect.enabled});
   inputIndex++;cursor=start+duration;onProgress(Math.min(65,8+Math.round(segmentIndex/Math.max(clips.length,1)*55)));
  }
  if(!segments.length)fail("No renderable clips were found.","EMPTY_TIMELINE");
  let audioIndex=0;
  for(const clip of audioClips){
   const start=seconds(clip.timelineStart);if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   const speed=normalizeClipSpeed(clip.speed??1),sourceDuration=sourceDurationForTimeline(duration,speed);
   const asset=getAsset(clip.assetId);if(!String(asset.mediaType||"").startsWith("audio/"))fail("Audio tracks require audio source assets.","UNSUPPORTED_AUDIO_SOURCE");
   args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",sourceDuration.toFixed(6),"-i",asset.path);
   const delay=Math.round(start*1000),label="a"+audioIndex++,points=audioPoints(clip,seconds(clip.duration)),tempo=buildAtempoFilter(speed),baseGainDb=Math.max(-60,Math.min(24,Number(clip.gainDb)||0)),basePan=Math.max(-1,Math.min(1,Number(clip.pan)||0)),gain=gainExpression(points,baseGainDb),channels=await getAudioChannels(asset.path),pan=panExpressions(points,basePan,channels);
   const panInput=channels>2?"aformat=channel_layouts=stereo,":"";
   const panFilter=pan?","+panInput+"aeval=exprs='"+pan.left+"|"+pan.right+"':channel_layout=stereo":"";
   audioFilters.push(`[${inputIndex}:a]atrim=duration=${sourceDuration.toFixed(6)},asetpts=PTS-STARTPTS${tempo?","+tempo:""},volume='${gain}':eval=frame${panFilter},adelay=${delay}|${delay},apad=whole_dur=${cursor.toFixed(6)},atrim=duration=${cursor.toFixed(6)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`);
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
   const measurementRun=await run("ffmpeg",["-hide_banner","-nostats","-i",outputPath,"-filter_complex","[0:a:0]ebur128=peak=true[audio_qc]","-map","[audio_qc]","-f","null","-"],60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const measured=parseAudioLoudnessMeasurement(measurementRun.stderr);
   if(measured.integratedLoudness===null||measured.loudnessRange===null||measured.truePeak===null)fail("The rendered audio could not be measured for integrated loudness, loudness range and true peak.","AUDIO_MASTERING_QC_UNAVAILABLE");
   const masteringProfile=timeline.audioMastering?.profile??"custom";
   const targetLoudness=masteringProfile==="ebu-r128"?-23:masteringProfile==="web-podcast"?-16:Number(timeline.audioMastering?.integratedLoudness??-16);
   const targetTruePeak=Number(timeline.audioMastering?.truePeak??-1.5);
   const targetLoudnessRange=Number(timeline.audioMastering?.loudnessRange??11);
   masteringEvidence={applied:true,profile:masteringProfile,integratedLoudness:targetLoudness,loudnessRange:targetLoudnessRange,truePeak:targetTruePeak,dualMono:timeline.audioMastering?.dualMono===true,measurement:measured,qualityControl:evaluateAudioMasteringQuality(measured,{profile:masteringProfile,integratedLoudness:targetLoudness,loudnessRange:targetLoudnessRange,truePeak:targetTruePeak})};
  }
  return{path:outputPath,filename:name+"-master.mp4",mediaType:"video/mp4",render:{width,height,frameRate:{numerator:fpsNum,denominator:fpsDen},videoClips:clips.length,audioClips:audioClips.length,overlayClips:overlayClips.length,captionClips:captionClips.length,effectClips:segments.filter(segment=>segment.effectsEnabled).length,transitions:clips.filter(clip=>clip.transitionToNext?.type==="dip-to-black").length,motionInterpolatedClips:motionClips.length,durationSeconds:cursor,audioMastering:masteringEvidence}};
 }catch(error){
  await unlink(outputPath).catch(()=>{});
  if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
  throw error;
 }finally{await Promise.all(captionTempPaths.map(path=>unlink(path).catch(()=>{})));}
}
