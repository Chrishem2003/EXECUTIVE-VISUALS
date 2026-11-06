import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { captionStyle, buildSrt, escapeFilterPath, run } from "./media.mjs";

const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};
const seconds=(time)=>{const value=Number(time?.value),rate=Number(time?.rate);if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)return 0;return Math.max(0,Math.min(86400,value/rate));};
const enabled=(clip)=>clip?.enabled!==false;
const ordered=(tracks)=>tracks.flatMap(track=>(track.clips||[]).filter(enabled)).sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
const safeName=(value)=>String(value||"sequence").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"").trim().replace(/[ .]+$/,"").slice(0,100)||"sequence";
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
const speedSegments=(clip,duration)=>{
 const curve=clip.speedCurve;
 if(curve===undefined)return null;
 const clipDuration=seconds(clip.duration);
 if(!Array.isArray(curve)||curve.length<2||curve.length>64||curve[0]?.timeSeconds!==0||duration>clipDuration+1e-9||curve.some((point,index)=>!point||!Number.isFinite(point.timeSeconds)||!Number.isFinite(point.speed)||point.speed<0.25||point.speed>4||point.timeSeconds<0||point.timeSeconds>clipDuration||(index>0&&point.timeSeconds<=curve[index-1].timeSeconds)))fail("Variable-speed keyframes must be ordered, start at zero, contain 2–64 points and stay within the clip at 0.25×–4×.","INVALID_SPEED_CURVE");
 const evaluate=time=>{
  for(let index=1;index<curve.length;index++){
   const left=curve[index-1],right=curve[index];
   if(time<=right.timeSeconds){const span=right.timeSeconds-left.timeSeconds,ratio=span>0?(time-left.timeSeconds)/span:1;return left.speed+(right.speed-left.speed)*ratio;}
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
const sourceDurationForClip=(clip,duration)=>{
 const segments=speedSegments(clip,duration);
 return segments?segments.reduce((total,segment)=>total+segment.sourceEnd-segment.sourceStart,0):duration*Math.max(0.25,Math.min(4,Number(clip.speed??1)));
};
const motionInterpolationFilter=(clip,timelineFps)=>{
 const multiplier=clip.metadata?.motionInterpolationMultiplier;
 if(multiplier===undefined)return "";
 if(![2,4].includes(Number(multiplier)))fail("Motion interpolation multiplier must be 2× or 4×.","INVALID_MOTION_INTERPOLATION");
 const targetFps=Math.min(120,timelineFps*Number(multiplier));
 return "minterpolate=fps="+targetFps.toFixed(3)+":mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,";
};
export const buildVariableSpeedSetptsExpression=(clip,duration)=>{
 const segments=speedSegments(clip,duration);
 if(!segments)return null;
 let expression="("+n(duration)+"+(T-"+n(segments[segments.length-1].sourceEnd)+")/"+n(segments[segments.length-1].endSpeed)+")";
 for(let index=segments.length-1;index>=0;index--){
  const segment=segments[index],delta="(T-"+n(segment.sourceStart)+")";
  const local=Math.abs(segment.slope)<1e-9?delta+"/"+n(segment.startSpeed):"2*"+delta+"/("+n(segment.startSpeed)+"+sqrt("+n(segment.startSpeed*segment.startSpeed)+"+2*"+n(segment.slope)+"*"+delta+"))";
  const mapped="("+n(segment.timelineStart)+"+("+local+"))";
  expression="if(lt(T,"+n(segment.sourceEnd)+"),"+mapped+","+expression+")";
 }
 return expression;
};
const speedAtTimeline=(segments,time)=>{
 const segment=segments.find(item=>time<=item.timelineEnd+1e-9)||segments[segments.length-1];
 const elapsed=Math.max(0,Math.min(segment.timelineEnd-segment.timelineStart,time-segment.timelineStart));
 return segment.startSpeed+segment.slope*elapsed;
};
const sourceAtTimeline=(segments,time)=>{
 const segment=segments.find(item=>time<=item.timelineEnd+1e-9)||segments[segments.length-1];
 const elapsed=Math.max(0,Math.min(segment.timelineEnd-segment.timelineStart,time-segment.timelineStart));
 return segment.sourceStart+segment.startSpeed*elapsed+0.5*segment.slope*elapsed*elapsed;
};
const buildRubberbandCommands=(clip,duration,fps)=>{
 const segments=speedSegments(clip,duration);
 if(!segments)return null;
 const frameCount=Math.ceil(duration*fps);
 if(frameCount>100000)fail("Variable-speed audio automation exceeds the 100,000-command render safety limit.","SPEED_CURVE_COMPLEXITY_LIMIT");
 const commands=[];
 for(let frame=1;frame<frameCount;frame++){
  const timelineTime=frame/fps,sourceTime=sourceAtTimeline(segments,timelineTime),speed=speedAtTimeline(segments,timelineTime);
  commands.push(n(sourceTime)+" rubberband@rb tempo "+n(speed)+";");
 }
 return commands.length?commands.join("\n")+"\n":"";
};


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
const panExpressions=(points,basePan,channels=2)=>{
 const list=points.filter(point=>point.pan!==undefined),pan=value=>Math.max(-1,Math.min(1,Number.isFinite(value)?value:0));
 if(!list.length&&pan(basePan)===0&&channels!==1)return null;
 let expression=n(pan(basePan));
 for(let i=list.length-1;i>=0;i--){
  const point=list[i],from=i?list[i-1].timeSeconds:0,to=point.timeSeconds,fromPan=i?pan(list[i-1].pan):pan(basePan),toPan=pan(point.pan);
  const segment=point.interpolation==="step"||to<=from?n(fromPan):"("+n(fromPan)+"+("+n(toPan)+"-"+n(fromPan)+")*((t-"+n(from)+")/("+n(to)+"-"+n(from)+")))";
  expression="if(lt(t,"+n(to)+"),"+segment+","+expression+")";
 }
 const p="("+expression+")",halfPi="1.5707963267948966",quarterPi="0.7853981633974483";
 if(channels===1){
  const angle="(("+p+"+1)*"+quarterPi+")";
  return{left:"val(0)*cos("+angle+")",right:"val(0)*sin("+angle+")"};
 }
 const angle="(if(lt("+p+",0),("+p+"+1),"+p+")*"+halfPi+")";
 return{
  left:"if(lt("+p+",0),val(0)+val(1)*cos("+angle+"),val(0)*cos("+angle+"))",
  right:"if(lt("+p+",0),val(1)*sin("+angle+"),val(1)+val(0)*sin("+angle+"))"
 };
};

/**
 * FFmpeg timeline renderer for cloud-materialized assets.
 * It shares the local renderer's caption and process primitives but has no
 * SQLite, local asset repository, or local media-root dependency.
 */
export async function renderCloudTimeline({timeline,assets,workDir,signal,onProgress=()=>{},activeProcesses=new Map(),jobId=null}={}){
 if(!timeline||!Array.isArray(timeline.tracks)||!(assets instanceof Map)||typeof workDir!=="string")throw new Error("Cloud timeline renderer received invalid inputs.");
 if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
 const tracks=timeline.tracks.filter(track=>track.enabled!==false&&(track.clips||[]).some(enabled));
 const videos=tracks.filter(track=>track.kind==="video"),audios=tracks.filter(track=>track.kind==="audio"),overlays=tracks.filter(track=>track.kind==="overlay"),captions=tracks.filter(track=>track.kind==="caption");
 const unsupported=tracks.filter(track=>!["video","audio","overlay","caption"].includes(track.kind));
 if(tracks.some(track=>(track.kind!=="video"&&track.kind!=="audio")&&(track.clips||[]).some(clip=>clip.transitionToNext!==undefined)))fail("Transitions are supported only on video and audio tracks.","INVALID_TIMELINE_TRANSITION");
 if(audios.some(track=>(track.clips||[]).some(clip=>clip.transitionToNext!==undefined&&clip.transitionToNext.type!=="crossfade")))fail("Audio tracks support crossfade transitions only.","INVALID_TIMELINE_TRANSITION");
 if(videos.length<1||unsupported.length)fail("The master renderer requires at least one video track and supported audio, overlay and caption tracks.","UNSUPPORTED_TIMELINE_FEATURE");

 const clips=ordered([videos[0]]),audioClips=audios.flatMap(track=>ordered([track])),overlayClips=overlays.flatMap(track=>ordered([track])),captionClips=captions.flatMap(track=>ordered([track]));
 const fpsNum=Math.max(1,Math.min(120,Math.floor(Number(timeline.frameRate?.numerator)||24)));
 const fpsDen=Math.max(1,Math.min(1001,Math.floor(Number(timeline.frameRate?.denominator)||1)));
 const fps=fpsNum/fpsDen;
 for(const track of videos.slice(1)){
  const trackClips=ordered([track]);
  for(let index=0;index<trackClips.length;index++){
   const clip=trackClips[index],transition=clip.transitionToNext;if(transition===undefined)continue;
   const fadeFrames=Number(transition?.fadeFrames),durationFrames=Math.round(seconds(clip.duration)*fps),next=trackClips[index+1];
   if(transition?.type!=="dip-to-black"||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>durationFrames)fail("Secondary video dip-to-black transitions require a positive integer fade length no longer than the outgoing clip.","INVALID_TIMELINE_TRANSITION");
   if(!next||Math.abs(seconds(next.timelineStart)-(seconds(clip.timelineStart)+seconds(clip.duration)))>0.5/fps)fail("A secondary video dip-to-black transition requires the next clip on that track to begin immediately after this clip.","INVALID_TIMELINE_TRANSITION");
   if(fadeFrames>Math.round(seconds(next.duration)*fps))fail("The secondary transition fade cannot be longer than the incoming clip.","INVALID_TIMELINE_TRANSITION");
  }
 }
 for(const track of audios){
  const trackClips=ordered([track]);
  for(let index=0;index<trackClips.length;index++){
   const clip=trackClips[index],next=trackClips[index+1],transition=clip.transitionToNext,start=seconds(clip.timelineStart),duration=seconds(clip.duration),fadeFrames=Number(transition?.fadeFrames),durationFrames=Math.round(duration*fps);
   if(transition!==undefined){
    if(transition.type!=="crossfade"||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>durationFrames)fail("Audio crossfades require a positive integer fade length no longer than the outgoing clip.","INVALID_TIMELINE_TRANSITION");
    if(!next||Math.abs(seconds(next.timelineStart)-(start+duration-fadeFrames/fps))>0.5/fps)fail("An audio crossfade requires the next clip to overlap the outgoing clip by exactly the configured fade duration.","INVALID_TIMELINE_TRANSITION");
    if(fadeFrames>Math.round(seconds(next.duration)*fps))fail("The audio crossfade cannot be longer than the incoming clip.","INVALID_TIMELINE_TRANSITION");
    const incomingFade=Number(trackClips[index-1]?.transitionToNext?.type==="crossfade"?trackClips[index-1].transitionToNext.fadeFrames:0);
    if(incomingFade+fadeFrames>durationFrames)fail("Incoming and outgoing audio crossfades cannot overlap more than the duration of a clip.","INVALID_TIMELINE_TRANSITION");
   }
   if(next&&seconds(next.timelineStart)<start+duration-0.000001){
    const overlap=transition?.type==="crossfade"?fadeFrames/fps:0;
    if(!Number.isSafeInteger(fadeFrames)||transition?.type!=="crossfade"||Math.abs((start+duration-seconds(next.timelineStart))-overlap)>0.5/fps)fail("Audio clips overlap without a matching configured crossfade.","TIMELINE_OVERLAP");
   }
  }
 }
 if(!clips.length)fail("Add at least one enabled clip to the primary video track.","EMPTY_TIMELINE");
 const width=Math.max(256,Math.min(7680,Math.floor(Number(timeline.width)||1920)));
 const height=Math.max(144,Math.min(4320,Math.floor(Number(timeline.height)||1080)));
 for(let index=0;index<clips.length;index++){
  const clip=clips[index],transition=clip.transitionToNext;if(transition===undefined)continue;
  const fadeFrames=Number(transition?.fadeFrames),durationFrames=Math.round(seconds(clip.duration)*fps),next=clips[index+1],start=seconds(clip.timelineStart),duration=seconds(clip.duration);
  if((transition?.type!=="dip-to-black"&&transition?.type!=="crossfade")||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>durationFrames)fail("Video transitions require a positive integer fade length no longer than the outgoing clip.","INVALID_TIMELINE_TRANSITION");
  const expectedNextStart=transition.type==="crossfade"?start+duration-fadeFrames/fps:start+duration;
  if(!next||Math.abs(seconds(next.timelineStart)-expectedNextStart)>0.5/fps)fail(transition.type==="crossfade"?"A crossfade requires the next clip to overlap the outgoing clip by exactly the configured fade duration.":"A dip-to-black transition requires the next enabled video clip to begin immediately after this clip.","INVALID_TIMELINE_TRANSITION");
  if(fadeFrames>Math.round(seconds(next.duration)*fps))fail("The transition fade cannot be longer than the incoming clip.","INVALID_TIMELINE_TRANSITION");
  const previous=clips[index-1],incomingFade=previous?.transitionToNext?.type==="crossfade"?Number(previous.transitionToNext.fadeFrames):0;
  if(transition.type==="crossfade"&&incomingFade+fadeFrames>durationFrames)fail("Incoming and outgoing crossfades cannot overlap more than the duration of a clip.","INVALID_TIMELINE_TRANSITION");
 }
 const outputId=randomUUID(),outputPath=join(workDir,outputId+".mp4");
 await mkdir(workDir,{recursive:true});
 const args=["-hide_banner","-y"],segments=[],audioFilters=[],videoEffects=[],captionTempPaths=[],overlayInputs=[],videoOverlayInputs=[];
 const needsRubberband=audios.some(track=>(track.clips||[]).some(clip=>clip.enabled!==false&&clip.speedCurve!==undefined));
 const needsMinterpolate=videos.some(track=>(track.clips||[]).some(clip=>clip.enabled!==false&&clip.metadata?.motionInterpolationMultiplier!==undefined));
 let filterListing="";
 if(needsRubberband||needsMinterpolate){
  const capabilities=await run("ffmpeg",["-hide_banner","-filters"],15000,jobId,activeProcesses,()=>Boolean(signal?.aborted),1024*1024);
  filterListing=capabilities.stdout+"\n"+capabilities.stderr;
  if(needsRubberband&&!/\brubberband\b/.test(filterListing))fail("Variable-speed audio export requires an FFmpeg build with librubberband support; this render worker does not provide that filter.","RUBBERBAND_UNAVAILABLE");
  if(needsMinterpolate&&!/\bminterpolate\b/.test(filterListing))fail("Optical-flow slow motion requires FFmpeg's minterpolate filter; this render worker does not provide it.","MINTERPOLATE_UNAVAILABLE");
 }
 let cursor=0,inputIndex=0,segmentIndex=0,captionIndex=0;
 const getAsset=(assetId)=>{
  const entry=assets.get(String(assetId));
  if(!entry||typeof entry.path!=="string"||!entry.asset)fail("A timeline source asset is missing or inaccessible.","SOURCE_ASSET_NOT_FOUND");
  const asset=entry.asset;
  return{path:entry.path,id:asset.id,mediaType:asset.mediaType||asset.media_type,originalName:asset.originalName||asset.original_name||asset.name||"",size:asset.size,sha256:asset.sha256,metadata:asset.metadata||{}};
 };
 try{
  for(const [clipPosition,clip] of clips.entries()){
   if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
   const start=seconds(clip.timelineStart),duration=seconds(clip.duration);
   if(duration<=0)continue;
   if(start+0.000001<cursor){const previous=clips[clipPosition-1],fadeFrames=Number(previous?.transitionToNext?.fadeFrames),expectedStart=seconds(previous?.timelineStart)+seconds(previous?.duration)-fadeFrames/fps;if(previous?.transitionToNext?.type!=="crossfade"||Math.abs(start-expectedStart)>0.5/fps)fail("Primary video track contains overlapping clips without a matching crossfade.","TIMELINE_OVERLAP");}
   if(start>cursor+0.000001){
    const gap=start-cursor;args.push("-f","lavfi","-t",gap.toFixed(6),"-i",`color=c=black:s=${width}x${height}:r=${fpsNum}/${fpsDen}`);
    const label="v"+segmentIndex++;segments.push({label,start:cursor,duration:gap,filter:`[${inputIndex}:v]fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[${label}]`});inputIndex++;
   }
   const asset=getAsset(clip.assetId),mediaType=String(asset.mediaType||"");
   const speed=Math.max(0.25,Math.min(4,Number(clip.speed??1))),sourceDuration=sourceDurationForClip(clip,duration),speedExpression=buildVariableSpeedSetptsExpression(clip,duration);
   if(mediaType.startsWith("image/"))args.push("-loop","1","-t",sourceDuration.toFixed(6),"-i",asset.path);
   else if(mediaType.startsWith("video/"))args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",sourceDuration.toFixed(6),"-i",asset.path);
   else fail("Only still images and video clips are supported on the primary video track.","UNSUPPORTED_MEDIA_TYPE");
   const label="v"+segmentIndex++;
   const previous=clips[clipPosition-1],fadeInFrames=previous?.transitionToNext?.type==="dip-to-black"?previous.transitionToNext.fadeFrames:0,fadeOutFrames=clip.transitionToNext?.type==="dip-to-black"?clip.transitionToNext.fadeFrames:0;
   const fadeIn=fadeInFrames/fps,fadeOut=fadeOutFrames/fps;
   if(clip.metadata?.motionInterpolationMultiplier!==undefined&&!mediaType.startsWith("video/"))fail("Motion interpolation requires a video source, not a still image.","UNSUPPORTED_MOTION_INTERPOLATION_SOURCE");
   let filter=`[${inputIndex}:v]trim=duration=${sourceDuration.toFixed(6)},setpts=PTS-STARTPTS,${speedExpression?`setpts='${speedExpression}/TB'`:`setpts=PTS/${speed.toFixed(6)}`},${motionInterpolationFilter(clip,fps)}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fpsNum}/${fpsDen},format=yuv420p,setsar=1,settb=AVTB`;
   if(fadeIn>0)filter+=`,fade=t=in:st=0:d=${fadeIn.toFixed(6)}:color=black`;
   if(fadeOut>0)filter+=`,fade=t=out:st=${Math.max(0,duration-fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}:color=black`;
   segments.push({label,start,duration,clip,filter:filter+`[${label}]`});
   inputIndex++;cursor=start+duration;onProgress(Math.min(65,8+Math.round(segmentIndex/Math.max(clips.length,1)*55)));
  }
  if(!segments.length)fail("No renderable clips were found.","EMPTY_TIMELINE");
  for(const [trackOrder,track] of videos.slice(1).entries()){
   let secondaryCursor=0;const trackClips=ordered([track]);
   for(const [clipPosition,clip] of trackClips.entries()){
    if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
    const start=seconds(clip.timelineStart),clipDuration=seconds(clip.duration);
    if(start+0.000001<secondaryCursor)fail("Secondary video track contains overlapping clips.","TIMELINE_OVERLAP");
    secondaryCursor=Math.max(secondaryCursor,start+clipDuration);
    const duration=Math.min(clipDuration,Math.max(0,cursor-start));if(duration<=0)continue;
    const asset=getAsset(clip.assetId),mediaType=String(asset.mediaType||"");
    const speed=Math.max(0.25,Math.min(4,Number(clip.speed??1))),sourceDuration=sourceDurationForClip(clip,duration),speedExpression=buildVariableSpeedSetptsExpression(clip,duration);
    if(mediaType.startsWith("image/"))args.push("-loop","1","-t",sourceDuration.toFixed(6),"-i",asset.path);
    else if(mediaType.startsWith("video/"))args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",sourceDuration.toFixed(6),"-i",asset.path);
    else fail("Secondary video tracks require video or still-image assets.","UNSUPPORTED_MEDIA_TYPE");
    const previous=trackClips[clipPosition-1],fadeInFrames=previous?.transitionToNext?.fadeFrames||0,fadeOutFrames=clip.transitionToNext?.fadeFrames||0;
    videoOverlayInputs.push({inputIndex,clip,start,duration,speed,sourceDuration,speedExpression:buildVariableSpeedSetptsExpression(clip,duration),asset,trackOrder,fadeIn:Math.min(fadeInFrames/fps,duration),fadeOut:Math.min(fadeOutFrames/fps,duration)});inputIndex++;
   }
  }
  let audioIndex=0;
  for(const clip of audioClips){
   const start=seconds(clip.timelineStart);if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   const asset=getAsset(clip.assetId);if(!String(asset.mediaType||"").startsWith("audio/"))fail("Audio tracks require audio source assets.","UNSUPPORTED_AUDIO_SOURCE");
   const speed=Math.max(0.25,Math.min(4,Number(clip.speed??1))),sourceDuration=sourceDurationForClip(clip,duration);
   args.push("-ss",seconds(clip.sourceRange?.start).toFixed(6),"-t",sourceDuration.toFixed(6),"-i",asset.path);
   const audioTrack=audios.find(track=>(track.clips||[]).some(item=>item.id===clip.id)),trackClips=audioTrack?ordered([audioTrack]):[],clipIndex=trackClips.findIndex(item=>item.id===clip.id),previousClip=trackClips[clipIndex-1],incomingFadeFrames=previousClip?.transitionToNext?.type==="crossfade"?Number(previousClip.transitionToNext.fadeFrames):0,outgoingFadeFrames=clip.transitionToNext?.type==="crossfade"?Number(clip.transitionToNext.fadeFrames):0,incomingFade=incomingFadeFrames/fps,outgoingFade=outgoingFadeFrames/fps;
   const delay=Math.round(start*1000),label="a"+audioIndex++,points=audioPoints(clip,seconds(clip.duration)),baseGainDb=Math.max(-60,Math.min(24,Number(clip.gainDb)||0)),basePan=Math.max(-1,Math.min(1,Number(clip.pan)||0)),gain=gainExpression(points,baseGainDb),audioProbe=asset.metadata?.probe?.streams?.find(stream=>stream?.codec_type==="audio"),sourceChannels=Number(audioProbe?.channels)||2,pan=panExpressions(points,basePan,sourceChannels===1?1:2);
    const panFilter=pan?(sourceChannels>2?",aformat=channel_layouts=stereo":"")+",aeval=exprs='"+pan.left+"|"+pan.right+"':channel_layout=stereo":"";
   const fadeInFilter=incomingFade>0?",afade=t=in:st=0:d="+incomingFade.toFixed(6)+":curve=tri":"",fadeOutFilter=outgoingFade>0?",afade=t=out:st="+Math.max(0,seconds(clip.duration)-outgoingFade).toFixed(6)+":d="+outgoingFade.toFixed(6)+":curve=tri":"";
   let retimeFilters="";
   if(clip.speedCurve!==undefined){
    const commands=buildRubberbandCommands(clip,duration,fps),commandPath=join(workDir,outputId+"-audio-speed-"+label+".cmd");
    await writeFile(commandPath,commands??"","utf8");captionTempPaths.push(commandPath);
    retimeFilters=",aresample=48000,asetnsamples=n=96:p=0,asendcmd=f='"+escapeFilterPath(commandPath)+"',rubberband@rb=tempo="+n(clip.speedCurve[0].speed)+",apad=whole_dur="+duration.toFixed(6)+",atrim=duration="+duration.toFixed(6);
   }else{
    const tempoParts=[];let tempo=speed;while(tempo>2){tempoParts.push("atempo=2");tempo/=2;}while(tempo<0.5){tempoParts.push("atempo=0.5");tempo/=0.5;}if(Math.abs(tempo-1)>0.000001)tempoParts.push("atempo="+tempo.toFixed(6));
    if(tempoParts.length)retimeFilters=","+tempoParts.join(",");
   }
   audioFilters.push("["+inputIndex+":a]atrim=duration="+sourceDuration.toFixed(6)+",asetpts=PTS-STARTPTS"+retimeFilters+fadeInFilter+fadeOutFilter+",volume='"+gain+"':eval=frame"+panFilter+",adelay="+delay+"|"+delay+",apad=whole_dur="+cursor.toFixed(6)+",atrim=duration="+cursor.toFixed(6)+",aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo["+label+"]");
   inputIndex++;
  }
  for(const clip of overlayClips){
   const start=seconds(clip.timelineStart);if(start>=cursor)continue;
   const duration=Math.min(seconds(clip.duration),cursor-start);if(duration<=0)continue;
   const asset=getAsset(clip.assetId);if(!String(asset.mediaType||"").startsWith("image/"))fail("Overlay tracks require still-image assets.","UNSUPPORTED_OVERLAY_SOURCE");
   args.push("-loop","1","-t",(start+duration).toFixed(6),"-i",asset.path);
   overlayInputs.push({inputIndex,clip});inputIndex++;
  }
  const graphParts=segments.map(item=>item.filter);let currentLabel=segments[0].label;
  for(let index=1;index<segments.length;index++){
   const previous=segments[index-1],next=segments[index],outputLabel="vsequence-"+index;
   if(previous.clip?.transitionToNext?.type==="crossfade"){
    const fade=(Number(previous.clip.transitionToNext.fadeFrames)/fps).toFixed(6),offset=next.start.toFixed(6);
    graphParts.push(`[${currentLabel}][${next.label}]xfade=transition=fade:duration=${fade}:offset=${offset}[${outputLabel}]`);
   }else graphParts.push(`[${currentLabel}][${next.label}]concat=n=2:v=1:a=0[${outputLabel}]`);
   currentLabel=outputLabel;
  }
  const videoGraph=graphParts.join(";");
  let currentVideo=`[${currentLabel}]`;
  for(const [index,item] of videoOverlayInputs.entries()){
   const metadata=item.clip.metadata||{},ow=Math.max(16,Math.min(width,Math.round(Number(metadata.width)||width))),oh=Math.max(16,Math.min(height,Math.round(Number(metadata.height)||height)));
   const x=Math.max(0,Math.min(width-ow,Number.isFinite(Number(metadata.x))?Math.round(Number(metadata.x)):0)),y=Math.max(0,Math.min(height-oh,Number.isFinite(Number(metadata.y))?Math.round(Number(metadata.y)):0)),opacity=Math.max(0,Math.min(1,Number(metadata.opacity??1)));
   const source="video-track-source-"+index,output="video-track-composite-"+index;
   if(item.clip.metadata?.motionInterpolationMultiplier!==undefined&&!String(item.asset.mediaType||"").startsWith("video/"))fail("Motion interpolation requires a video source, not a still image.","UNSUPPORTED_MOTION_INTERPOLATION_SOURCE");
   let sourceFilter=`[${item.inputIndex}:v]trim=duration=${item.sourceDuration.toFixed(6)},setpts=PTS-STARTPTS,${item.speedExpression?`setpts='${item.speedExpression}/TB'`:`setpts=PTS/${item.speed.toFixed(6)}`},${motionInterpolationFilter(item.clip,fps)}scale=${ow}:${oh}:force_original_aspect_ratio=decrease,pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}`;
   if(item.fadeIn>0)sourceFilter+=`,fade=t=in:st=0:d=${item.fadeIn.toFixed(6)}:alpha=1`;
   if(item.fadeOut>0)sourceFilter+=`,fade=t=out:st=${Math.max(0,item.duration-item.fadeOut).toFixed(6)}:d=${item.fadeOut.toFixed(6)}:alpha=1`;
   videoEffects.push(sourceFilter+`,setpts=PTS-STARTPTS+${item.start.toFixed(6)}/TB[${source}]`);
   videoEffects.push(`${currentVideo}[${source}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${item.start.toFixed(6)},${(item.start+item.duration).toFixed(6)})'[${output}]`);
   currentVideo=`[${output}]`;
  }
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
  if(audioFilters.length)args.push("-map","[aout]","-c:a","aac","-b:a","192k");else args.push("-an");
  args.push("-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart","-r",`${fpsNum}/${fpsDen}`,outputPath);
  await run("ffmpeg",args,60*60*1000,jobId,activeProcesses,()=>Boolean(signal?.aborted));
  if(signal?.aborted)fail("Timeline render was cancelled.","JOB_CANCELLED");
  onProgress(90);
  const name=safeName(timeline.name);
  return{path:outputPath,filename:name+"-master.mp4",mediaType:"video/mp4",render:{width,height,frameRate:{numerator:fpsNum,denominator:fpsDen},videoClips:clips.length+videoOverlayInputs.length,primaryVideoClips:clips.length,secondaryVideoClips:videoOverlayInputs.length,retimedVideoClips:clips.filter(clip=>clip.speedCurve!==undefined).length+videoOverlayInputs.filter(item=>item.clip.speedCurve!==undefined).length,secondaryVideoTracks:videos.length-1,audioClips:audioClips.length,retimedAudioClips:audioClips.filter(clip=>clip.speedCurve!==undefined).length,motionInterpolatedVideoClips:clips.filter(clip=>clip.metadata?.motionInterpolationMultiplier!==undefined).length+videoOverlayInputs.filter(item=>item.clip.metadata?.motionInterpolationMultiplier!==undefined).length,automatedAudioClips:audioClips.filter(clip=>(clip.audioAutomation||[]).length>0||Number(clip.pan)!==0).length,audioCrossfades:audios.flatMap(track=>track.clips||[]).filter(clip=>clip.enabled!==false&&clip.transitionToNext?.type==="crossfade").length,overlayClips:overlayClips.length,captionClips:captionClips.length,durationSeconds:cursor,transitions:videos.flatMap(track=>track.clips||[]).filter(clip=>clip.enabled!==false&&["dip-to-black","crossfade"].includes(clip.transitionToNext?.type)).length}};
 }catch(error){
  await unlink(outputPath).catch(()=>{});
  if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
  throw error;
 }finally{await Promise.all(captionTempPaths.map(path=>unlink(path).catch(()=>{})));}
}
