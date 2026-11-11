export interface RationalTime { value:number; rate:number }
export interface TimeRange { start:RationalTime; duration:RationalTime }
export type TrackKind="video"|"audio"|"overlay"|"caption";
export interface TimelineClip {
  id:string; assetId:string; name:string; sourceRange:TimeRange;
  timelineStart:RationalTime; duration:RationalTime;
  enabled:boolean; gainDb?:number; speed?:number; metadata?:Record<string,unknown>;
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
  const changed={...clip,sourceRange:{start:rational(clip.sourceRange.start.value+sourceLeft,clip.sourceRange.start.rate),duration:rational(sourceRemaining,clip.sourceRange.duration.rate)},timelineStart:rational(clip.timelineStart.value+removeLeft,clip.timelineStart.rate),duration:rational(remaining,fps)};
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
  const first={...clip,duration:rational(offset,fps),sourceRange:{...clip.sourceRange,duration:rational(sourceOffset,clip.sourceRange.duration.rate)}};
  const second={...clip,id:newClipId,name:clip.name+" · B",timelineStart:rational(start+offset,fps),duration:rational(duration-offset,fps),sourceRange:{start:rational(clip.sourceRange.start.value+sourceOffset,clip.sourceRange.start.rate),duration:rational(sourceRemaining,clip.sourceRange.duration.rate)}};
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
    let end=0;
    for(const clip of [...track.clips].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))){
      if(ids.has(clip.id))issues.push({code:"duplicate_id",trackId:track.id,clipId:clip.id,message:"Duplicate clip ID."});ids.add(clip.id);
      const start=seconds(clip.timelineStart),duration=seconds(clip.duration);
      if(!clip.assetId)issues.push({code:"missing_asset",trackId:track.id,clipId:clip.id,message:"Clip has no source asset."});
      if(start<0||duration<=0||clip.sourceRange.start.value<0||clip.sourceRange.duration.value<=0)issues.push({code:"invalid_range",trackId:track.id,clipId:clip.id,message:"Clip has an invalid source or record range."});
      if(Math.abs(duration-seconds(clip.sourceRange.duration))>Math.max(0.000001,0.5/clip.sourceRange.duration.rate))issues.push({code:"timebase_mismatch",trackId:track.id,clipId:clip.id,message:"Source and timeline durations differ by more than half a source frame."});
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
        metadata:{executiveVisuals:{clipId:clip.id,assetId:clip.assetId,enabled:clip.enabled,gainDb:clip.gainDb??0,speed:clip.speed??1,custom:clip.metadata??{}}}
      });
      cursor=start+duration;
    }
    return {OTIO_SCHEMA:"Track.1",name:track.name,kind:track.kind==="audio"?"Audio":"Video",children,metadata:{executiveVisuals:{trackId:track.id,role:track.kind,enabled:track.enabled,locked:track.locked}}};
  });
  return {OTIO_SCHEMA:"Timeline.1",name:timeline.name,global_start_time:otioTime(rational(0,timeline.frameRate.numerator/timeline.frameRate.denominator)),tracks:{OTIO_SCHEMA:"Stack.1",name:"Tracks",children:tracks},markers:timeline.markers.map(marker=>({OTIO_SCHEMA:"Marker.2",name:marker.name,marked_range:otioRange({start:marker.start,duration:marker.duration||rational(0,marker.start.rate)}),color:marker.color||"GREEN",metadata:{executiveVisuals:{id:marker.id,note:marker.note||""}}})),metadata:{executiveVisuals:{id:timeline.id,projectId:timeline.projectId,revision:timeline.revision,frameRate:timeline.frameRate,width:timeline.width,height:timeline.height,pixelAspectRatio:timeline.pixelAspectRatio,timelineMetadata:timeline.metadata||{}}}};
}
