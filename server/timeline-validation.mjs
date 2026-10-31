import { getAccessibleAsset } from "./db.mjs";
const seconds=time=>Number(time?.value)/Number(time?.rate);
export function validateTimelineDocument(timeline,db,ownerId){
 const issues=[];
 if(!timeline||typeof timeline!=="object")return {valid:false,issues:["Timeline must be an object."]};
 if(!timeline.frameRate||Number(timeline.frameRate.numerator)<=0||Number(timeline.frameRate.denominator)<=0)issues.push("Frame rate must be positive.");
 if(!Array.isArray(timeline.tracks)||timeline.tracks.length>200)issues.push("Timeline must contain no more than 200 tracks.");
 if(!Array.isArray(timeline.markers))issues.push("Timeline markers must be an array.");
 const ids=new Set();let clipCount=0;
 for(const track of timeline.tracks||[]){
  if(!track.id||ids.has(track.id))issues.push("Track IDs must be unique and non-empty.");ids.add(track.id);
  if(!Array.isArray(track.clips))issues.push("Every track must contain a clips array.");
  let end=0;
  for(const clip of [...(track.clips||[])].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))){
   clipCount++;
   if(!clip.id||ids.has(clip.id))issues.push("Clip and track IDs must be unique and non-empty.");ids.add(clip.id);
   if(!clip.assetId||!getAccessibleAsset(db,ownerId,clip.assetId,true))issues.push("Every timeline clip must reference a source asset owned by this account.");
   const start=seconds(clip.timelineStart),duration=seconds(clip.duration),sourceStart=seconds(clip.sourceRange?.start),sourceDuration=seconds(clip.sourceRange?.duration);
   if(!Number.isFinite(start)||!Number.isFinite(duration)||!Number.isFinite(sourceStart)||!Number.isFinite(sourceDuration)||start<0||duration<=0||sourceStart<0||sourceDuration<=0)issues.push("Timeline clip has invalid source or record timing.");
   if(Number.isFinite(start)&&Number.isFinite(duration)&&start+0.000001<end)issues.push("Clips overlap on the same track; use a separate overlay track.");
   if(Number.isFinite(start)&&Number.isFinite(duration))end=Math.max(end,start+duration);
   if(Number.isFinite(duration)&&Number.isFinite(sourceDuration)&&Math.abs(duration-sourceDuration)>0.0001)issues.push("Clip source and timeline durations must match until time-remapping is implemented.");
  }
 }
 if(clipCount>5000)issues.push("Timeline exceeds the 5,000 clip limit.");
 for(const marker of timeline.markers||[])if(!marker.id||ids.has(marker.id)||seconds(marker.start)<0||!Number.isFinite(seconds(marker.start)))issues.push("Timeline markers must have unique IDs and valid non-negative positions.");else ids.add(marker.id);
 return {valid:issues.length===0,issues};
}
