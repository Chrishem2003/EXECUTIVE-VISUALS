import type { EditorialTimeline } from "./timeline";

export type TimelineQualitySeverity="error"|"warning"|"info";
export interface TimelineQualityFinding {code:string;severity:TimelineQualitySeverity;title:string;detail:string;trackId?:string;clipId?:string}
export interface TimelineQualityAsset {id:string;name?:string;mediaType?:string;metadata?:Record<string,unknown>}
const toSeconds=(time:{value:number;rate:number}|undefined)=>time&&Number.isFinite(time.value)&&Number.isFinite(time.rate)&&time.rate>0?time.value/time.rate:NaN;
export function analyzeTimelineQuality(timeline:EditorialTimeline|null,assets:TimelineQualityAsset[]=[]):TimelineQualityFinding[]{
 if(!timeline)return [{code:"NO_SEQUENCE",severity:"info",title:"No sequence loaded",detail:"Create or open a sequence to run production checks."}];
 const findings:TimelineQualityFinding[]=[];
 const tracks=Array.isArray(timeline.tracks)?timeline.tracks:[];
 const video=tracks.filter(track=>track.kind==="video"&&track.enabled!==false);
 const audio=tracks.filter(track=>track.kind==="audio"&&track.enabled!==false);
 const captions=tracks.filter(track=>track.kind==="caption"&&track.enabled!==false);
 const overlays=tracks.filter(track=>track.kind==="overlay"&&track.enabled!==false);
 const primary=video[0];
 const rate=timeline.frameRate.numerator/timeline.frameRate.denominator;
 const tolerance=Number.isFinite(rate)&&rate>0?0.5/rate:0;
 const durationOf=(track:typeof tracks[number])=>track.clips.reduce((end,clip)=>Math.max(end,toSeconds(clip.timelineStart)+toSeconds(clip.duration)),0);
 const sequenceEnd=Math.max(0,...tracks.flatMap(track=>track.clips.map(clip=>toSeconds(clip.timelineStart)+toSeconds(clip.duration)).filter(Number.isFinite)));
 if(!primary||!primary.clips.length)findings.push({code:"NO_PRIMARY_VIDEO",severity:"error",title:"No primary picture",detail:"Add at least one clip to an enabled video track before rendering."});
 if(primary?.clips.length){
  const clips=[...primary.clips].sort((a,b)=>toSeconds(a.timelineStart)-toSeconds(b.timelineStart));
  let cursor=0;
  for(const clip of clips){
   const metadata=asset?.metadata||{};
   const probe=metadata.probe as {format?:{duration?:string|number};streams?:Array<{duration?:string|number}>}|undefined;
   const knownDuration=Number(probe?.format?.duration??probe?.streams?.find(stream=>Number(stream.duration)>0)?.duration);
   const sourceEnd=toSeconds(clip.sourceRange.start)+toSeconds(clip.sourceRange.duration);
   if(Number.isFinite(knownDuration)&&knownDuration>0&&Number.isFinite(sourceEnd)&&sourceEnd>knownDuration+Math.max(0.05,tolerance))
    findings.push({code:"SOURCE_RANGE_EXCEEDS_MEDIA",severity:"error",title:"Clip exceeds source duration",detail:"The selected source range ends beyond the probed media duration of "+knownDuration.toFixed(2)+" seconds.",trackId:track.id,clipId:clip.id});
  }
 }
 for(const marker of timeline.markers||[]){
  const position=toSeconds(marker.start);
  if(Number.isFinite(position)&&position>sequenceEnd+tolerance)findings.push({code:"MARKER_AFTER_SEQUENCE",severity:"warning",title:"Review marker is beyond the edit",detail:"Marker “"+marker.name+"” sits after the current sequence end."});
 }
 if(sequenceEnd>0)findings.push({code:"SEQUENCE_DURATION",severity:"info",title:"Sequence duration",detail:"Current edit length is "+Math.floor(sequenceEnd/60)+":"+String(Math.floor(sequenceEnd%60)).padStart(2,"0")+"."});
 return findings;
}
