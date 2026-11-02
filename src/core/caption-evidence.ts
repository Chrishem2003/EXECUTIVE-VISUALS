import type { EditorialTimeline } from "./timeline.ts";
import type { SourceMediaAsset } from "./source-media-evidence.ts";
export type CaptionEvidenceStatus="passed"|"review"|"blocked"|"not_run";
export interface CaptionEvidenceReport{status:CaptionEvidenceStatus;summary:string;evidenceRef:string;findings:Array<{code:string;detail:string;assetId?:string;clipId?:string}>;counts:{captionClips:number;validated:number;review:number;blocked:number;notRun:number}}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function assessCaptionEvidence(timeline:EditorialTimeline|null,assets:SourceMediaAsset[]=[]):CaptionEvidenceReport{
 const findings:CaptionEvidenceReport["findings"]=[];
 const clips=timeline?.tracks.filter(track=>track.kind==="caption"&&track.enabled!==false).flatMap(track=>track.clips.filter(clip=>clip.enabled!==false))||[];
 if(!clips.length)return{status:"review",summary:"No enabled caption clips are present; confirm whether this delivery requires captions.",evidenceRef:"captions:none",findings:[{code:"CAPTION_TRACK_MISSING",detail:"No enabled caption clips are present. This is a review decision, not an automatic failure or pass."}],counts:{captionClips:0,validated:0,review:0,blocked:0,notRun:0}};
 const library=new Map(assets.map(asset=>[asset.id,asset]));let validated=0,review=0,blocked=0,notRun=0;
 for(const clip of clips){
  const asset=library.get(clip.assetId);
  if(!asset){blocked++;findings.push({code:"CAPTION_ASSET_MISSING",detail:"Caption clip source is not present in the current asset library.",assetId:clip.assetId,clipId:clip.id});continue;}
  if(asset.mediaType!=="text/vtt"&&!String(asset.name||"").toLowerCase().endsWith(".vtt")){blocked++;findings.push({code:"CAPTION_FORMAT_UNSUPPORTED",detail:"Automated caption evidence currently supports validated WebVTT assets; this source is not identified as WebVTT.",assetId:asset.id,clipId:clip.id});continue;}
  const validation=asset.metadata?.captionValidation;
  if(!object(validation)||!["passed","review","blocked"].includes(String(validation.status))){notRun++;findings.push({code:"CAPTION_VALIDATION_NOT_RUN",detail:"The WebVTT asset has no saved cue-level validation report.",assetId:asset.id,clipId:clip.id});continue;}
  if(validation.status==="blocked"){blocked++;findings.push({code:"CAPTION_VALIDATION_BLOCKED",detail:"Saved WebVTT validation contains blocking format, timing or duration errors.",assetId:asset.id,clipId:clip.id});continue;}
  validated++;
  if(validation.status==="review"){
   review++;
   const rows=Array.isArray(validation.findings)?validation.findings.filter((item:unknown)=>object(item)&&item.severity==="warning"):[];
   findings.push(...rows.slice(0,20).map((item:Record<string,unknown>)=>({code:String(item.code||"CAPTION_REVIEW").slice(0,80),detail:String(item.detail||"Caption cue requires review.").slice(0,500),assetId:asset.id,clipId:clip.id})));
  }
 }
 const pending=notRun;
 const status:CaptionEvidenceStatus=blocked?"blocked":pending?"not_run":review?"review":"passed";
 const summary=blocked?blocked+" caption clip(s) are missing or failed validation.":pending?validated+" of "+clips.length+" caption clip(s) have validation evidence; "+pending+" need validation.":review?validated+" caption clip(s) passed structural checks, but "+review+" contain readability warnings.":"All "+clips.length+" caption clip(s) have validated WebVTT timing and readability evidence.";
 return{status,summary,evidenceRef:"captions:webvtt:"+clips.map(c=>c.assetId).sort().join(",").slice(0,160),findings,counts:{captionClips:clips.length,validated,review,blocked,notRun}};
}
