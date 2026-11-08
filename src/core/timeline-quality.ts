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


export interface TimelineDeliveryProfile {
 name:string;
 aspectRatio?:string;
 width?:number;
 height?:number;
 frameRates?:number[];
 requireAudio?:boolean;
 requireCaptions?:boolean;
 requireValidatedCaptions?:boolean;
}

/**
 * Adds deterministic delivery-contract checks without changing the editor's
 * existing project-wide quality analysis. Profiles are supplied by the caller;
 * this module does not assume platform requirements or silently transcode.
 */
export function analyzeTimelineDelivery(
 timeline:EditorialTimeline|null,
 profile:TimelineDeliveryProfile,
 assets:TimelineQualityAsset[]=[],
):TimelineQualityFinding[]{
 const findings:TimelineQualityFinding[]=[];
 const add=(code:string,severity:TimelineQualitySeverity,title:string,detail:string)=>findings.push({code,severity,title,detail});
 if(!profile||typeof profile!=="object"||typeof profile.name!=="string"||!profile.name.trim()){
  return [{code:"INVALID_DELIVERY_PROFILE",severity:"error",title:"Invalid delivery profile",detail:"Choose a named delivery profile before checking export readiness."}];
 }
 if(!timeline){
  return [{code:"NO_SEQUENCE",severity:"error",title:"No sequence loaded",detail:"Create or open a sequence before checking delivery requirements."}];
 }
 const hasDimensions=profile.width!==undefined||profile.height!==undefined;
 if(hasDimensions&&(!Number.isInteger(profile.width)||!Number.isInteger(profile.height)||profile.width!<=0||profile.height!<=0)){
  add("INVALID_DELIVERY_PROFILE","error","Invalid delivery dimensions","The delivery profile must specify positive integer width and height together.");
 }else if(hasDimensions&&(timeline.width!==profile.width||timeline.height!==profile.height)){
  add("DELIVERY_DIMENSIONS_MISMATCH","error","Export dimensions do not match","Profile “"+profile.name+"” requires "+profile.width+"×"+profile.height+" pixels; the sequence is "+timeline.width+"×"+timeline.height+".");
 }
 if(profile.aspectRatio!==undefined){
  const match=/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(profile.aspectRatio);
  const pixelAspect=Number(timeline.pixelAspectRatio);
  const actual=timeline.width*pixelAspect/timeline.height;
  const expected=match?Number(match[1])/Number(match[2]):NaN;
  if(!Number.isFinite(expected)||expected<=0){
   add("INVALID_DELIVERY_PROFILE","error","Invalid delivery aspect ratio","Use a positive ratio such as 16:9, 9:16 or 1:1.");
  }else if(!Number.isFinite(actual)||actual<=0||Math.abs(actual-expected)>0.015){
   add("DELIVERY_ASPECT_RATIO_MISMATCH","error","Aspect ratio does not match","Profile “"+profile.name+"” requires "+profile.aspectRatio+"; the sequence pixel aspect ratio is "+(Number.isFinite(actual)?actual.toFixed(3):"unknown")+".");
  }
 }
 if(profile.frameRates!==undefined){
  if(!Array.isArray(profile.frameRates)||!profile.frameRates.length||profile.frameRates.some(value=>!Number.isFinite(value)||value<=0)){
   add("INVALID_DELIVERY_PROFILE","error","Invalid delivery frame rates","The profile must declare one or more positive supported frame rates.");
  }else{
   const actual=timeline.frameRate.numerator/timeline.frameRate.denominator;
   if(!Number.isFinite(actual)||actual<=0||!profile.frameRates.some(value=>Math.abs(actual-value)<0.01)){
    add("DELIVERY_FRAME_RATE_MISMATCH","error","Frame rate does not match","Profile “"+profile.name+"” supports "+profile.frameRates.join(", ")+" fps; the sequence is "+(Number.isFinite(actual)?actual.toFixed(3):"unknown")+" fps.");
   }
  }
 }
 const tracks=Array.isArray(timeline.tracks)?timeline.tracks:[];
 if(profile.requireAudio&&!tracks.some(track=>track.kind==="audio"&&track.enabled!==false&&track.clips.length)){
  add("DELIVERY_AUDIO_REQUIRED","error","Required audio is missing","Profile “"+profile.name+"” requires at least one clip on an enabled audio track.");
 }
 if(profile.requireCaptions&&!tracks.some(track=>track.kind==="caption"&&track.enabled!==false&&track.clips.length)){
  add("DELIVERY_CAPTIONS_REQUIRED","error","Required captions are missing","Profile “"+profile.name+"” requires at least one caption clip on an enabled caption track.");
 }
 if(profile.requireValidatedCaptions){
  const captionClips=tracks.filter(track=>track.kind==="caption"&&track.enabled!==false).flatMap(track=>track.clips.filter(clip=>clip.enabled!==false));
  if(!captionClips.length){
   add("DELIVERY_CAPTION_EVIDENCE_MISSING","error","Validated captions are required","Profile “"+profile.name+"” requires at least one enabled caption clip with saved validation evidence.");
  }else{
   const assetMap=new Map(assets.map(asset=>[asset.id,asset]));
   for(const clip of captionClips){
    const asset=assetMap.get(clip.assetId);
    const validation=asset?.metadata?.captionValidation as {status?:string}|undefined;
    if(!asset||!validation||!["passed","review","blocked"].includes(String(validation.status))){
     add("DELIVERY_CAPTION_VALIDATION_MISSING","error","Caption validation evidence is missing","Caption clip “"+clip.name+"” does not reference an asset with a saved cue-level validation report.");
    }else if(validation.status==="blocked"){
     add("DELIVERY_CAPTION_VALIDATION_BLOCKED","error","Caption validation is blocked","Caption clip “"+clip.name+"” has blocking timing, format or duration findings.");
    }else if(validation.status==="review"){
     add("DELIVERY_CAPTION_VALIDATION_REVIEW","warning","Caption readability needs review","Caption clip “"+clip.name+"” has readability warnings that require human review before delivery.");
    }
   }
  }
 }
 if(!findings.length)add("DELIVERY_PROFILE_PASSED","info","Delivery profile passed","The sequence matches the declared technical requirements for “"+profile.name+"”. This check does not assess perceptual quality or provider encoding behavior.");
 return findings;
}
