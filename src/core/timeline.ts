import { normalizeAudioAutomation, type AudioAutomationPoint } from "./audio-automation.ts";
export interface RationalTime { value:number; rate:number }
export interface TimeRange { start:RationalTime; duration:RationalTime }
export type TrackKind="video"|"audio"|"overlay"|"caption";
export interface SpeedKeyframe { timeSeconds:number; speed:number }
export interface TimelineTransition { type:"dip-to-black"; fadeFrames:number }
export interface TimelineClip {
  id:string; assetId:string; name:string; sourceRange:TimeRange;
  timelineStart:RationalTime; duration:RationalTime;
  enabled:boolean; gainDb?:number; pan?:number; audioAutomation?:AudioAutomationPoint[]; speed?:number; speedCurve?:SpeedKeyframe[]; transitionToNext?:TimelineTransition; metadata?:Record<string,unknown>;
}
export interface TimelineTrack {
  id:string; name:string; kind:TrackKind; enabled:boolean; locked:boolean;
  clips:TimelineClip[];
}
export interface TimelineMarker {
  id:string; name:string; start:RationalTime; duration?:RationalTime;
  color?:string; note?:string;
}
export interface AudioMasteringSettings { enabled:boolean; profile?:"web-podcast"|"ebu-r128"|"custom"; integratedLoudness?:number; loudnessRange?:number; truePeak?:number; dualMono?:boolean }

export interface AudioMasteringSettingsInput {
  enabled:boolean; profile?:unknown; integratedLoudness?:unknown;
  loudnessRange?:unknown; truePeak?:unknown; dualMono?:boolean;
}
export function normalizeAudioMasteringSettings(input:AudioMasteringSettingsInput):AudioMasteringSettings {
  const profile=input.profile??"web-podcast";
  if(profile!=="web-podcast"&&profile!=="ebu-r128"&&profile!=="custom")throw new Error("Select a supported audio mastering profile.");
  const integratedLoudness=profile==="ebu-r128"?-23:profile==="web-podcast"?-16:Number(input.integratedLoudness);
  const loudnessRange=Number(input.loudnessRange??11),truePeak=Number(input.truePeak??-1.5);
  if(profile==="ebu-r128"&&truePeak> -1)throw new Error("EBU R128 true peak must not exceed -1 dBTP.");
  if(!Number.isFinite(integratedLoudness)||integratedLoudness< -70||integratedLoudness> -5||!Number.isFinite(loudnessRange)||loudnessRange<1||loudnessRange>50||!Number.isFinite(truePeak)||truePeak< -9||truePeak>0) {
    throw new Error("Mastering targets must be within -70 to -5 LUFS, 1 to 50 LU LRA and -9 to 0 dBTP.");
  }
  return {enabled:Boolean(input.enabled),profile,integratedLoudness,loudnessRange,truePeak,dualMono:Boolean(input.dualMono)};
}
export interface EditorialTimeline {
  audioMastering?:AudioMasteringSettings;
  id:string; projectId:string; name:string; revision:number;
  frameRate:{numerator:number;denominator:number};
  width:number;height:number;pixelAspectRatio:number;
  tracks:TimelineTrack[];markers:TimelineMarker[];
  createdAt:string;updatedAt:string;metadata?:Record<string,unknown>;
}
export interface TimelineIssue {code:string;message:string;trackId?:string;clipId?:string}
export type OtioObject=Record<string,unknown>;

