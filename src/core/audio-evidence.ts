import type { EditorialTimeline } from "./timeline.ts";
import type { SourceMediaAsset } from "./source-media-evidence.ts";
export type AudioEvidenceStatus = "passed" | "review" | "blocked" | "not_run";
export interface AudioEvidenceReport { status: AudioEvidenceStatus; summary: string; evidenceRef: string; findings: Array<{ code: string; detail: string; assetId?: string; clipId?: string }>; counts: { audioClips: number; probed: number; analyzed: number; blocked: number; review: number } }
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function assessAudioEvidence(timeline:EditorialTimeline|null,assets:SourceMediaAsset[]=[]):AudioEvidenceReport{
 const findings:AudioEvidenceReport["findings"]=[];
 const clips=timeline?.tracks.filter(track=>track.kind==="audio"&&track.enabled!==false).flatMap(track=>track.clips)||[];
 if(!clips.length)return{status:"not_run",summary:"No enabled audio clips are available for signal review.",evidenceRef:"audio:none",findings,counts:{audioClips:0,probed:0,analyzed:0,blocked:0,review:0}};
 const library=new Map(assets.map(asset=>[asset.id,asset]));let probed=0,analyzed=0,blocked=0,review=0;
 for(const clip of clips){
  const asset=library.get(clip.assetId);
  if(!asset){blocked++;findings.push({code:"AUDIO_SOURCE_MISSING",detail:"Audio clip source is not present in the current asset library.",assetId:clip.assetId,clipId:clip.id});continue;}
  const probe=asset.metadata?.probe;
  if(!object(probe)||!Array.isArray(probe.streams)){findings.push({code:"AUDIO_PROBE_NOT_RUN",detail:"The audio source has no saved FFprobe stream evidence.",assetId:asset.id,clipId:clip.id});continue;}
  if(!probe.streams.some((stream:unknown)=>object(stream)&&stream.codec_type==="audio")){blocked++;findings.push({code:"AUDIO_STREAM_MISSING",detail:"The selected source has no audio stream.",assetId:asset.id,clipId:clip.id});continue;}
  probed++;
  const signal=asset.metadata?.signalAnalysis;
  const metrics=object(signal)&&object(signal.audioMetrics)?signal.audioMetrics:null;
  if(!metrics){findings.push({code:"AUDIO_SIGNAL_NOT_RUN",detail:"Audio stream exists, but clipping and peak signal analysis has not been recorded.",assetId:asset.id,clipId:clip.id});continue;}
  analyzed++;
  const clipped=Number(metrics.clippedSamples),peak=Number(metrics.peakDbfs);
  if(Number.isFinite(clipped)&&clipped>0){review++;findings.push({code:"AUDIO_CLIPPING",detail:clipped+" clipped sample(s) were reported by the signal analyzer.",assetId:asset.id,clipId:clip.id});}
  if(Number.isFinite(peak)&&peak>=-1){review++;findings.push({code:"AUDIO_PEAK_HEADROOM",detail:"Measured peak is "+peak+" dBFS; review headroom and delivery true-peak requirements.",assetId:asset.id,clipId:clip.id});}
 }
 const pending=clips.length-probed-blocked;
 const status:AudioEvidenceStatus=blocked?"blocked":pending?"not_run":review?"review":analyzed===clips.length?"passed":"not_run";
 const summary=blocked?blocked+" audio source(s) have missing or incompatible streams.":pending?analyzed+" of "+clips.length+" audio clip(s) have signal measurements; "+pending+" need probing or analysis.":review?"Audio signal measurements contain "+review+" item(s) that need review.":"All "+clips.length+" audio clip(s) have source-stream and signal-analysis evidence.";
 return{status,summary,evidenceRef:"audio:signal:"+clips.map(c=>c.assetId).sort().join(",").slice(0,160),findings,counts:{audioClips:clips.length,probed,analyzed,blocked,review}};
}
