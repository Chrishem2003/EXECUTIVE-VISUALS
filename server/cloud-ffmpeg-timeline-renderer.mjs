import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { captionStyle, buildSrt, escapeFilterPath, run, validateMediaOutputProbe } from "./media.mjs";
import { buildLoudnormAnalysisArgs, parseLoudnormMeasurements, buildLoudnormNormalizationArgs, parseLoudnormOutput, buildLoudnormOutputFindings } from "./media-signal-analysis.mjs";

const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};
const seconds=(time)=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)return 0;return Math.max(0,Math.min(86400,value/rate));};
const enabled=(clip)=>clip?.enabled!==false;
const ordered=(tracks)=>tracks.flatMap(track=>(track.clips||[]).filter(enabled)).sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
const safeName=(value)=>String(value||"sequence").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"").trim().replace(/[ .]+$/,"").slice(0,100)||"sequence";
const DELIVERY_PROFILES={
 source:{id:"source",label:"Source dimensions",width:null,height:null,audioBitrate:"192k"},
 "youtube-1080p":{id:"youtube-1080p",label:"YouTube 1080p H.264",width:1920,height:1080,audioBitrate:"384k"},
 "vertical-1080p":{id:"vertical-1080p",label:"Vertical 1080p H.264",width:1080,height:1920,audioBitrate:"192k"},
 "square-1080p":{id:"square-1080p",label:"Square 1080p H.264",width:1080,height:1080,audioBitrate:"192k"}
};

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
 if(channels===1){
  const angle="((("+p+")+1)/2)*"+halfPi;
  return{left:"val(0)*cos("+angle+")",right:"val(0)*sin("+angle+")"};
 }
 const x="if(lte("+p+",0),("+p+")+1,"+p+")",angle="("+x+")*"+halfPi;
 return{
  left:"if(lte("+p+",0),val(0)+val(1)*cos("+angle+"),val(0)*cos("+angle+"))",
  right:"if(lte("+p+",0),val(1)*sin("+angle+"),val(1)+val(0)*sin("+angle+"))"
 };
};

/**
 * FFmpeg timeline renderer for cloud-materialized assets.
 * It shares the local renderer's caption and process primitives but has no
 * SQLite, local asset repository, or local media-root dependency.
 */