export const rational=(value:number,rate:number):RationalTime=>{
  if(!Number.isFinite(value)||!Number.isFinite(rate)||rate<=0)throw new Error("Rational time requires finite values and a positive rate.");
  return {value,rate};
};
export const seconds=(time:RationalTime)=>time.value/time.rate;
export const frames=(time:RationalTime,rate:number)=>Math.round(seconds(time)*rate);
export function evaluateSpeedCurve(curve:SpeedKeyframe[]|undefined,timeSeconds:number,fallback=1):number {
  if(!curve?.length)return fallback;
  if(timeSeconds<=curve[0].timeSeconds)return curve[0].speed;
  for(let index=1;index<curve.length;index++){
    const left=curve[index-1],right=curve[index];
    if(timeSeconds<=right.timeSeconds){
      const span=right.timeSeconds-left.timeSeconds;
      if(span<=0)return right.speed;
      const ratio=(timeSeconds-left.timeSeconds)/span;
      return left.speed+(right.speed-left.speed)*ratio;
    }
  }
  return curve[curve.length-1].speed;
}
export function integrateSpeedCurve(curve:SpeedKeyframe[]|undefined,durationSeconds:number,fallback=1):number {
  if(!curve?.length)return durationSeconds*fallback;
  const end=Math.max(0,durationSeconds);
  const boundaries=[0,...curve.map(point=>point.timeSeconds).filter(time=>time>0&&time<end),end].sort((a,b)=>a-b);
  let source=0;
  for(let index=1;index<boundaries.length;index++){
    const left=boundaries[index-1],right=boundaries[index];
    source+=(evaluateSpeedCurve(curve,left,fallback)+evaluateSpeedCurve(curve,right,fallback))*.5*(right-left);
  }
  return source;
}
export function sourceElapsedSeconds(clip:TimelineClip,timelineElapsedSeconds:number):number {
  const elapsed=Math.max(0,Math.min(seconds(clip.duration),timelineElapsedSeconds));
  return integrateSpeedCurve(clip.speedCurve,elapsed,Number(clip.speed??1));
}
export function timelineElapsedForSourceElapsed(clip:TimelineClip,sourceElapsed:number):number {
  const target=Math.max(0,Math.min(seconds(clip.sourceRange.duration),sourceElapsed));
  let low=0,high=seconds(clip.duration);
  for(let iteration=0;iteration<48;iteration++){
    const middle=(low+high)/2;
    if(sourceElapsedSeconds(clip,middle)<target)low=middle;else high=middle;
  }
  return (low+high)/2;
}
export function sliceSpeedCurve(curve:SpeedKeyframe[]|undefined,startSeconds:number,endSeconds:number,fallback=1):SpeedKeyframe[]|undefined {
  if(!curve?.length)return undefined;
  const start=Math.max(0,startSeconds),end=Math.max(start,endSeconds);
  const points:SpeedKeyframe[]=[{timeSeconds:0,speed:evaluateSpeedCurve(curve,start,fallback)}];
  for(const point of curve)if(point.timeSeconds>start&&point.timeSeconds<end)points.push({timeSeconds:point.timeSeconds-start,speed:point.speed});
  if(end>start)points.push({timeSeconds:end-start,speed:evaluateSpeedCurve(curve,end,fallback)});
  return points;
}
export function createTimeline(projectId:string,id:string,name="Untitled sequence",fps={numerator:24,denominator:1}):EditorialTimeline{
  if(fps.numerator<=0||fps.denominator<=0)throw new Error("Frame rate must be positive.");
  const timestamp=new Date().toISOString();
  return {id,projectId,name,revision:1,frameRate:fps,width:1920,height:1080,pixelAspectRatio:1,tracks:[],markers:[],createdAt:timestamp,updatedAt:timestamp};
}
export function addTrack(timeline:EditorialTimeline,track:TimelineTrack):EditorialTimeline{
  if(timeline.tracks.some(item=>item.id===track.id))throw new Error("Track ID already exists.");
  return {...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks:[...timeline.tracks,{...track,clips:[...track.clips]}]};
}
export function createGeneratedVideoClip(input:{id:string;assetId:string;name:string;durationSeconds:number;frameRate:{numerator:number;denominator:number};startFrame?:number;metadata?:Record<string,unknown>}):TimelineClip{
  const {id,assetId,name,durationSeconds,frameRate}=input;
  if(!id.trim()||!assetId.trim()||!name.trim())throw new Error("Generated video clip requires an ID, asset and name.");
  if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>3600)throw new Error("Generated video duration must be between 0 and 3600 seconds.");
  if(!Number.isFinite(frameRate.numerator)||!Number.isFinite(frameRate.denominator)||frameRate.numerator<=0||frameRate.denominator<=0)throw new Error("Generated video clip requires a valid timeline frame rate.");
  const fps=frameRate.numerator/frameRate.denominator;
  const durationFrames=Math.max(1,Math.round(durationSeconds*fps));
  const startFrame=Math.max(0,Math.floor(Number(input.startFrame)||0));
  return {
    id,assetId,name,
    sourceRange:{start:rational(0,fps),duration:rational(durationFrames,fps)},
    timelineStart:rational(startFrame,fps),
    duration:rational(durationFrames,fps),
    enabled:true,
    metadata:{generated:true,source:"workflow",...(input.metadata||{})}
  };
}
export function addClip(timeline:EditorialTimeline,trackId:string,clip:TimelineClip):EditorialTimeline{
  const track=timeline.tracks.find(item=>item.id===trackId);
  if(!track)throw new Error("Track not found.");
  if(track.locked)throw new Error("Track is locked.");
  if(track.clips.some(item=>item.id===clip.id))throw new Error("Clip ID already exists.");
  if(clip.duration.value<=0||clip.sourceRange.duration.value<=0)throw new Error("Clip duration must be positive.");
  const speed=Number(clip.speed??1),durationSeconds=seconds(clip.duration),curve=clip.speedCurve;
  if(!Number.isFinite(speed)||speed<0.25||speed>4)throw new Error("Clip speed must be between 0.25× and 4×.");
  if(track.kind!=="video"&&track.kind!=="audio"&&speed!==1)throw new Error("Speed changes are supported only for video and audio clips.");
  if(curve!==undefined){
    if(track.kind!=="video")throw new Error("Variable-speed curves are currently supported only for video clips.");
    if(!Array.isArray(curve)||curve.length<2||curve.length>64||curve[0]?.timeSeconds!==0||
      curve.some((point,index)=>!point||!Number.isFinite(point.timeSeconds)||!Number.isFinite(point.speed)||point.speed<0.25||point.speed>4||point.timeSeconds<0||point.timeSeconds>durationSeconds||(index>0&&point.timeSeconds<=curve[index-1].timeSeconds)))
      throw new Error("Speed curves require 2–64 ordered keyframes, starting at zero, within the clip, with speeds from 0.25× to 4×.");
  }
  const sourceSeconds=integrateSpeedCurve(curve,durationSeconds,speed);
  if(Math.abs(sourceSeconds-seconds(clip.sourceRange.duration))>Math.max(0.000001,0.5/clip.sourceRange.duration.rate))throw new Error("Source duration must equal the integrated timeline playback speed.");
  const next={...track,clips:[...track.clips,{...clip}].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))};
  const updated={...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks:timeline.tracks.map(item=>item.id===trackId?next:item)};
  const validation=validateTimeline(updated);
  if(!validation.valid)throw new Error(validation.issues[0].message);
  return updated;
}
export function trimClip(timeline:EditorialTimeline,trackId:string,clipId:string,leftFrames:number,rightFrames:number):EditorialTimeline{
  const track=timeline.tracks.find(item=>item.id===trackId);if(!track)throw new Error("Track not found.");
  if(track.locked)throw new Error("Track is locked.");
  const clip=track.clips.find(item=>item.id===clipId);if(!clip)throw new Error("Clip not found.");
  const fps=timeline.frameRate.numerator/timeline.frameRate.denominator;
  const removeLeft=Math.max(0,Math.floor(leftFrames)),removeRight=Math.max(0,Math.floor(rightFrames));
  const remaining=clip.duration.value-removeLeft-removeRight;
  if(remaining<=0)throw new Error("Trim would remove the entire clip.");
  const speed=Number(clip.speed??1),clipDurationSeconds=seconds(clip.duration),trimStartSeconds=removeLeft/fps,trimEndSeconds=clipDurationSeconds-removeRight/fps;
  const sourceLeftSeconds=sourceElapsedSeconds(clip,trimStartSeconds);
  const sourceRightSeconds=sourceElapsedSeconds(clip,clipDurationSeconds)-sourceElapsedSeconds(clip,trimEndSeconds);
  const sourceStartOffset=Math.round(sourceLeftSeconds*clip.sourceRange.start.rate);
  const sourceLeft=Math.round(sourceLeftSeconds*clip.sourceRange.duration.rate);
  const sourceRight=Math.round(sourceRightSeconds*clip.sourceRange.duration.rate);
  const sourceRemaining=clip.sourceRange.duration.value-sourceLeft-sourceRight;
  if(sourceRemaining<=0)throw new Error("Trim would remove the entire source range.");
  const changed={...clip,sourceRange:{start:rational(clip.sourceRange.start.value+sourceStartOffset,clip.sourceRange.start.rate),duration:rational(sourceRemaining,clip.sourceRange.duration.rate)},timelineStart:rational(clip.timelineStart.value+removeLeft,clip.timelineStart.rate),duration:rational(remaining,fps),speedCurve:sliceSpeedCurve(clip.speedCurve,trimStartSeconds,trimEndSeconds,speed),...(removeRight>0?{transitionToNext:undefined}:{})};
  return {...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks:timeline.tracks.map(item=>item.id===trackId?{...item,clips:item.clips.map(c=>c.id===clipId?changed:c)}:item)};
}
export function splitClip(timeline:EditorialTimeline,trackId:string,clipId:string,atFrame:number,newClipId:string):EditorialTimeline{
  const track=timeline.tracks.find(item=>item.id===trackId);if(!track)throw new Error("Track not found.");
  if(track.locked)throw new Error("Track is locked.");
  const clip=track.clips.find(item=>item.id===clipId);if(!clip)throw new Error("Clip not found.");
  const start=frames(clip.timelineStart,timeline.frameRate.numerator/timeline.frameRate.denominator);
  const duration=frames(clip.duration,timeline.frameRate.numerator/timeline.frameRate.denominator);
  const offset=Math.floor(atFrame-start);
  if(offset<=0||offset>=duration)throw new Error("Split point must be inside the clip.");
  if(track.clips.some(item=>item.id===newClipId))throw new Error("New clip ID already exists.");
  const fps=timeline.frameRate.numerator/timeline.frameRate.denominator;
  const sourceOffsetSeconds=sourceElapsedSeconds(clip,offset/fps),clipDurationSeconds=seconds(clip.duration);
  const sourceStartOffset=Math.round(sourceOffsetSeconds*clip.sourceRange.start.rate);
  const sourceOffset=Math.round(sourceOffsetSeconds*clip.sourceRange.duration.rate);
  const sourceRemaining=clip.sourceRange.duration.value-sourceOffset;
  if(sourceRemaining<=0)throw new Error("Split point is outside the source range.");
  const first={...clip,transitionToNext:undefined,duration:rational(offset,fps),sourceRange:{...clip.sourceRange,duration:rational(sourceOffset,clip.sourceRange.duration.rate)},speedCurve:sliceSpeedCurve(clip.speedCurve,0,offset/fps,Number(clip.speed??1))};
  const second={...clip,id:newClipId,name:clip.name+" · B",timelineStart:rational(start+offset,fps),duration:rational(duration-offset,fps),sourceRange:{start:rational(clip.sourceRange.start.value+sourceStartOffset,clip.sourceRange.start.rate),duration:rational(sourceRemaining,clip.sourceRange.duration.rate)},speedCurve:sliceSpeedCurve(clip.speedCurve,offset/fps,clipDurationSeconds,Number(clip.speed??1))};
  return {...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks:timeline.tracks.map(item=>item.id===trackId?{...item,clips:item.clips.flatMap(c=>c.id===clipId?[first,second]:[c])}:item)};
}
export function moveClip(timeline:EditorialTimeline,fromTrackId:string,clipId:string,toTrackId:string,toFrame:number):EditorialTimeline{
  const from=timeline.tracks.find(item=>item.id===fromTrackId),to=timeline.tracks.find(item=>item.id===toTrackId);
  if(!from||!to)throw new Error("Source or destination track not found.");
  if(from.locked||to.locked)throw new Error("Source or destination track is locked.");
  const clip=from.clips.find(item=>item.id===clipId);if(!clip)throw new Error("Clip not found.");
  if(fromTrackId!==toTrackId&&to.clips.some(item=>item.id===clipId))throw new Error("Destination already contains this clip.");
  const fps=timeline.frameRate.numerator/timeline.frameRate.denominator;
  const moved={...clip,timelineStart:rational(Math.max(0,Math.floor(toFrame)),fps)};
  const tracks=fromTrackId===toTrackId
    ? timeline.tracks.map(track=>track.id===fromTrackId?{...track,clips:track.clips.map(item=>item.id===clipId?moved:item).sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))}:track)
    : timeline.tracks.map(track=>{
        if(track.id===fromTrackId)return {...track,clips:track.clips.filter(item=>item.id!==clipId)};
        if(track.id===toTrackId)return {...track,clips:[...track.clips,moved].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))};
        return track;
      });
  const updated={...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks};
  const validation=validateTimeline(updated);if(!validation.valid)throw new Error(validation.issues[0].message);
  return updated;
}
export function addMarker(timeline:EditorialTimeline,marker:TimelineMarker):EditorialTimeline{
  if(timeline.markers.some(item=>item.id===marker.id))throw new Error("Marker ID already exists.");
  if(marker.start.value<0)throw new Error("Marker cannot start before the timeline.");
  return {...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),markers:[...timeline.markers,{...marker}].sort((a,b)=>seconds(a.start)-seconds(b.start))};
}
export function validateTimeline(timeline:EditorialTimeline):{valid:boolean;issues:TimelineIssue[]}{
  const issues:TimelineIssue[]=[];
  if(timeline.frameRate.numerator<=0||timeline.frameRate.denominator<=0)issues.push({code:"invalid_frame_rate",message:"Frame rate must be positive."});
  if(timeline.width<=0||timeline.height<=0)issues.push({code:"invalid_dimensions",message:"Timeline dimensions must be positive."});
  const ids=new Set<string>();
  for(const track of timeline.tracks){
    if(ids.has(track.id))issues.push({code:"duplicate_id",trackId:track.id,message:"Duplicate track ID."});ids.add(track.id);
    const enabledClips=[...track.clips].filter(item=>item.enabled).sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
    let end=0;
    for(const clip of [...track.clips].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))){
      if(ids.has(clip.id))issues.push({code:"duplicate_id",trackId:track.id,clipId:clip.id,message:"Duplicate clip ID."});ids.add(clip.id);
      const start=seconds(clip.timelineStart),duration=seconds(clip.duration);
      if(!clip.assetId)issues.push({code:"missing_asset",trackId:track.id,clipId:clip.id,message:"Clip has no source asset."});
      if(start<0||duration<=0||clip.sourceRange.start.value<0||clip.sourceRange.duration.value<=0)issues.push({code:"invalid_range",trackId:track.id,clipId:clip.id,message:"Clip has an invalid source or record range."});
      const speed=Number(clip.speed??1),curve=clip.speedCurve;
      if(!Number.isFinite(speed)||speed<0.25||speed>4)issues.push({code:"invalid_clip_speed",trackId:track.id,clipId:clip.id,message:"Clip speed must be between 0.25× and 4×."});
      else if(track.kind!=="video"&&track.kind!=="audio"&&speed!==1)issues.push({code:"unsupported_clip_speed",trackId:track.id,clipId:clip.id,message:"Speed changes are supported only for video and audio clips."});
      let speedCurveValid=true;
      if(curve!==undefined){
        speedCurveValid=track.kind==="video"&&Array.isArray(curve)&&curve.length>=2&&curve.length<=64&&curve[0]?.timeSeconds===0&&
          !curve.some((point,index)=>!point||!Number.isFinite(point.timeSeconds)||!Number.isFinite(point.speed)||point.speed<0.25||point.speed>4||point.timeSeconds<0||point.timeSeconds>duration||(index>0&&point.timeSeconds<=curve[index-1].timeSeconds));
        if(!speedCurveValid)
          issues.push({code:"invalid_speed_curve",trackId:track.id,clipId:clip.id,message:"Variable-speed curves require 2–64 ordered video keyframes, starting at zero, within the clip, with speeds from 0.25× to 4×."});
      }
      if(speedCurveValid&&Math.abs(integrateSpeedCurve(curve,duration,speed)-seconds(clip.sourceRange.duration))>Math.max(0.000001,0.5/clip.sourceRange.duration.rate))
        issues.push({code:"timebase_mismatch",trackId:track.id,clipId:clip.id,message:"Source duration must equal the integrated timeline playback speed."});
      if(clip.enabled&&clip.transitionToNext!==undefined){
        const transition=clip.transitionToNext,position=enabledClips.findIndex(item=>item.id===clip.id),next=enabledClips[position+1];
        const fadeFrames=Number(transition?.fadeFrames),fps=timeline.frameRate.numerator/timeline.frameRate.denominator,clipFrames=Math.round(duration*fps);
        if(track.kind!=="video"||transition?.type!=="dip-to-black"||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>clipFrames)
          issues.push({code:"invalid_transition",trackId:track.id,clipId:clip.id,message:"Video dip-to-black transitions require a positive integer fade length no longer than the outgoing clip."});
        else if(!next||Math.abs(seconds(next.timelineStart)-(start+duration))>0.5/fps)
          issues.push({code:"transition_requires_adjacent_clip",trackId:track.id,clipId:clip.id,message:"A dip-to-black transition requires the next enabled video clip to begin immediately after this clip."});
        else if(fadeFrames>Math.round(seconds(next.duration)*fps))
          issues.push({code:"transition_exceeds_incoming_clip",trackId:track.id,clipId:clip.id,message:"The transition fade cannot be longer than the incoming clip."});
      }
      if(clip.gainDb!==undefined&&(!Number.isFinite(clip.gainDb)||clip.gainDb< -60||clip.gainDb>24))issues.push({code:"invalid_audio_gain",trackId:track.id,clipId:clip.id,message:"Clip gain must be between -60 and 24 dB."});
      if(clip.pan!==undefined&&(!Number.isFinite(clip.pan)||clip.pan< -1||clip.pan>1))issues.push({code:"invalid_audio_pan",trackId:track.id,clipId:clip.id,message:"Clip pan must be between -1 and 1."});
      if(clip.audioAutomation!==undefined){try{const points=normalizeAudioAutomation(clip.audioAutomation);if(points.some(point=>point.timeSeconds>duration))throw new Error("Audio automation keyframes must fall inside the clip duration.");}catch(error){issues.push({code:"invalid_audio_automation",trackId:track.id,clipId:clip.id,message:error instanceof Error?error.message:"Audio automation is invalid."});}}
      if(start+0.000001<end)issues.push({code:"overlap",trackId:track.id,clipId:clip.id,message:"Clips overlap on the same track; use another track for overlays."});
      end=Math.max(end,start+duration);
    }
  }
  for(const marker of timeline.markers){if(ids.has(marker.id))issues.push({code:"duplicate_id",message:"Duplicate marker ID."});ids.add(marker.id);if(marker.start.value<0)issues.push({code:"invalid_marker",message:"Marker starts before the timeline."});}
  return {valid:issues.length===0,issues};
}
function otioTime(time:RationalTime){return {OTIO_SCHEMA:"RationalTime.1",value:time.value,rate:time.rate};}
function otioRange(range:TimeRange){return {OTIO_SCHEMA:"TimeRange.1",start_time:otioTime(range.start),duration:otioTime(range.duration)};}
export function toOpenTimelineIo(timeline:EditorialTimeline):OtioObject{
  const validation=validateTimeline(timeline);
  if(!validation.valid)throw new Error(validation.issues[0].message);
  const tracks=timeline.tracks.map(track=>{
    const children:OtioObject[]=[];let cursor=0;
    const fps=timeline.frameRate.numerator/timeline.frameRate.denominator;
    for(const clip of [...track.clips].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))){
      const start=frames(clip.timelineStart,fps),duration=frames(clip.duration,fps);
      if(start>cursor)children.push({OTIO_SCHEMA:"Gap.1",name:"Gap",source_range:otioRange({start:rational(0,fps),duration:rational(start-cursor,fps)})});
      children.push({
        OTIO_SCHEMA:"Clip.2",name:clip.name,
        media_reference:{OTIO_SCHEMA:"ExternalReference.1",target_url:"asset://"+clip.assetId,available_range:otioRange(clip.sourceRange)},
        source_range:otioRange(clip.sourceRange),
        metadata:{executiveVisuals:{clipId:clip.id,assetId:clip.assetId,enabled:clip.enabled,gainDb:clip.gainDb??0,pan:clip.pan??0,audioAutomation:clip.audioAutomation??[],speed:clip.speed??1,speedCurve:clip.speedCurve??null,transitionToNext:clip.transitionToNext??null,custom:clip.metadata??{}}}
      });
      cursor=start+duration;
    }
    return {OTIO_SCHEMA:"Track.1",name:track.name,kind:track.kind==="audio"?"Audio":"Video",children,metadata:{executiveVisuals:{trackId:track.id,role:track.kind,enabled:track.enabled,locked:track.locked}}};
  });
  return {OTIO_SCHEMA:"Timeline.1",name:timeline.name,global_start_time:otioTime(rational(0,timeline.frameRate.numerator/timeline.frameRate.denominator)),tracks:{OTIO_SCHEMA:"Stack.1",name:"Tracks",children:tracks},markers:timeline.markers.map(marker=>({OTIO_SCHEMA:"Marker.2",name:marker.name,marked_range:otioRange({start:marker.start,duration:marker.duration||rational(0,marker.start.rate)}),color:marker.color||"GREEN",metadata:{executiveVisuals:{id:marker.id,note:marker.note||""}}})),metadata:{executiveVisuals:{id:timeline.id,projectId:timeline.projectId,revision:timeline.revision,frameRate:timeline.frameRate,width:timeline.width,height:timeline.height,pixelAspectRatio:timeline.pixelAspectRatio,timelineMetadata:timeline.metadata||{},audioMastering:timeline.audioMastering??null}}};
}
