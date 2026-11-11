import type { EditorialTimeline } from "./timeline.ts";
import type { SourceMediaAsset } from "./source-media-evidence.ts";
export type DeliveryEvidenceStatus="passed"|"review"|"blocked"|"not_run";
type Finding={code:string;detail:string;assetId?:string};
export interface DeliveryEvidenceReport{status:DeliveryEvidenceStatus;summary:string;evidenceRef:string;findings:Finding[];assetId?:string;measured?:{container:string|null;videoCodec:string|null;width:number|null;height:number|null;frameRate:number|null;durationSeconds:number|null;audioCodec:string|null;audioMastering?:{profile:string|null;integratedLoudness:number|null;loudnessRange:number|null;truePeak:number|null;passed:boolean|null}|null};}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function rate(value:unknown){if(typeof value==="number")return Number.isFinite(value)&&value>0?value:null;if(typeof value==="string"){const parts=value.split("/").map(Number),n=parts[0],d=parts.length>1?parts[1]:1;return Number.isFinite(n)&&Number.isFinite(d)&&n>0&&d>0?n/d:null;}return null;}
export function assessDeliveryEvidence(timeline:EditorialTimeline|null,assets:SourceMediaAsset[]=[]):DeliveryEvidenceReport{
 const findings:Finding[]=[];
 if(!timeline)return{status:"not_run",summary:"No sequence is loaded for delivery verification.",evidenceRef:"delivery:none",findings};
 const candidates=assets.filter(asset=>asset.metadata?.operation==="timeline.render"&&asset.metadata?.timelineId===timeline.id&&Number(asset.metadata?.timelineRevision)===timeline.revision);
 if(!candidates.length)return{status:"not_run",summary:"No master render exists for the current timeline revision.",evidenceRef:"delivery:render-missing",findings:[{code:"DELIVERY_MASTER_NOT_FOUND",detail:"Render a master from the current saved timeline revision before delivery certification."}]};
 const asset=candidates[0],metadata=asset.metadata||{},probe=metadata.probe;
 if(!object(probe)||!Array.isArray(probe.streams)||!object(probe.format))return{status:"not_run",summary:"The current master has no saved FFprobe format and stream evidence.",evidenceRef:"delivery:probe-missing",assetId:asset.id,findings:[{code:"DELIVERY_PROBE_NOT_RUN",detail:"The master asset has no complete output probe report.",assetId:asset.id}]};
 const streams=probe.streams.filter(object),video=streams.find(stream=>stream.codec_type==="video"),audio=streams.find(stream=>stream.codec_type==="audio");
 const formatName=String(probe.format.format_name||"").toLowerCase(),container=formatName.includes("mp4")?"mp4":formatName||null;
 const duration=Number(probe.format.duration),width=video?Number(video.width):null,height=video?Number(video.height):null;
 const frameRate=video?rate(video.avg_frame_rate||video.r_frame_rate):null,videoCodec=video?String(video.codec_name||"").toLowerCase():null,audioCodec=audio?String(audio.codec_name||"").toLowerCase():null;
 const measured={container,videoCodec,width:Number.isFinite(width)?width:null,height:Number.isFinite(height)?height:null,frameRate,durationSeconds:Number.isFinite(duration)&&duration>0?duration:null,audioCodec};
 const spec=object(timeline.metadata?.deliverySpec)?timeline.metadata?.deliverySpec as Record<string,unknown>:{};
 const expectedWidth=Number(spec.width??timeline.width),expectedHeight=Number(spec.height??timeline.height);
 const expectedRate=spec.frameRate!==undefined?rate(spec.frameRate):timeline.frameRate.numerator/timeline.frameRate.denominator;
 const expectedContainer=String(spec.container||"mp4").toLowerCase(),expectedVideoCodec=String(spec.videoCodec||"h264").toLowerCase();
 const audioRequired=spec.requireAudio===true||timeline.tracks.some(track=>track.kind==="audio"&&track.enabled!==false&&track.clips.some(clip=>clip.enabled!==false));
 const fail=(code:string,detail:string)=>findings.push({code,detail,assetId:asset.id});
 if(!video)fail("DELIVERY_VIDEO_STREAM_MISSING","Master output contains no video stream.");
 if(!container||!container.includes(expectedContainer))fail("DELIVERY_CONTAINER_MISMATCH","Expected "+expectedContainer+" container but measured "+(container||"unknown")+".");
 if(video&&videoCodec!==expectedVideoCodec)fail("DELIVERY_VIDEO_CODEC_MISMATCH","Expected "+expectedVideoCodec+" video codec but measured "+(videoCodec||"unknown")+".");
 if(video&&Number.isFinite(expectedWidth)&&width!==expectedWidth)fail("DELIVERY_WIDTH_MISMATCH","Expected "+expectedWidth+"px width but measured "+width+"px.");
 if(video&&Number.isFinite(expectedHeight)&&height!==expectedHeight)fail("DELIVERY_HEIGHT_MISMATCH","Expected "+expectedHeight+"px height but measured "+height+"px.");
 if(video&&expectedRate!==null&&frameRate!==null&&Math.abs(frameRate-expectedRate)>0.01)fail("DELIVERY_FRAME_RATE_MISMATCH","Expected "+expectedRate+" fps but measured "+frameRate+" fps.");
 if(video&&frameRate===null)fail("DELIVERY_FRAME_RATE_MISSING","Master video frame rate could not be verified.");
 if(!Number.isFinite(duration)||duration<=0)fail("DELIVERY_DURATION_INVALID","Master duration is missing or invalid.");
 if(audioRequired&&!audio)fail("DELIVERY_AUDIO_STREAM_MISSING","The sequence or delivery profile requires audio, but the master has no audio stream.");
 if(spec.audioCodec&&audio&&audioCodec!==String(spec.audioCodec).toLowerCase())fail("DELIVERY_AUDIO_CODEC_MISMATCH","Expected "+spec.audioCodec+" audio codec but measured "+(audioCodec||"unknown")+".");
 const render=object(metadata.render)?metadata.render:{};
 if(Number.isFinite(Number(render.durationSeconds))&&Number(render.durationSeconds)>0&&Number.isFinite(duration)&&Math.abs(Number(render.durationSeconds)-duration)>0.25)fail("DELIVERY_DURATION_DIVERGENCE","Renderer duration and probed master duration differ by more than 250 ms.");
 const mastering=object(render.audioMastering)?render.audioMastering:null;
 const masteringMeasurement=mastering&&object(mastering.measurement)?mastering.measurement:null;
 const masteringQc=mastering&&object(mastering.qualityControl)?mastering.qualityControl:null;
 const measuredMetric=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;
 const measuredMastering=mastering?.applied===true?{profile:typeof mastering.profile==="string"?mastering.profile:null,integratedLoudness:measuredMetric(masteringMeasurement?.integratedLoudness),loudnessRange:measuredMetric(masteringMeasurement?.loudnessRange),truePeak:measuredMetric(masteringMeasurement?.truePeak),passed:typeof masteringQc?.passed==="boolean"?masteringQc.passed:null}:null;
 if(timeline.audioMastering?.enabled===true){
  if(mastering?.applied!==true)fail("DELIVERY_AUDIO_MASTERING_NOT_APPLIED","The timeline requests audio mastering, but the current master has no applied mastering receipt.");
  else if(!masteringMeasurement||measuredMastering?.integratedLoudness===null||measuredMastering?.truePeak===null||measuredMastering?.passed===null)fail("DELIVERY_AUDIO_MASTERING_QC_MISSING","The master has no complete post-encode loudness and true-peak quality-control evidence.");
  else if(masteringQc?.passed!==true)fail("DELIVERY_AUDIO_MASTERING_QC_FAILED","Measured post-encode audio does not meet the configured mastering delivery targets.");
 }
 const measuredWithMastering={...measured,audioMastering:measuredMastering};
 const explicit=Object.keys(spec).length>0;
 const status=findings.length?(explicit?"blocked":"review"):"passed";
 const summary=findings.length?findings.length+" delivery conformance issue(s) require "+(explicit?"correction against the specified profile.":"review against the sequence-native master profile."):"The current revision's master matches the measured container, video, frame-rate, resolution and audio requirements.";
 return{status,summary,evidenceRef:"delivery:ffprobe:"+asset.id,assetId:asset.id,measured:measuredWithMastering,findings};
}
