import type { EditorialTimeline } from "./timeline";

export type TimelineQualitySeverity="error"|"warning"|"info";
export interface TimelineQualityFinding {code:string;severity:TimelineQualitySeverity;title:string;detail:string;trackId?:string;clipId?:string}
export interface TimelineQualityAsset {id:string;name?:string;mediaType?:string;sha256?:string;derivativeOf?:string|null;metadata?:Record<string,unknown>}
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
 const sequenceEnd=Math.max(0,...tracks.flatMap(track=>track.clips.map(clip=>toSeconds(clip.timelineStart)+toSeconds(clip.duration)).filter(Number.isFinite)));
 if(!primary||!primary.clips.length)findings.push({code:"NO_PRIMARY_VIDEO",severity:"error",title:"No primary picture",detail:"Add at least one clip to an enabled video track before rendering."});
 if(primary?.clips.length){
  const clips=[...primary.clips].sort((a,b)=>toSeconds(a.timelineStart)-toSeconds(b.timelineStart));
  let cursor=0;
  for(const clip of clips){
   const start=toSeconds(clip.timelineStart),end=start+toSeconds(clip.duration);
   if(Number.isFinite(start)&&start>cursor+tolerance)findings.push({code:"PICTURE_GAP",severity:"warning",title:"Gap in primary picture",detail:"There is approximately "+(start-cursor).toFixed(2)+" seconds without picture before “"+clip.name+"”.",trackId:primary.id,clipId:clip.id});
   if(Number.isFinite(end))cursor=Math.max(cursor,end);
  }
 }
 if(!audio.length||!audio.some(track=>track.clips.length))findings.push({code:"NO_AUDIO",severity:"warning",title:"No audio bed",detail:"No enabled audio clips are present. Confirm that silence is intentional or add dialogue, music or effects."});
 if(!captions.length||!captions.some(track=>track.clips.length))findings.push({code:"NO_CAPTIONS",severity:"info",title:"No captions",detail:"No caption clips are present. Add subtitles if this delivery needs accessibility or localization."});
 if(overlays.some(track=>!track.clips.length))findings.push({code:"EMPTY_OVERLAY_TRACK",severity:"info",title:"Empty overlay track",detail:"An enabled overlay track has no clips; remove it or add the intended graphic."});
 for(const track of tracks){
  for(const clip of track.clips){
   const asset=assets.find(item=>item.id===clip.assetId);
   if(!asset)findings.push({code:"ASSET_NOT_IN_LIBRARY",severity:"error",title:"Source asset not in current library",detail:"The source for “"+clip.name+"” is not present in the currently loaded asset list.",trackId:track.id,clipId:clip.id});
   if(asset?.derivativeOf){
    const raw=asset.metadata?.processing;
    const processing=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
    const finding=(code:string,severity:TimelineQualitySeverity,title:string,detail:string)=>findings.push({code,severity,title,detail,trackId:track.id,clipId:clip.id});
    if(!processing){
     finding("DERIVATIVE_PROVENANCE_MISSING","warning","Derivative processing evidence is missing","“"+clip.name+"” uses a derived asset, but no structured processing record is available. Treat its origin and enhancement settings as unverified.");
    }else{
     const sourceHash=processing.inputSha256??processing.sourceSha256??asset.metadata?.sourceSha256;
     const outputHash=processing.outputSha256??asset.metadata?.sha256;
     if(typeof sourceHash!=="string"||! /^[a-f0-9]{64}$/i.test(sourceHash))
      finding("DERIVATIVE_SOURCE_HASH_MISSING","warning","Derivative source checksum is missing","The processing record for “"+clip.name+"” does not contain a valid SHA-256 checksum for its source.");
     if(typeof outputHash!=="string"||! /^[a-f0-9]{64}$/i.test(outputHash)||typeof asset.sha256==="string"&&outputHash.toLowerCase()!==asset.sha256.toLowerCase())
      finding("DERIVATIVE_OUTPUT_HASH_UNVERIFIED","warning","Derivative output checksum is unverified","The recorded output checksum for “"+clip.name+"” is missing, malformed or does not match the asset library checksum.");
     if(processing.model||processing.engine||processing.method==="ai-super-resolution"){
      if(processing.dimensionsVerified!==true)
       finding("DERIVATIVE_DIMENSIONS_UNVERIFIED","warning","AI derivative dimensions are unverified","The AI-enhanced asset used by “"+clip.name+"” has no successful dimension-verification flag.");
      if(processing.decoderVerified!==true)
       finding("DERIVATIVE_DECODER_UNVERIFIED","warning","AI derivative decoding is unverified","The AI-enhanced asset used by “"+clip.name+"” has no successful decoder-verification flag.");
      if(processing.qualityReview==="reviewed_fail")
       finding("DERIVATIVE_QUALITY_REJECTED","error","AI derivative failed quality review","The AI-enhanced asset used by “"+clip.name+"” has been rejected in quality review. Replace it or complete a new approved review before delivery.");
      else if(processing.qualityReview!=="reviewed_pass")
       finding("DERIVATIVE_QUALITY_REVIEW_PENDING","warning","AI derivative awaits quality review","The AI-enhanced asset used by “"+clip.name+"” has not received a recorded independent passing quality review.");
     }
    }
   }
   const probe=asset?.metadata?.probe as {format?:{duration?:string|number};streams?:Array<{duration?:string|number}>}|undefined;
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