export async function renderCloudTimeline({timeline,assets,workDir,signal,onProgress=()=>{},activeProcesses=new Map(),jobId=null,mastering=null,deliveryProfile="source"}={}){
 if(!timeline||!Array.isArray(timeline.tracks)||!(assets instanceof Map)||typeof workDir!=="string")throw new Error("Cloud timeline renderer received invalid inputs.");
 if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
 const tracks=timeline.tracks.filter(track=>track.enabled!==false&&(track.clips||[]).some(enabled));
 const videos=tracks.filter(track=>track.kind==="video"),audios=tracks.filter(track=>track.kind==="audio"),overlays=tracks.filter(track=>track.kind==="overlay"),captions=tracks.filter(track=>track.kind==="caption");
 const unsupported=tracks.filter(track=>!["video","audio","overlay","caption"].includes(track.kind));
 if(videos.length!==1||unsupported.length)fail("The master renderer requires exactly one primary video track and supported audio, overlay and caption tracks.","UNSUPPORTED_TIMELINE_FEATURE");
 const clips=ordered(videos),audioClips=audios.flatMap(track=>ordered([track])),overlayClips=overlays.flatMap(track=>ordered([track])),captionClips=captions.flatMap(track=>ordered([track]));
 if(!clips.length)fail("Add at least one enabled clip to the primary video track.","EMPTY_TIMELINE");
 const profile=DELIVERY_PROFILES[deliveryProfile];
 if(!profile)fail("Delivery profile is not supported.","INVALID_DELIVERY_PROFILE");
 const width=profile.width||Math.max(256,Math.min(7680,Math.floor(Number(timeline.width)||1920)));
 const height=profile.height||Math.max(144,Math.min(4320,Math.floor(Number(timeline.height)||1080)));
 const fpsNum=Math.max(1,Math.min(120,Math.floor(Number(timeline.frameRate?.numerator)||24)));
 const fpsDen=Math.max(1,Math.min(1001,Math.floor(Number(timeline.frameRate?.denominator)||1)));
 const outputId=randomUUID(),outputPath=join(workDir,outputId+".mp4");
 let masteringOutputPath=null,finalOutputPath=outputPath,masteringReport=null;
 await mkdir(workDir,{recursive:true});
 const args=["-hide_banner","-y"],segments=[],audioFilters=[],videoEffects=[],captionTempPaths=[],overlayInputs=[];
 let cursor=0,inputIndex=0,segmentIndex=0,captionIndex=0;
 const getAsset=(assetId)=>{
  const entry=assets.get(String(assetId));
  if(!entry||typeof entry.path!=="string"||!entry.asset)fail("A timeline source asset is missing or inaccessible.","SOURCE_ASSET_NOT_FOUND");
  const asset=entry.asset;
  return{path:entry.path,id:asset.id,mediaType:asset.mediaType||asset.media_type,originalName:asset.originalName||asset.original_name||asset.name||"",size:asset.size,sha256:asset.sha256};
 };
 const audioChannelCache=new Map();
 const getAudioChannels=async(path)=>{
  if(audioChannelCache.has(path))return audioChannelCache.get(path);
  const result=await run("ffprobe",["-v","error","-select_streams","a:0","-show_entries","stream=channels","-of","json",path],60000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
  let metadata;
  try{metadata=JSON.parse(result.stdout||"{}");}catch{fail("Audio channel metadata could not be read.","AUDIO_CHANNEL_METADATA_INVALID");}
  const channels=Number(metadata.streams?.[0]?.channels);
  if(!Number.isSafeInteger(channels)||channels<1)fail("Audio source has no supported audio channel layout.","AUDIO_CHANNEL_LAYOUT_UNSUPPORTED");
  audioChannelCache.set(path,channels);
  return channels;
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
   segments.push({label,filter:`[${inputIndex}:v]trim=duration=${duration.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1[${label}]`});
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
   const delay=Math.round(start*1000),label="a"+audioIndex++,points=audioPoints(clip,duration),baseGainDb=Math.max(-60,Math.min(24,Number(clip.gainDb)||0)),basePan=Math.max(-1,Math.min(1,Number(clip.pan)||0)),gain=gainExpression(points,baseGainDb),channels=await getAudioChannels(asset.path),pan=panExpressions(points,basePan,channels);
   const panInput=channels>2?"aformat=channel_layouts=stereo,":"";
   const panFilter=pan?","+panInput+"aeval=exprs='"+pan.left+"|"+pan.right+"':channel_layout=stereo":"";
   audioFilters.push(`[${inputIndex}:a]atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS,volume='${gain}':eval=frame${panFilter},adelay=${delay}|${delay},apad=whole_dur=${cursor.toFixed(6)},atrim=duration=${cursor.toFixed(6)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[${label}]`);
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
  const filters=[videoGraph,...videoEffects,audioFilters.length?audioFilters.join(";")+";"+audioFilters.map((_,i)=>`[a${i}]`).join("")+`amix=inputs=${audioFilters.length}:duration=longest:dropout_transition=0,alimiter=limit=0.95[aout]`:""].filter(Boolean).join(";");
  args.push("-filter_complex_threads","1","-filter_complex",filters,"-map",currentVideo);
  if(audioFilters.length)args.push("-map","[aout]","-c:a","aac","-b:a",profile.audioBitrate,"-ar","48000");else args.push("-an");
  args.push("-c:v","libx264","-profile:v","high","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-r",`${fpsNum}/${fpsDen}`,outputPath);
  await run("ffmpeg",args,60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
  if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
  if(mastering!==null&&mastering!==undefined&&typeof mastering!=="object")fail("Mastering settings must be an object.","INVALID_MASTERING_OPTIONS");
  if(mastering?.enabled===true){
   if(!audioFilters.length)fail("Opt-in mastering requires at least one enabled audio track.","MASTERING_AUDIO_REQUIRED");
   const settings={integratedLufs:mastering.integratedLufs??-16,loudnessRange:mastering.loudnessRange??11,truePeakDbtp:mastering.truePeakDbtp??-1.5,dualMono:mastering.dualMono??false,tolerance:mastering.tolerance??0.5};
   onProgress(91);
   const analysisArgs=buildLoudnormAnalysisArgs({inputPath:outputPath,...settings});
   const analysis=await run("ffmpeg",analysisArgs,60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const measurements=parseLoudnormMeasurements(analysis.stderr||analysis.stdout);
   if(!measurements)fail("Mastering analysis did not return complete EBU R128 measurements.","LOUDNORM_ANALYSIS_FAILED");
   masteringOutputPath=join(workDir,outputId+"-mastered.mp4");
   const normalizationArgs=buildLoudnormNormalizationArgs({inputPath:outputPath,outputPath:masteringOutputPath,measurements,...settings,audioBitrate:profile.audioBitrate});
   onProgress(94);
   const normalized=await run("ffmpeg",normalizationArgs,60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const output=parseLoudnormOutput(normalized.stderr||normalized.stdout);
   if(!output)fail("Mastering output did not return verifiable EBU R128 results.","LOUDNORM_OUTPUT_UNVERIFIED");
   const findings=buildLoudnormOutputFindings(output,settings);
   const probeResult=await run("ffprobe",["-v","error","-show_format","-show_streams","-of","json",masteringOutputPath],60000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
   let metadata;
   try{metadata=JSON.parse(probeResult.stdout||"{}");}catch{fail("Mastered output metadata could not be parsed.","MEDIA_OUTPUT_VALIDATION_FAILED");}
   validateMediaOutputProbe(metadata,"video/mp4");
   if(!metadata.streams?.some(stream=>stream?.codec_type==="audio"))fail("Mastered output is missing its audio stream.","MEDIA_OUTPUT_VALIDATION_FAILED");
   masteringReport={enabled:true,targets:{integratedLufs:settings.integratedLufs,loudnessRange:settings.loudnessRange,truePeakDbtp:settings.truePeakDbtp},measurements,output,findings,verified:findings.length===0};
   await unlink(outputPath).catch(()=>{});
   finalOutputPath=masteringOutputPath;
  }
  if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
  onProgress(98);
  const name=safeName(timeline.name);
  return{path:finalOutputPath,filename:name+"-master.mp4",mediaType:"video/mp4",...(masteringReport?{mastering:masteringReport}:{}),render:{deliveryProfile:profile.id,deliveryLabel:profile.label,width,height,frameRate:{numerator:fpsNum,denominator:fpsDen},videoClips:clips.length,audioClips:audioClips.length,automatedAudioClips:audioClips.filter(clip=>(clip.audioAutomation||[]).length>0||Number(clip.pan)!==0).length,overlayClips:overlayClips.length,captionClips:captionClips.length,durationSeconds:cursor}};
 }catch(error){
  await Promise.all([outputPath,masteringOutputPath].filter(Boolean).map(path=>unlink(path).catch(()=>{})));
  if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
  throw error;
 }finally{await Promise.all(captionTempPaths.map(path=>unlink(path).catch(()=>{})));}
}
