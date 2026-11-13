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
  if(!["video","audio","overlay","caption"].includes(track.kind))issues.push("Track kind must be video, audio, overlay or caption.");
  if(!Array.isArray(track.clips))issues.push("Every track must contain a clips array.");
  const orderedClips=[...(track.clips||[])].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
  const enabledClips=orderedClips.filter(clip=>clip.enabled!==false);
  let end=0;
  for(const clip of orderedClips){
   clipCount++;
   if(!clip.id||ids.has(clip.id))issues.push("Clip and track IDs must be unique and non-empty.");ids.add(clip.id);
   const asset=clip.assetId?getAccessibleAsset(db,ownerId,clip.assetId,true):null;
   if(!asset)issues.push("Every timeline clip must reference a source asset accessible to this account.");
   else if(track.kind==="video"&&!asset.media_type.startsWith("video/")&&!asset.media_type.startsWith("image/"))issues.push("Primary video tracks accept only video or still-image assets.");
   else if(track.kind==="audio"&&!asset.media_type.startsWith("audio/"))issues.push("Audio tracks accept only audio assets.");
   else if(track.kind==="overlay"&&!asset.media_type.startsWith("image/"))issues.push("Overlay tracks currently accept only still-image assets.");
   else if(track.kind==="caption"&&(!["text/plain","text/vtt"].includes(asset.media_type)||![".srt",".vtt"].includes(String(asset.original_name||"").toLowerCase().slice(String(asset.original_name||"").lastIndexOf(".")))))issues.push("Caption tracks accept only SRT or VTT text assets.");
   if(Number(clip.speed??1)!==1)issues.push("Clip speed changes are not supported until time remapping is implemented.");
   if(track.kind==="audio"&&clip.gainDb!==undefined&&(!Number.isFinite(Number(clip.gainDb))||Number(clip.gainDb)<-60||Number(clip.gainDb)>24))issues.push("Audio gain must be between -60 dB and +24 dB.");
   if(track.kind==="overlay"&&clip.metadata&&clip.metadata.opacity!==undefined&&(!Number.isFinite(Number(clip.metadata.opacity))||Number(clip.metadata.opacity)<0||Number(clip.metadata.opacity)>1))issues.push("Overlay opacity must be between 0 and 1.");
   if(track.kind==="caption"&&clip.metadata?.fontSize!==undefined&&(!Number.isFinite(Number(clip.metadata.fontSize))||Number(clip.metadata.fontSize)<12||Number(clip.metadata.fontSize)>72))issues.push("Caption font size must be between 12 and 72.");
   const start=seconds(clip.timelineStart),duration=seconds(clip.duration),sourceStart=seconds(clip.sourceRange?.start),sourceDuration=seconds(clip.sourceRange?.duration);
   if(!Number.isFinite(start)||!Number.isFinite(duration)||!Number.isFinite(sourceStart)||!Number.isFinite(sourceDuration)||start<0||duration<=0||sourceStart<0||sourceDuration<=0)issues.push("Timeline clip has invalid source or record timing.");
   if(Number.isFinite(start)&&Number.isFinite(duration)&&start+0.000001<end)issues.push("Clips overlap on the same track; use a separate overlay track.");
   if(Number.isFinite(start)&&Number.isFinite(duration))end=Math.max(end,start+duration);
   if(Number.isFinite(duration)&&Number.isFinite(sourceDuration)&&Math.abs(duration-sourceDuration)>Math.max(0.0001,0.5/Number(clip.sourceRange.duration.rate)))issues.push("Clip source and timeline durations must match within half a source frame until time-remapping is implemented.");
   if(clip.enabled!==false&&clip.transitionToNext!==undefined){
    const transition=clip.transitionToNext,index=enabledClips.findIndex(item=>item.id===clip.id),next=enabledClips[index+1];
    const fadeFrames=Number(transition?.fadeFrames),fps=Number(timeline.frameRate.numerator)/Number(timeline.frameRate.denominator),durationFrames=Math.round(duration*fps);
    if(track.kind!=="video"||transition?.type!=="dip-to-black"||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>durationFrames)issues.push("Video dip-to-black transitions require a positive integer fade length no longer than the outgoing clip.");
    else if(!next||Math.abs(seconds(next.timelineStart)-(start+duration))>0.5/fps)issues.push("A dip-to-black transition requires the next enabled video clip to begin immediately after this clip.");
    else if(fadeFrames>Math.round(seconds(next.duration)*fps))issues.push("The transition fade cannot be longer than the incoming clip.");
   }
  }
 }
 if(clipCount>5000)issues.push("Timeline exceeds the 5,000 clip limit.");
 for(const marker of timeline.markers||[])if(!marker.id||ids.has(marker.id)||seconds(marker.start)<0||!Number.isFinite(seconds(marker.start)))issues.push("Timeline markers must have unique IDs and valid non-negative positions.");else ids.add(marker.id);
 return {valid:issues.length===0,issues};
}
