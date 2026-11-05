import { evaluateAudioAutomation, type AudioAutomationPoint } from "./audio-automation.ts";
export interface RationalTime { value:number; rate:number }
export interface TimeRange { start:RationalTime; duration:RationalTime }
export type TrackKind="video"|"audio"|"overlay"|"caption";
export interface TimelineTransition { type:"dip-to-black"|"crossfade"; fadeFrames:number }
export interface TimelineClip {
  id:string; assetId:string; name:string; sourceRange:TimeRange;
  timelineStart:RationalTime; duration:RationalTime;
  enabled:boolean; gainDb?:number; pan?:number; audioAutomation?:AudioAutomationPoint[]; speed?:number; transitionToNext?:TimelineTransition; metadata?:Record<string,unknown>;
}
export interface TimelineTrack {
  id:string; name:string; kind:TrackKind; enabled:boolean; locked:boolean;
  clips:TimelineClip[];
}
export interface TimelineMarker {
  id:string; name:string; start:RationalTime; duration?:RationalTime;
  color?:string; note?:string;
}
export interface EditorialTimeline {
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
export function createTimeline(projectId:string,id:string,name="Untitled sequence",fps={numerator:24,denominator:1}):EditorialTimeline{
  if(fps.numerator<=0||fps.denominator<=0)throw new Error("Frame rate must be positive.");
  const timestamp=new Date().toISOString();
  return {id,projectId,name,revision:1,frameRate:fps,width:1920,height:1080,pixelAspectRatio:1,tracks:[],markers:[],createdAt:timestamp,updatedAt:timestamp};
}
export function addTrack(timeline:EditorialTimeline,track:TimelineTrack):EditorialTimeline{
  if(timeline.tracks.some(item=>item.id===track.id))throw new Error("Track ID already exists.");
  return {...timeline,revision:timeline.revision+1,updatedAt:new Date().toISOString(),tracks:[...timeline.tracks,{...track,clips:[...track.clips]}]};
}
export function addClip(timeline:EditorialTimeline,trackId:string,clip:TimelineClip):EditorialTimeline{
  const track=timeline.tracks.find(item=>item.id===trackId);
  if(!track)throw new Error("Track not found.");
  if(track.locked)throw new Error("Track is locked.");
  if(track.clips.some(item=>item.id===clip.id))throw new Error("Clip ID already exists.");
  if(clip.duration.value<=0||clip.sourceRange.duration.value<=0)throw new Error("Clip duration must be positive.");
  if(Math.abs(seconds(clip.duration)-seconds(clip.sourceRange.duration))>Math.max(0.000001,0.5/clip.sourceRange.duration.rate))throw new Error("Timeline and source duration must match within half a source frame for constant-speed clips.");
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
  const sourceLeft=Math.round(removeLeft/fps*clip.sourceRange.start.rate);
  const sourceRight=Math.round(removeRight/fps*clip.sourceRange.duration.rate);
  const sourceRemaining=clip.sourceRange.duration.value-sourceLeft-sourceRight;
  if(sourceRemaining<=0)throw new Error("Trim would remove the entire source range.");
  const automationOffset=removeLeft/fps,automation=clip.audioAutomation?.length?[{timeSeconds:0,gainDb:evaluateAudioAutomation(clip.audioAutomation,automationOffset,"gainDb",clip.gainDb??0),pan:evaluateAudioAutomation(clip.audioAutomation,automationOffset,"pan",clip.pan??0),interpolation:"linear" as const},...clip.audioAutomation.filter(point=>point.timeSeconds>automationOffset).map(point=>({...point,timeSeconds:point.timeSeconds-automationOffset}))]:undefined;
  const changed={...clip,sourceRange:{start:rational(clip.sourceRange.start.value+sourceLeft,clip.sourceRange.start.rate),duration:rational(sourceRemaining,clip.sourceRange.duration.rate)},timelineStart:rational(clip.timelineStart.value+removeLeft,clip.timelineStart.rate),duration:rational(remaining,fps),audioAutomation:automation};
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
  const sourceOffset=Math.round(offset/fps*clip.sourceRange.start.rate);
  const sourceRemaining=clip.sourceRange.duration.value-sourceOffset;
  if(sourceRemaining<=0)throw new Error("Split point is outside the source range.");
  const splitSeconds=offset/fps,points=clip.audioAutomation||[];
  const boundary=points.length?[{timeSeconds:0,gainDb:evaluateAudioAutomation(points,splitSeconds,"gainDb",clip.gainDb??0),pan:evaluateAudioAutomation(points,splitSeconds,"pan",clip.pan??0),interpolation:"linear" as const}]:undefined;
  const firstAutomation=points.length?[...points.filter(point=>point.timeSeconds<splitSeconds),{timeSeconds:splitSeconds,gainDb:evaluateAudioAutomation(points,splitSeconds,"gainDb",clip.gainDb??0),pan:evaluateAudioAutomation(points,splitSeconds,"pan",clip.pan??0),interpolation:"linear" as const}]:undefined;
  const secondAutomation:AudioAutomationPoint[]|undefined=points.length?[...boundary!,...points.filter(point=>point.timeSeconds>splitSeconds).map(point=>({...point,timeSeconds:point.timeSeconds-splitSeconds}))]:undefined;
  const first={...clip,duration:rational(offset,fps),sourceRange:{...clip.sourceRange,duration:rational(sourceOffset,clip.sourceRange.duration.rate)},audioAutomation:firstAutomation};
  const second={...clip,id:newClipId,name:clip.name+" · B",timelineStart:rational(start+offset,fps),duration:rational(duration-offset,fps),sourceRange:{start:rational(clip.sourceRange.start.value+sourceOffset,clip.sourceRange.start.rate),duration:rational(sourceRemaining,clip.sourceRange.duration.rate)},audioAutomation:secondAutomation};
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
    let end=0,previousClip:TimelineClip|undefined;
    const orderedClips=[...track.clips].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart)),enabledClips=orderedClips.filter(item=>item.enabled);
    for(const clip of orderedClips){
      if(ids.has(clip.id))issues.push({code:"duplicate_id",trackId:track.id,clipId:clip.id,message:"Duplicate clip ID."});ids.add(clip.id);
      const start=seconds(clip.timelineStart),duration=seconds(clip.duration);
      if(!clip.assetId)issues.push({code:"missing_asset",trackId:track.id,clipId:clip.id,message:"Clip has no source asset."});
      const speed=Number(clip.speed??1);
      if(!Number.isFinite(speed)||speed!==1)issues.push({code:"unsupported_speed",trackId:track.id,clipId:clip.id,message:"Clip speed changes are not supported until time remapping is implemented."});
      if(start<0||duration<=0||clip.sourceRange.start.value<0||clip.sourceRange.duration.value<=0)issues.push({code:"invalid_range",trackId:track.id,clipId:clip.id,message:"Clip has an invalid source or record range."});
      if(Math.abs(duration-seconds(clip.sourceRange.duration))>Math.max(0.000001,0.5/clip.sourceRange.duration.rate))issues.push({code:"timebase_mismatch",trackId:track.id,clipId:clip.id,message:"Source and timeline durations differ by more than half a source frame."});
      if(clip.transitionToNext!==undefined){
        const transition=clip.transitionToNext,index=enabledClips.findIndex(item=>item.id===clip.id),next=enabledClips[index+1],previousTransition=index>0?enabledClips[index-1]?.transitionToNext:undefined,fps=timeline.frameRate.numerator/timeline.frameRate.denominator,fadeFrames=Number(transition?.fadeFrames),clipFrames=Math.round(duration*fps),isPrimaryVideo=track.kind==="video"&&timeline.tracks.find(item=>item.enabled&&item.kind==="video")?.id===track.id,isAudioCrossfade=track.kind==="audio"&&transition?.type==="crossfade",isVideoTransition=track.kind==="video"&&(transition?.type==="dip-to-black"||(transition?.type==="crossfade"&&isPrimaryVideo));
        if((!isVideoTransition&&!isAudioCrossfade)||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>clipFrames)issues.push({code:"invalid_transition",trackId:track.id,clipId:clip.id,message:"Video transitions require a valid video track; audio tracks support crossfades only. Fade length must be a positive integer no longer than the outgoing clip."});
        else if(!next)issues.push({code:"transition_requires_adjacent_clip",trackId:track.id,clipId:clip.id,message:"A transition requires a following enabled clip on the same track."});
        else if(transition.type==="dip-to-black"&&Math.abs(seconds(next.timelineStart)-(start+duration))>0.5/fps)issues.push({code:"transition_requires_adjacent_clip",trackId:track.id,clipId:clip.id,message:"A dip-to-black transition requires the next clip to begin immediately after the outgoing clip."});
        else if(transition.type==="crossfade"&&Math.abs(seconds(next.timelineStart)-(start+duration-fadeFrames/fps))>0.5/fps)issues.push({code:"crossfade_overlap_mismatch",trackId:track.id,clipId:clip.id,message:"A crossfade requires the next clip to overlap the outgoing clip by exactly the configured fade duration."});
        else if(fadeFrames>Math.round(seconds(next.duration)*fps))issues.push({code:"transition_exceeds_incoming_clip",trackId:track.id,clipId:clip.id,message:"The transition fade cannot be longer than the incoming clip."});
        else if(transition.type==="crossfade"&&Number(previousTransition?.type==="crossfade"?previousTransition.fadeFrames:0)+fadeFrames>clipFrames)issues.push({code:"crossfade_overlap_exceeds_clip",trackId:track.id,clipId:clip.id,message:"Incoming and outgoing crossfades cannot overlap more than the duration of a clip."});
      }
      if(clip.gainDb!==undefined&&(!Number.isFinite(clip.gainDb)||clip.gainDb< -60||clip.gainDb>24))issues.push({code:"invalid_audio_gain",trackId:track.id,clipId:clip.id,message:"Clip gain must be between -60 and 24 dB."});
      if(clip.pan!==undefined&&(!Number.isFinite(clip.pan)||clip.pan< -1||clip.pan>1))issues.push({code:"invalid_audio_pan",trackId:track.id,clipId:clip.id,message:"Clip pan must be between -1 and 1."});
      if(clip.audioAutomation!==undefined){try{const points=clip.audioAutomation;if(!Array.isArray(points)||points.length>256)throw new Error("Audio automation supports at most 256 keyframes per clip.");let previous=-1;for(const point of points){if(!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>duration)throw new Error("Audio automation keyframes must fall inside the clip duration.");if(point.timeSeconds<=previous)throw new Error("Audio automation keyframes must be sorted with unique times.");if(point.gainDb!==undefined&&(!Number.isFinite(point.gainDb)||point.gainDb< -60||point.gainDb>24))throw new Error("Automation gain must be between -60 and 24 dB.");if(point.pan!==undefined&&(!Number.isFinite(point.pan)||point.pan< -1||point.pan>1))throw new Error("Automation pan must be between -1 and 1.");if(point.gainDb===undefined&&point.pan===undefined)throw new Error("Automation keyframes require gain or pan.");previous=point.timeSeconds;}}catch(error){issues.push({code:"invalid_audio_automation",trackId:track.id,clipId:clip.id,message:error instanceof Error?error.message:"Audio automation is invalid."});}}
      if(start+0.000001<end){
        const fadeFrames=Number(previousClip?.transitionToNext?.fadeFrames),fps=timeline.frameRate.numerator/timeline.frameRate.denominator,expectedOverlap=fadeFrames/fps,actualOverlap=previousClip?seconds(previousClip.timelineStart)+seconds(previousClip.duration)-start:0;
        const isPrimaryVideo=track.kind==="video"&&timeline.tracks.find(item=>item.enabled&&item.kind==="video")?.id===track.id;
        const allowedCrossfade=(isPrimaryVideo||track.kind==="audio")&&previousClip?.transitionToNext?.type==="crossfade"&&Number.isSafeInteger(fadeFrames)&&fadeFrames>0&&Math.abs(actualOverlap-expectedOverlap)<=0.5/fps;
        if(!allowedCrossfade)issues.push({code:"overlap",trackId:track.id,clipId:clip.id,message:"Clips overlap on the same track; only explicitly configured primary-video or audio crossfades may overlap."});
      }
      end=Math.max(end,start+duration);previousClip=clip;
    }
  }
  for(const marker of timeline.markers){if(ids.has(marker.id))issues.push({code:"duplicate_id",message:"Duplicate marker ID."});ids.add(marker.id);if(marker.start.value<0)issues.push({code:"invalid_marker",message:"Marker starts before the timeline."});}
  return {valid:issues.length===0,issues};
}
export interface ActiveTimelineClip {
  trackId:string;
  trackKind:TrackKind;
  trackIndex:number;
  trackName:string;
  clipId:string;
  clipName:string;
  assetId:string;
  timelineStartSeconds:number;
  timelineEndSeconds:number;
  sourceTimeSeconds:number;
  sourceFrame:number;
  opacity:number;
}
export interface TimelineFrameEvaluation {
  frame:number;
  timeSeconds:number;
  activeClips:ActiveTimelineClip[];
}
/** Resolve the active media clips at a zero-based timeline frame for preview and render parity. */
export function evaluateTimelineAtFrame(timeline:EditorialTimeline,frame:number):TimelineFrameEvaluation{
  if(!Number.isSafeInteger(frame)||frame<0)throw new Error("Timeline frame must be a non-negative safe integer.");
  const validation=validateTimeline(timeline);
  if(!validation.valid)throw new Error(validation.issues[0].message);
  const fps=timeline.frameRate.numerator/timeline.frameRate.denominator;
  const timeSeconds=frame/fps;
  const activeClips:ActiveTimelineClip[]=[];
  for(const [trackIndex,track] of timeline.tracks.entries()){
    if(!track.enabled)continue;
    for(const clip of track.clips){
      if(!clip.enabled)continue;
      const clipStart=seconds(clip.timelineStart);
      const clipEnd=clipStart+seconds(clip.duration);
      if(timeSeconds<clipStart||timeSeconds>=clipEnd)continue;
      const sourceTimeSeconds=seconds(clip.sourceRange.start)+(timeSeconds-clipStart);
      let opacity=1;
      if(track.kind==="video"){
        const fadeOut=clip.transitionToNext&&(clip.transitionToNext.type==="dip-to-black"||clip.transitionToNext.type==="crossfade")?clip.transitionToNext.fadeFrames/fps:0;
        const orderedClips=track.clips.filter(item=>item.enabled).slice().sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
        const index=orderedClips.findIndex(item=>item.id===clip.id),previous=orderedClips[index-1];
        const fadeIn=previous?.transitionToNext&&(previous.transitionToNext.type==="dip-to-black"||previous.transitionToNext.type==="crossfade")?previous.transitionToNext.fadeFrames/fps:0;
        if(fadeIn>0&&timeSeconds<clipStart+fadeIn)opacity=Math.min(opacity,Math.max(0,(timeSeconds-clipStart)/fadeIn));
        if(fadeOut>0&&timeSeconds>clipEnd-fadeOut)opacity=Math.min(opacity,Math.max(0,(clipEnd-timeSeconds)/fadeOut));
      }
      activeClips.push({
        trackId:track.id,
        trackKind:track.kind,
        trackIndex,
        trackName:track.name,
        clipId:clip.id,
        clipName:clip.name,
        assetId:clip.assetId,
        timelineStartSeconds:clipStart,
        timelineEndSeconds:clipEnd,
        sourceTimeSeconds,
        sourceFrame:sourceTimeSeconds*clip.sourceRange.start.rate,
        opacity
      });
    }
  }
  return {frame,timeSeconds,activeClips};
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
        metadata:{executiveVisuals:{clipId:clip.id,assetId:clip.assetId,enabled:clip.enabled,gainDb:clip.gainDb??0,pan:clip.pan??0,audioAutomation:clip.audioAutomation??[],speed:clip.speed??1,transitionToNext:clip.transitionToNext??null,custom:clip.metadata??{}}}
      });
      cursor=start+duration;
    }
    return {OTIO_SCHEMA:"Track.1",name:track.name,kind:track.kind==="audio"?"Audio":"Video",children,metadata:{executiveVisuals:{trackId:track.id,role:track.kind,enabled:track.enabled,locked:track.locked}}};
  });
  return {OTIO_SCHEMA:"Timeline.1",name:timeline.name,global_start_time:otioTime(rational(0,timeline.frameRate.numerator/timeline.frameRate.denominator)),tracks:{OTIO_SCHEMA:"Stack.1",name:"Tracks",children:tracks},markers:timeline.markers.map(marker=>({OTIO_SCHEMA:"Marker.2",name:marker.name,marked_range:otioRange({start:marker.start,duration:marker.duration||rational(0,marker.start.rate)}),color:marker.color||"GREEN",metadata:{executiveVisuals:{id:marker.id,note:marker.note||""}}})),metadata:{executiveVisuals:{id:timeline.id,projectId:timeline.projectId,revision:timeline.revision,frameRate:timeline.frameRate,width:timeline.width,height:timeline.height,pixelAspectRatio:timeline.pixelAspectRatio,timelineMetadata:timeline.metadata||{}}}};
}
