import { apiRequest } from "../core/api";
import { AudioPreviewEngine, decibelsToGain, type AudioPreviewTrackInput } from "../core/audio-preview";
import { evaluateAudioAutomation } from "../core/audio-automation.ts";
import { analyzeTimelineQuality } from "../core/timeline-quality";
import { buildProductionReadinessReport } from "../core/production-readiness";
import { assessSourceMediaEvidence } from "../core/source-media-evidence";
import { assessRightsEvidence } from "../core/rights-evidence";
import { assessAudioEvidence } from "../core/audio-evidence";
import { assessCaptionEvidence } from "../core/caption-evidence";
import { assessDeliveryEvidence } from "../core/delivery-evidence";
import { analyzeCreativeTraceability, readCreativeTrace } from "../core/creative-traceability";
import { appendCreativeDecision, readCreativeDecisionHistory } from "../core/creative-decision-ledger";
import { compareTimelineVariants, createTimelineVariant, type TimelineVariantComparison } from "../core/timeline-variants";
import { addClip, addMarker, addTrack, createTimeline, evaluateTimelineAtFrame, moveClip, rational, seconds, splitClip, toOpenTimelineIo, trimClip, type EditorialTimeline, type TimelineTrack } from "../core/timeline";

type Asset={id:string;name:string;mediaType:string;size:number;metadata?:Record<string,unknown>};
type SavedTimeline={id:string;projectId?:string|null;name:string;revision:number;document?:EditorialTimeline};
type CloudProject={id:string;name:string};
type CloudSavedTimeline={id:string;projectId?:string|null;name:string;revision:number;timeline:EditorialTimeline;updatedAt:string};
type MasteringReport={enabled:boolean;verified:boolean;targets?:{integratedLufs:number;loudnessRange:number;truePeakDbtp:number};output?:{normalizationType?:string;integratedLufs?:number|null;truePeakDbtp?:number|null;loudnessRange?:number|null};findings?:Array<{code:string;severity:string;message:string}>};
type CloudRenderJob={id:string;status:string;progress?:number;created_at:string;output?:{outputAsset?:{id:string;name?:string};mastering?:MasteringReport};error?:unknown};
let previewRequest=0;
const state:{timeline:EditorialTimeline|null;serverRevision:number;timelines:SavedTimeline[];cloudTimelines:CloudSavedTimeline[];cloudProjects:CloudProject[];cloudProjectId:string;mode:"local"|"cloud";cloudRenderJobId:string;cloudRenderJobStatus:string;masteringSettings:{enabled:boolean;integratedLufs:number;loudnessRange:number;truePeakDbtp:number;dualMono:boolean};masteringReport:MasteringReport|null;cloudRenderJobs:CloudRenderJob[];variantBase:EditorialTimeline|null;variantReport:TimelineVariantComparison|null;variantBaseName:string;assets:Asset[];status:"loading"|"ready"|"offline"|"auth";message:string;selectedTrack:string;selectedClipId:string;ffmpeg:boolean;playheadFrame:number;previewAssetId:string;previewUrl:string;previewMediaType:string;previewError:string;previewSources:Record<string,{url:string;mediaType:string}>;previewActiveClips:ReturnType<typeof evaluateTimelineAtFrame>["activeClips"];previewLayerKey:string;previewPlaying:boolean;audioEngine:AudioPreviewEngine|null;audioMasterVolume:number;audioMasterMuted:boolean;audioTrackStates:Record<string,{muted:boolean;solo:boolean}>;waveformCache:Record<string,string>;waveformStatus:Record<string,string>}={
 timeline:null,serverRevision:0,timelines:[],cloudTimelines:[],cloudProjects:[],cloudProjectId:"",mode:"local",cloudRenderJobId:"",cloudRenderJobStatus:"",masteringSettings:{enabled:false,integratedLufs:-16,loudnessRange:11,truePeakDbtp:-1.5,dualMono:false},masteringReport:null,cloudRenderJobs:[],variantBase:null,variantReport:null,variantBaseName:"",assets:[],status:"loading",message:"Loading editorial workspace…",selectedTrack:"",selectedClipId:"",ffmpeg:false,playheadFrame:0,previewAssetId:"",previewUrl:"",previewMediaType:"",previewError:"",previewSources:{},previewActiveClips:[],previewLayerKey:"",previewPlaying:false,audioEngine:null,audioMasterVolume:0.85,audioMasterMuted:false,audioTrackStates:{},waveformCache:{},waveformStatus:{}
};
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const fps=()=>state.timeline?state.timeline.frameRate.numerator/state.timeline.frameRate.denominator:24;
const maxEnd=()=>Math.max(1,...(state.timeline?.tracks.flatMap(t=>t.clips.map(c=>c.timelineStart.value+c.duration.value))||[240]));
function sourceRate(asset:Asset,kind:string){
 const probe=asset.metadata?.probe as {streams?:Array<{codec_type?:string;r_frame_rate?:string;avg_frame_rate?:string;sample_rate?:string}>}|undefined;
 const stream=probe?.streams?.find(item=>item.codec_type===(kind==="audio"?"audio":"video"));
 if(kind==="audio"){const sample=Number(stream?.sample_rate);return sample>0?sample:fps();}
 const raw=stream?.avg_frame_rate&&stream.avg_frame_rate!=="0/0"?stream.avg_frame_rate:stream?.r_frame_rate;
 if(raw){const [n,d]=raw.split("/").map(Number);if(n>0&&d>0)return n/d;}
 return fps();
}
const assetOptions=()=>state.assets.map(a=>{const probe=a.metadata?.probe as {format?:{duration?:string}}|undefined;const duration=Number(probe?.format?.duration);return '<option value="'+esc(a.id)+'">'+esc(a.name)+' · '+esc(a.mediaType)+(Number.isFinite(duration)?' · '+duration.toFixed(1)+'s':' · inspect for duration')+'</option>';}).join("");
function timelineCanvas(){
 if(!state.timeline)return '<div class="empty">'+esc(state.message)+'</div>';
 const total=maxEnd();
 return '<div class="timeline-ruler"><span>00:00</span><span>'+Math.round(total/2/fps())+'s</span><span>'+Math.round(total/fps())+'s</span></div>'+
 state.timeline.tracks.map(track=>'<div class="editor-track"><div class="editor-track-label"><b>'+esc(track.name)+'</b><small>'+esc(track.kind)+(track.locked?' · locked':'')+'</small></div><div class="editor-track-lane">'+track.clips.map(clip=>'<article class="editor-clip '+(state.selectedClipId===clip.id?'selected':'')+'" data-tl-select="true" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'" style="left:'+Math.max(0,clip.timelineStart.value/total*100)+'%;width:'+Math.max(4,clip.duration.value/total*100)+'%"><b>'+esc(clip.name)+'</b><small>'+esc(clip.assetId.slice(0,8))+' · '+Math.round(clip.duration.value)+'f</small>'+(track.kind==="audio"?'<div class="editor-clip-waveform" data-waveform-asset="'+esc(clip.assetId)+'">'+(state.waveformCache[clip.assetId]||'<span>'+esc(state.waveformStatus[clip.assetId]||"Waveform pending")+'</span>')+'</div>':'')+'<div class="editor-clip-actions"><button data-tl-action="split" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Split</button><button data-tl-action="trim" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Trim 12f</button><button data-tl-action="move" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Next track</button></div></article>').join("")+'</div></div>').join("");
}
function clipInspector(){
 if(!state.timeline||!state.selectedClipId)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its timing, gain or visual properties.</p></div>';
 const track=state.timeline.tracks.find(item=>item.clips.some(clip=>clip.id===state.selectedClipId));
 const clip=track?.clips.find(item=>item.id===state.selectedClipId);
 if(!track||!clip)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its properties.</p></div>';
 const metadata=clip.metadata||{},trace=readCreativeTrace(clip)||{storyBeat:"",purpose:"",audiencePromise:"",proofReference:"",decisionNote:""},decisions=readCreativeDecisionHistory(clip),start=Math.round(clip.timelineStart.value),duration=Math.round(clip.duration.value),sourceIn=Math.round(clip.sourceRange.start.value);
 let specific="";
  if(track.kind==="audio"){const controls=state.audioTrackStates[track.id]||{muted:false,solo:false},keyframes=clip.audioAutomation?.length||0;specific='<div><label>Gain (dB)</label><input name="gainDb" type="number" min="-60" max="24" step="0.5" value="'+esc(clip.gainDb??0)+'"></div><div><label>Pan (L −1 · C 0 · R +1)</label><input name="pan" type="number" min="-1" max="1" step="0.05" value="'+esc(clip.pan??0)+'"></div><div><label><input name="trackMuted" type="checkbox" '+(controls.muted?'checked':'')+'> Mute track</label></div><div><label><input name="trackSolo" type="checkbox" '+(controls.solo?'checked':'')+'> Solo track</label></div><div class="full"><small class="muted">'+keyframes+' automation keyframe(s) · Place the playhead inside this clip to add a keyframe.</small><button class="secondary" type="button" data-tl-audio-keyframe data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Add gain / pan keyframe at playhead</button></div>';}
 if(track.kind==="overlay")specific='<div><label>X position</label><input name="x" type="number" min="0" value="'+esc(metadata.x??Math.max(0,(state.timeline.width||1920)-Math.round((state.timeline.width||1920)*0.24)-24))+'"></div><div><label>Y position</label><input name="y" type="number" min="0" value="'+esc(metadata.y??24)+'"></div><div><label>Width (px)</label><input name="width" type="number" min="16" value="'+esc(metadata.width??Math.round((state.timeline.width||1920)*0.24))+'"></div><div><label>Height (px)</label><input name="height" type="number" min="16" value="'+esc(metadata.height??Math.round((state.timeline.height||1080)*0.24))+'"></div><div><label>Opacity</label><input name="opacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.opacity??1)+'"></div>';
 if(track.kind==="caption")specific='<div><label>Font family</label><input name="fontName" value="'+esc(metadata.fontName??"DejaVu Sans")+'"></div><div><label>Font size</label><input name="fontSize" type="number" min="12" max="96" value="'+esc(metadata.fontSize??32)+'"></div><div><label>Text color</label><input name="primaryColor" type="color" value="'+esc(metadata.primaryColor??"#FFFFFF")+'"></div><div><label>Caption placement</label><select name="alignment">'+[1,2,3,4,5,6,7,8,9].map(n=>'<option value="'+n+'" '+(Number(metadata.alignment??2)===n?'selected':'')+'>'+n+'</option>').join("")+'</select></div><div><label>Background panel</label><select name="backgroundMode"><option value="box" '+(metadata.backgroundMode!=="none"?'selected':'')+'>Behind captions</option><option value="none" '+(metadata.backgroundMode==="none"?'selected':'')+'>No panel</option></select></div><div><label>Panel color</label><input name="backgroundColor" type="color" value="'+esc(metadata.backgroundColor??"#000000")+'"></div><div><label>Panel opacity</label><input name="backgroundOpacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.backgroundOpacity??0.68)+'"></div><div><label>Outline</label><input name="outline" type="number" min="0" max="8" step="0.5" value="'+esc(metadata.outline??2)+'"></div><div><label>Shadow</label><input name="shadow" type="number" min="0" max="8" step="0.5" value="'+esc(metadata.shadow??1)+'"></div><div><label>Bottom safe-area margin</label><input name="marginV" type="number" min="0" max="240" value="'+esc(metadata.marginV??42)+'"></div>';
 return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR · '+esc(track.kind.toUpperCase())+'</div><form id="tl-clip-inspector" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'"><div class="form-grid"><div><label>Clip name</label><input name="name" value="'+esc(clip.name)+'" required></div><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+start+'"></div><div><label>Duration (frames)</label><input name="duration" type="number" min="1" value="'+duration+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="'+sourceIn+'"></div>'+specific+'</div><div class="eyebrow" style="margin-top:16px">CREATIVE INTENT LINK</div><div class="form-grid"><div><label>Story beat</label><input name="storyBeat" maxlength="120" value="'+esc(trace.storyBeat)+'" placeholder="Opening hook / Proof / Payoff"></div><div><label>Audience promise served</label><input name="audiencePromise" maxlength="300" value="'+esc(trace.audiencePromise)+'" placeholder="What did we promise viewers?"></div><div class="full"><label>Why this shot exists</label><textarea name="purpose" maxlength="500" rows="2" placeholder="What information, emotion or transition does it contribute?">'+esc(trace.purpose)+'</textarea></div><div><label>Proof / source reference</label><input name="proofReference" maxlength="300" value="'+esc(trace.proofReference)+'" placeholder="Evidence ID, source or approved claim"></div><div><label>Creative decision note</label><input name="decisionNote" maxlength="500" value="'+esc(trace.decisionNote)+'" placeholder="Why this take, framing or edit was chosen"></div></div>'+(decisions.length?'<div class="eyebrow" style="margin-top:16px">CREATIVE DECISION HISTORY · '+decisions.length+'</div><div class="timeline-quality-list">'+decisions.slice().reverse().slice(0,8).map(item=>'<article class="timeline-quality-item info"><b>r'+item.sequence+' · '+esc(item.summary)+'</b><p>'+esc(item.recordedAt)+'</p></article>').join("")+'</div>':'')+'<button class="secondary">Save clip properties and intent</button></form></div>';
}
function variantComparisonPanel(){
 if(!state.timeline?.metadata?.variantOf)return "";
 if(!state.variantReport)return '<section class="panel timeline-quality"><div class="eyebrow">VARIANT COMPARISON</div><p class="muted">The original sequence could not be loaded for comparison. The variant remains independent and unchanged.</p></section>';
 const report=state.variantReport;
 return '<section class="panel timeline-quality"><div class="timeline-panel-heading"><div><div class="eyebrow">NON-DESTRUCTIVE VARIANT COMPARISON</div><h3>'+esc(state.variantBaseName)+' → '+esc(state.timeline.name)+'</h3></div><span class="job-status '+(report.changes.length?'running':'completed')+'">'+(report.changes.length?'Changes detected':'No differences')+'</span></div><p class="muted">'+esc(report.summary)+'</p><div class="creative-plan-meta"><span>'+report.addedClips+' added · '+report.removedClips+' removed · '+report.changedClips+' changed clips</span><span>'+report.addedMarkers+' added · '+report.removedMarkers+' removed · '+report.changedMarkers+' changed markers</span><span>Track delta '+(report.trackCountDelta>0?'+':'')+report.trackCountDelta+'</span></div>'+(report.changes.length?'<div class="timeline-quality-list">'+report.changes.map(item=>'<article class="timeline-quality-item '+(item.kind==='removed'?'warning':item.kind==='added'?'success':'info')+'"><b>'+esc(item.kind.toUpperCase())+' · '+esc(item.clipName)+'</b><p>'+esc(item.fields.join(' · '))+'</p></article>').join('')+'</div>':'<p class="muted">The variant currently matches its original in clip and marker structure.</p>')+'<small class="muted">This comparison is structural and deterministic. It does not score visual quality, infer scene meaning or overwrite the original sequence.</small></section>';
}
async function loadVariantComparison(){
 state.variantBase=null;state.variantReport=null;state.variantBaseName="";
 const baseId=state.timeline?.metadata?.variantOf;
 if(typeof baseId!=="string"||!baseId)return;
 try{
  let base:EditorialTimeline|null=null;
  if(state.mode==="cloud"){
   const saved=state.cloudTimelines.find(item=>item.id===baseId);
   base=saved?.timeline||null;
   if(saved)state.variantBaseName=saved.name;
  }else{
   const saved=await apiRequest<{timeline:SavedTimeline}>("/api/timelines/"+encodeURIComponent(baseId));
   base=saved.timeline.document||null;
   state.variantBaseName=saved.timeline.name;
  }
  if(base&&state.timeline){state.variantBase=base;state.variantReport=compareTimelineVariants(base,state.timeline);}
 }catch{state.variantBase=null;state.variantReport=null;}
}
async function duplicateTimelineVariant(){
 if(!state.timeline)throw new Error("Load a timeline before creating a variant.");
 const name=(state.timeline.name+" — Variant").slice(0,160);
 const variant=createTimelineVariant(state.timeline,crypto.randomUUID(),name,new Date().toISOString());
 if(state.mode==="cloud"){
  if(!state.cloudProjectId)throw new Error("Select a cloud project before creating a variant.");
  const result=await apiRequest<{timeline:CloudSavedTimeline}>("/api/cloud/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:state.cloudProjectId,name:variant.name,timeline:variant,otio:toOpenTimelineIo(variant)})});
  state.timeline=result.timeline.timeline;state.serverRevision=result.timeline.revision;
 }else{
  const result=await apiRequest<{timeline:SavedTimeline}>("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:variant.name,timeline:variant})});
  state.timeline=result.timeline.document||variant;state.serverRevision=result.timeline.revision;
 }
 state.selectedClipId="";state.selectedTrack=state.timeline.tracks[0]?.id||"";
 await refresh();await loadVariantComparison();
 state.message="Created an independent variant. The original sequence was not changed.";state.status="ready";
}
function creativeTraceabilityPanel(){
 const report=analyzeCreativeTraceability(state.timeline);
 const tone=report.readyForDirectorReview?"completed":report.findings.some(item=>item.severity==="review")?"running":"completed";
 return '<section class="panel timeline-quality"><div class="timeline-panel-heading"><div><div class="eyebrow">CREATIVE INTENT TRACEABILITY</div><h3>Why does each shot exist?</h3></div><span class="job-status '+tone+'">'+report.coveragePercent+'% anchored</span></div><div class="creative-plan-meta"><span>'+report.anchoredClips+'/'+report.totalClips+' clips linked to a story beat and purpose</span><span>'+report.linkedClips+' with intent notes</span></div>'+(report.totalClips?report.findings.length?'<div class="timeline-quality-list">'+report.findings.map(item=>'<article class="timeline-quality-item '+(item.severity==="review"?"warning":"info")+'"><b>'+esc(item.clipName)+' · '+esc(item.code.replaceAll("_"," ").toLowerCase())+'</b><p>'+esc(item.detail)+'</p></article>').join("")+'</div>':'<p class="muted">Every active clip has a story beat and a stated purpose. This is traceability evidence, not an automated judgement of creative quality.</p>':'<p class="muted">Add clips to the timeline, then record each clip’s story beat and purpose in the clip inspector.</p>')+'<small class="muted">Links are explicit editorial annotations stored with each clip. No story meaning is inferred from media, and this panel does not claim model-based scene understanding.</small></section>';
}
export function timelineQualityPanel(){
 const findings=analyzeTimelineQuality(state.timeline,state.assets);
 const hasTimeline=!!state.timeline;
 const missingPrimary=findings.some(item=>item.code==="NO_PRIMARY_VIDEO");
 const pictureGap=findings.some(item=>item.code==="PICTURE_GAP");
 const sourceEvidence=assessSourceMediaEvidence(state.timeline,state.assets);
 const rightsEvidence=assessRightsEvidence(state.timeline,state.assets);
 const audioEvidence=assessAudioEvidence(state.timeline,state.assets);
 const captionEvidence=assessCaptionEvidence(state.timeline,state.assets);
 const deliveryEvidence=assessDeliveryEvidence(state.timeline,state.assets);
 const report=buildProductionReadinessReport({checks:{
  sequence:{status:!hasTimeline?"not_run":missingPrimary?"blocked":pictureGap?"review":"passed",summary:!hasTimeline?"No sequence is loaded.":missingPrimary?"The sequence has no primary picture track.":pictureGap?"Primary picture contains a gap that needs review.":"A primary picture sequence is present with no detected gap."},
  source_media:{status:sourceEvidence.status,summary:sourceEvidence.summary,evidenceRef:sourceEvidence.evidenceRef,findings:sourceEvidence.findings.map(item=>({code:item.code,detail:item.detail}))},
  rights:{status:rightsEvidence.status,summary:rightsEvidence.summary,evidenceRef:rightsEvidence.evidenceRef,findings:rightsEvidence.findings.map(item=>({code:item.code,detail:item.detail}))},
  captions:{status:!hasTimeline?"not_run":captionEvidence.status,summary:!hasTimeline?"No sequence is loaded.":captionEvidence.summary,evidenceRef:captionEvidence.evidenceRef,findings:captionEvidence.findings.map(item=>({code:item.code,detail:item.detail}))},
  audio:{status:audioEvidence.status,summary:audioEvidence.summary,evidenceRef:audioEvidence.evidenceRef,findings:audioEvidence.findings.map(item=>({code:item.code,detail:item.detail}))},
  delivery:{status:deliveryEvidence.status,summary:deliveryEvidence.summary,evidenceRef:deliveryEvidence.evidenceRef,findings:deliveryEvidence.findings.map(item=>({code:item.code,detail:item.detail}))}
 }});
 const decisionLabel=report.decision==="blocked"?"Production blocked":report.decision==="ready_for_human_approval"?"Ready for human approval":"Review required";
 const decisionClass=report.decision==="blocked"?"failed":report.decision==="ready_for_human_approval"?"completed":"running";
 const checks=report.checks.map(item=>'<article class="timeline-quality-item '+(item.status==="blocked"?"error":item.status==="review"?"warning":item.status==="passed"?"success":"info")+'"><b>'+esc(item.label)+' · '+esc(item.status.replace("_"," "))+'</b><p>'+esc(item.summary)+'</p></article>').join("");
 const errorCount=findings.filter(item=>item.severity==="error").length;
 const warningCount=findings.filter(item=>item.severity==="warning").length;
 return '<section class="panel timeline-quality"><div class="timeline-panel-heading"><div><div class="eyebrow">EVIDENCE-BASED PRODUCTION GATE</div><h3>Production readiness</h3></div><span class="job-status '+decisionClass+'">'+decisionLabel+'</span></div>'+
 '<div class="creative-plan-meta"><span>'+report.counts.passed+'/'+report.counts.total+' required checks passed</span><span>'+report.counts.blocked+' blocked · '+report.counts.review+' review · '+report.counts.notRun+' not run</span></div>'+
 '<div class="timeline-quality-list">'+checks+'</div>'+
 (findings.length?'<div class="eyebrow" style="margin-top:16px">SEQUENCE FINDINGS · '+errorCount+' errors · '+warningCount+' warnings</div><div class="timeline-quality-list">'+findings.map(item=>'<article class="timeline-quality-item '+item.severity+'"><b>'+esc(item.title)+'</b><p>'+esc(item.detail)+'</p></article>').join("")+'</div>':'')+
 '<small class="muted">Sequence structure and source-media checks use the current timeline and saved FFprobe metadata. A source passes only when its probe contains readable streams, the required track stream exists and every used source range stays within probed duration. Full decode integrity, shot-engine compatibility, continuity, delivery conformance requires a current-revision master with a successful output probe; the gate compares container, codec, resolution, frame rate, duration and required audio against the sequence or explicit delivery profile. Caption readiness requires saved cue-level WebVTT validation for timing, overlaps, reading speed, line length and media-duration bounds. Audio readiness requires saved probe and FFmpeg signal-analysis evidence; clipping and near-full-scale peaks require review. Rights status is based only on explicit asset metadata attestations and supporting references; this is not independent legal verification. This report does not grant approval, submit a provider request or render media.</small></section>';
}

// Preview monitor composites active video and overlay tracks in timeline order. FFmpeg remains authoritative for final output.
function timelineEndFrame(){
 if(!state.timeline)return 1;
 return Math.max(1,...state.timeline.tracks.flatMap(track=>track.clips.map(clip=>Math.ceil((seconds(clip.timelineStart)+seconds(clip.duration))*fps()))));
}
function activePreviewAtPlayhead(){
 if(!state.timeline)return [];
 const frame=Math.min(timelineEndFrame(),Math.max(0,Math.floor(state.playheadFrame)));
 const evaluated=evaluateTimelineAtFrame(state.timeline,frame);
 const videoTracks=state.timeline.tracks.filter(track=>track.enabled&&track.kind==="video"&&track.clips.some(clip=>clip.enabled));
 state.previewError=videoTracks.length>1?"The master renderer currently supports one primary video track; additional video tracks are not included in this preview.":"";
 const primaryTrackId=videoTracks[0]?.id;
 return evaluated.activeClips.filter(clip=>clip.trackKind==="audio"||clip.trackKind==="overlay"||(clip.trackKind==="video"&&clip.trackId===primaryTrackId));
}
function renderPreviewLayers(clips:ReturnType<typeof activePreviewAtPlayhead>){
 return clips.map(clip=>{
  const source=state.previewSources[clip.assetId];
  const asset=state.assets.find(item=>item.id===clip.assetId);
  if(!source||!asset)return "";
  const isOverlay=clip.trackKind==="overlay";
  const timelineWidth=Math.max(1,Number(state.timeline?.width)||1920),timelineHeight=Math.max(1,Number(state.timeline?.height)||1080);
  const metadata=state.timeline?.tracks.find(track=>track.id===clip.trackId)?.clips.find(item=>item.id===clip.clipId)?.metadata||{};
  const overlayWidth=Math.max(16,Math.min(timelineWidth,Number(metadata.width)||timelineWidth*.24));
  const overlayHeight=Math.max(16,Math.min(timelineHeight,Number(metadata.height)||timelineHeight*.24));
  const overlayX=Math.max(0,Math.min(timelineWidth-overlayWidth,Number.isFinite(Number(metadata.x))?Number(metadata.x):timelineWidth-overlayWidth-24));
  const overlayY=Math.max(0,Math.min(timelineHeight-overlayHeight,Number.isFinite(Number(metadata.y))?Number(metadata.y):24));
  const opacity=Math.max(0,Math.min(1,Number(metadata.opacity??1)));
  const z=isOverlay?100+clip.trackIndex:1;
  const position=isOverlay?";left:"+overlayX/timelineWidth*100+"%;top:"+overlayY/timelineHeight*100+"%;width:"+overlayWidth/timelineWidth*100+"%;height:"+overlayHeight/timelineHeight*100+"%;opacity:"+opacity:"";
  if(source.mediaType.startsWith("audio/"))return '<audio data-preview-audio="'+esc(clip.clipId)+'" crossorigin="anonymous" preload="metadata" src="'+esc(source.url)+'"></audio>';
  if(source.mediaType.startsWith("video/"))return '<video class="timeline-preview-layer" data-preview-video="'+esc(clip.clipId)+'" data-track-index="'+clip.trackIndex+'" style="z-index:'+z+position+'" muted playsinline preload="metadata" src="'+esc(source.url)+'"></video>';
  if(source.mediaType.startsWith("image/"))return '<img class="timeline-preview-layer" data-preview-image="'+esc(clip.clipId)+'" data-track-index="'+clip.trackIndex+'" style="z-index:'+z+position+'" src="'+esc(source.url)+'" alt="'+esc(clip.clipName)+'">';
  return '<div class="timeline-preview-layer timeline-preview-unsupported" data-track-index="'+clip.trackIndex+'" style="z-index:'+z+'">'+esc(asset.name)+' · unsupported preview format</div>';
 }).join("")||'<div class="timeline-preview-empty">Move the playhead over a video or overlay clip to preview the composite.</div>';
}
async function syncPreview(){
 const request=++previewRequest;
 if(!state.timeline)return;
 let active:ReturnType<typeof activePreviewAtPlayhead>=[];
 try{active=activePreviewAtPlayhead();}catch(error){state.previewError=error instanceof Error?error.message:"Timeline cannot be previewed.";const label=document.querySelector<HTMLElement>("#tl-preview-active");if(label)label.textContent=state.previewError;return;}
 state.previewActiveClips=active;
 const label=document.querySelector<HTMLElement>("#tl-preview-active");
 const layerSummary=active.map(clip=>clip.clipName+" · "+clip.trackName+" · "+clip.sourceTimeSeconds.toFixed(3)+"s").join(" | ");
 if(label)label.textContent=(layerSummary||"No active video or overlay clips at this frame.")+(state.previewError?" · "+state.previewError:"");
 if(!active.length){
  state.previewLayerKey="";state.previewPlaying=false;
  for(const video of document.querySelectorAll<HTMLVideoElement>("[data-preview-video]")){video.pause();video.removeAttribute("src");video.load();}
  for(const audio of document.querySelectorAll<HTMLAudioElement>("[data-preview-audio]")){audio.pause();audio.removeAttribute("src");audio.load();}
  state.audioEngine?.sync([]);
  const toggle=document.querySelector<HTMLButtonElement>("[data-tl-preview-toggle]");if(toggle)toggle.textContent="Play preview";
  const stage=document.querySelector<HTMLElement>("#tl-preview-layers");
  if(stage)stage.innerHTML=renderPreviewLayers([]);
  return;
 }
 const uniqueAssets=[...new Set(active.map(clip=>clip.assetId))];
 let changed=false;
 try{
  await Promise.all(uniqueAssets.map(async assetId=>{
   if(state.previewSources[assetId])return;
   const asset=state.assets.find(item=>item.id===assetId);
   if(!asset)return;
   let url="/api/assets/"+encodeURIComponent(assetId)+"/file";
   if(state.mode==="cloud"){
    const signed=await apiRequest<{url:string}>("/api/cloud/assets/"+encodeURIComponent(assetId));
    url=signed.url;
   }
   if(request!==previewRequest)return;
   state.previewSources[assetId]={url,mediaType:asset.mediaType};
   changed=true;
  }));
  if(request!==previewRequest)return;
  const missing=active.filter(clip=>!state.previewSources[clip.assetId]);
  if(missing.length){if(label)label.textContent="One or more active source assets are unavailable in this workspace.";return;}
  const key=active.map(clip=>clip.trackId+":"+clip.clipId+":"+clip.assetId).join("|");
  const stage=document.querySelector<HTMLElement>("#tl-preview-layers");
  if(stage&&(key!==state.previewLayerKey||changed)){
   for(const video of stage.querySelectorAll<HTMLVideoElement>("[data-preview-video]"))video.pause();
   for(const audio of stage.querySelectorAll<HTMLAudioElement>("[data-preview-audio]"))audio.pause();
   state.previewLayerKey=key;
   stage.innerHTML=renderPreviewLayers(active);
  }
  const videoClips=active.filter(clip=>state.previewSources[clip.assetId]?.mediaType.startsWith("video/"));
  const audioClips=active.filter(clip=>state.previewSources[clip.assetId]?.mediaType.startsWith("audio/"));
  const primary=videoClips[0]||null;
  const primaryAudio=audioClips[0]||null;
  for(const clip of videoClips){
   const video=document.querySelector<HTMLVideoElement>('[data-preview-video="'+CSS.escape(clip.clipId)+'"]');
   if(!video)continue;
   const target=Math.max(0,clip.sourceTimeSeconds);
   if(video.readyState>=1&&Math.abs(video.currentTime-target)>0.12)video.currentTime=target;
   if(video.readyState<1)video.onloadedmetadata=()=>{if(state.previewActiveClips.some(item=>item.clipId===clip.clipId))video.currentTime=target;if(state.previewPlaying)void video.play().catch(()=>{state.previewPlaying=false;});};
   if(state.previewPlaying&&video.paused&&video.readyState>=2)void video.play().catch(()=>{state.previewPlaying=false;});
   if(clip.clipId===primary?.clipId){
    video.ontimeupdate=()=>{
     const current=state.previewActiveClips.find(item=>item.clipId===clip.clipId);
     if(!current||!state.timeline)return;
     const sourceClip=state.timeline.tracks.find(track=>track.id===current.trackId)?.clips.find(item=>item.id===current.clipId);
     if(!sourceClip)return;
     const sourceStart=seconds(sourceClip.sourceRange.start);
     const sourceEnd=sourceStart+current.timelineEndSeconds-current.timelineStartSeconds;
     if(video.currentTime>=sourceEnd-0.025){
      for(const node of document.querySelectorAll<HTMLVideoElement>("[data-preview-video]"))node.pause();
      state.playheadFrame=Math.ceil(current.timelineEndSeconds*fps());
      const slider=document.querySelector<HTMLInputElement>("#tl-playhead");if(slider)slider.value=String(state.playheadFrame);
      const readout=document.querySelector<HTMLElement>("#tl-playhead-label");if(readout)readout.textContent="Frame "+state.playheadFrame+" · "+(state.playheadFrame/fps()).toFixed(3)+"s";
      void syncPreview();return;
     }
     state.playheadFrame=Math.max(0,Math.floor((current.timelineStartSeconds+Math.max(0,video.currentTime-sourceStart))*fps()));
     const slider=document.querySelector<HTMLInputElement>("#tl-playhead");if(slider)slider.value=String(state.playheadFrame);
     const readout=document.querySelector<HTMLElement>("#tl-playhead-label");if(readout)readout.textContent="Frame "+state.playheadFrame+" · "+(state.playheadFrame/fps()).toFixed(3)+"s";
     void syncPreview();
    };
   }
  }
  for(const clip of audioClips){
   const audio=document.querySelector<HTMLAudioElement>('[data-preview-audio="'+CSS.escape(clip.clipId)+'"]');
   if(!audio)continue;
   const sourceClip=state.timeline.tracks.find(track=>track.id===clip.trackId)?.clips.find(item=>item.id===clip.clipId);
   if(!sourceClip)continue;
   const target=Math.max(0,clip.sourceTimeSeconds);
   const localTime=Math.max(0,audio.currentTime-seconds(sourceClip.sourceRange.start)),gainDb=evaluateAudioAutomation(sourceClip.audioAutomation,localTime,"gainDb",Number(sourceClip.gainDb)||0);
   audio.volume=state.audioEngine?1:decibelsToGain(Math.min(0,gainDb));
   if(audio.readyState>=1&&Math.abs(audio.currentTime-target)>0.25)audio.currentTime=target;
   if(audio.readyState<1)audio.onloadedmetadata=()=>{if(state.previewActiveClips.some(item=>item.clipId===clip.clipId))audio.currentTime=target;if(state.previewPlaying)void audio.play().catch(()=>{state.previewPlaying=false;});};
   if(state.previewPlaying&&audio.paused&&audio.readyState>=2)void audio.play().catch(()=>{state.previewPlaying=false;});
   audio.ontimeupdate=()=>{
    const current=state.previewActiveClips.find(item=>item.clipId===clip.clipId);
    if(clip.clipId!==primaryAudio?.clipId||!current||!state.timeline||state.previewActiveClips.some(item=>item.trackKind==="video"))return;
    const frame=Math.max(0,Math.floor((current.timelineStartSeconds+Math.max(0,audio.currentTime-seconds(sourceClip.sourceRange.start)))*fps()));
    state.playheadFrame=frame;
    const slider=document.querySelector<HTMLInputElement>("#tl-playhead");if(slider)slider.value=String(frame);
    const readout=document.querySelector<HTMLElement>("#tl-playhead-label");if(readout)readout.textContent="Frame "+frame+" · "+(frame/fps()).toFixed(3)+"s";
    void syncPreview();
   };
   audio.onended=()=>{if(state.previewPlaying)void syncPreview();};
  }
  if(state.audioEngine){
   const inputs:AudioPreviewTrackInput[]=[];
   for(const clip of audioClips){
    const media=document.querySelector<HTMLAudioElement>('[data-preview-audio="'+CSS.escape(clip.clipId)+'"]');
    const sourceClip=state.timeline?.tracks.find(track=>track.id===clip.trackId)?.clips.find(item=>item.id===clip.clipId);
    const controls=state.audioTrackStates[clip.trackId]||{muted:false,solo:false};
    if(media&&sourceClip)inputs.push({id:clip.clipId,media,gainDb:Number(sourceClip.gainDb)||0,pan:Number(sourceClip.pan)||0,automation:sourceClip.audioAutomation,automationTime:Math.max(0,media.currentTime-seconds(sourceClip.sourceRange.start)),muted:controls.muted,solo:controls.solo});
   }
   state.audioEngine.setMasterVolume(state.audioMasterVolume);
   state.audioEngine.setMasterMuted(state.audioMasterMuted);
   state.audioEngine.sync(inputs);
  }
 }catch(error){state.previewError=error instanceof Error?error.message:"Could not load preview sources.";if(label)label.textContent=state.previewError;}
}
function previewMonitor(){
 if(!state.timeline)return '<section class="panel"><div class="eyebrow">PREVIEW MONITOR</div><p class="muted">Load a timeline to preview its active source clips.</p></section>';
 let active:ReturnType<typeof activePreviewAtPlayhead>=[];
 try{active=activePreviewAtPlayhead();}catch(error){state.previewError=error instanceof Error?error.message:"Timeline cannot be previewed.";}
 const videoCount=active.filter(clip=>state.assets.find(asset=>asset.id===clip.assetId)?.mediaType.startsWith("video/")).length;
 const audioCount=active.filter(clip=>state.assets.find(asset=>asset.id===clip.assetId)?.mediaType.startsWith("audio/")).length;
 return '<section class="panel timeline-preview-panel"><div class="timeline-panel-heading"><div><div class="eyebrow">MULTI-TRACK COMPOSITE PREVIEW</div><h3>Preview monitor</h3></div><span class="job-status '+(active.length?"completed":"running")+'">'+(active.length?active.length+" ACTIVE LAYERS":"NO ACTIVE LAYERS")+'</span></div><div class="timeline-preview-stage" style="aspect-ratio: '+(state.timeline.width||1920)+' / '+(state.timeline.height||1080)+' "><div id="tl-preview-layers">'+renderPreviewLayers(active)+'</div></div><div class="timeline-preview-controls"><label for="tl-playhead">Playhead frame</label><input id="tl-playhead" type="range" min="0" max="'+timelineEndFrame()+'" step="1" value="'+Math.min(timelineEndFrame(),Math.max(0,state.playheadFrame))+'"><strong id="tl-playhead-label">Frame '+state.playheadFrame+' · '+(state.playheadFrame/fps()).toFixed(3)+'s</strong></div><div class="timeline-preview-actions"><button class="secondary" type="button" data-tl-preview-toggle '+(videoCount||audioCount?"":"disabled")+'>'+(state.previewPlaying?"Pause preview":"Play preview")+'</button><label class="audio-master-control">Master <input type="range" min="0" max="100" step="1" value="'+Math.round(state.audioMasterVolume*100)+'" data-audio-master-volume></label><button class="secondary" type="button" data-audio-master-mute>'+(state.audioMasterMuted?"Unmute master":"Mute master")+'</button><span class="muted">'+active.filter(clip=>clip.trackKind!=="audio").length+' visual layer(s) · '+videoCount+' video · '+audioCount+' audio</span></div><p id="tl-preview-active" class="muted">'+(active.map(clip=>esc(clip.clipName)+" · "+esc(clip.trackName)+" · "+clip.sourceTimeSeconds.toFixed(3)+"s").join(" | ")||"No active video or overlay clips at this frame.")+(state.previewError?" · "+esc(state.previewError):"")+'</p><small class="muted">Visual layers follow timeline order. Audio tracks preview as synchronized source clips with per-clip gain; final mixing and limiting remain in FFmpeg.</small></section>';
}
document.addEventListener("click",async event=>{
 const masterMute=(event.target as HTMLElement).closest<HTMLButtonElement>("[data-audio-master-mute]");
 if(masterMute){state.audioMasterMuted=!state.audioMasterMuted;state.audioEngine?.setMasterMuted(state.audioMasterMuted);masterMute.textContent=state.audioMasterMuted?"Unmute master":"Mute master";return;}
 const button=(event.target as HTMLElement).closest<HTMLButtonElement>("[data-tl-preview-toggle]");
 if(!button)return;
 const videos=[...document.querySelectorAll<HTMLVideoElement>("[data-preview-video]")];
 const audios=[...document.querySelectorAll<HTMLAudioElement>("[data-preview-audio]")];
 if(!videos.length&&!audios.length)return;
 state.previewPlaying=!state.previewPlaying;
 button.textContent=state.previewPlaying?"Pause preview":"Play preview";
 if(state.previewPlaying){
  void (async()=>{
   if(audios.length){
    try{if(!state.audioEngine)state.audioEngine=await AudioPreviewEngine.create();else await state.audioEngine.resume();await syncPreview();}
    catch(error){state.previewError=error instanceof Error?error.message:"Web Audio is unavailable; native audio preview will be used.";}
   }
   const activeAudios=[...document.querySelectorAll<HTMLAudioElement>("[data-preview-audio]")];
   for(const audio of activeAudios){
    const clip=state.previewActiveClips.find(item=>item.clipId===audio.dataset.previewAudio);
    const source=clip&&state.timeline?.tracks.find(track=>track.id===clip.trackId)?.clips.find(item=>item.id===clip.clipId);
    audio.volume=state.audioEngine?1:decibelsToGain(Number(source?.gainDb)||0);
   }
   await Promise.all([...videos.map(video=>video.play().catch(()=>{state.previewPlaying=false;})),...activeAudios.map(audio=>audio.play().catch(()=>{state.previewPlaying=false;}))]);
   if(!state.previewPlaying){for(const video of videos)video.pause();for(const audio of activeAudios)audio.pause();}
   const current=document.querySelector<HTMLButtonElement>("[data-tl-preview-toggle]");
   if(current)current.textContent=state.previewPlaying?"Pause preview":"Play preview";
  })();
 }else{videos.forEach(video=>video.pause());audios.forEach(audio=>audio.pause());}
});

function masteringPanel(){
 if(state.mode!=="cloud")return "";
 const settings=state.masteringSettings,report=state.masteringReport;
 const metric=(value:number|null|undefined,suffix:string)=>typeof value==="number"&&Number.isFinite(value)?value.toFixed(1)+suffix:"—";
 const reportHtml=report?'<div class="mastering-report '+(report.verified?'verified':'needs-review')+'"><div class="mastering-report-heading"><b>'+(report.verified?'Output checks passed':'Output needs review')+'</b><span>'+(report.verified?'VERIFIED':'REVIEW')+'</span></div><div class="mastering-metrics"><div><small>Integrated loudness</small><strong>'+metric(report.output?.integratedLufs,' LUFS')+'</strong></div><div><small>True peak</small><strong>'+metric(report.output?.truePeakDbtp,' dBTP')+'</strong></div><div><small>Loudness range</small><strong>'+metric(report.output?.loudnessRange,' LU')+'</strong></div><div><small>Normalization</small><strong>'+esc(report.output?.normalizationType||'Unknown')+'</strong></div></div>'+(report.findings?.length?'<ul class="mastering-findings">'+report.findings.map(item=>'<li><b>'+esc(item.code)+'</b> · '+esc(item.message)+'</li>').join('')+'</ul>':'<p class="muted">No loudness or true-peak findings were reported.</p>')+'</div><button class="secondary mastering-report-download" data-tl-action="download-mastering-report">Download mastering report · JSON</button>':'';
 const historyHtml=state.cloudRenderJobs.length?'<div class="mastering-history"><div class="eyebrow">RECENT CLOUD EXPORTS · SELECT TO INSPECT</div>'+state.cloudRenderJobs.slice(0,5).map(job=>'<button type="button" class="mastering-history-row '+(job.id===state.cloudRenderJobId?'selected':'')+'" data-tl-action="select-render-job" data-job-id="'+esc(job.id)+'"><span>'+esc(job.status.toUpperCase())+'</span><b>'+Math.max(0,Math.min(100,Number(job.progress)||0))+'%</b><small>'+esc(new Date(job.created_at).toLocaleString())+'</small></button>').join('')+'</div>':'';
 return '<section class="panel mastering-panel"><div class="mastering-panel-head"><div><div class="eyebrow">CLOUD EXPORT · AUDIO FINISHING</div><h3>Mastering & loudness</h3><p class="muted">Normalize the completed timeline mix and attach measured output evidence to the exported asset.</p></div><label class="mastering-enable"><input id="tl-mastering-enabled" type="checkbox" '+(settings.enabled?'checked':'')+'> Enable mastering</label></div><div class="mastering-controls '+(settings.enabled?'':'is-disabled')+'"><label>Integrated loudness (LUFS)<input name="masteringIntegratedLufs" type="number" min="-70" max="-5" step="0.1" value="'+settings.integratedLufs+'" '+(settings.enabled?'':'disabled')+'></label><label>Loudness range (LU)<input name="masteringLoudnessRange" type="number" min="1" max="50" step="0.1" value="'+settings.loudnessRange+'" '+(settings.enabled?'':'disabled')+'></label><label>True-peak ceiling (dBTP)<input name="masteringTruePeakDbtp" type="number" min="-9" max="0" step="0.1" value="'+settings.truePeakDbtp+'" '+(settings.enabled?'':'disabled')+'></label><label class="mastering-dual-mono"><input name="masteringDualMono" type="checkbox" '+(settings.dualMono?'checked':'')+' '+(settings.enabled?'':'disabled')+'> Treat mono audio as dual-mono</label></div><p class="mastering-note">Defaults: −16 LUFS · 11 LU · −1.5 dBTP. The renderer measures the finished mix; source clips are not normalized independently. Dynamic fallback and target misses are reported rather than hidden.</p>'+reportHtml+historyHtml+'</section>';
}
function readMasteringSettings(){
 if(state.mode!=="cloud")return null;
 const panel=document.querySelector<HTMLElement>(".mastering-panel");
 if(!panel)return null;
 const value=(name:string)=>panel.querySelector<HTMLInputElement>('[name="'+name+'"]')?.value??"";
 const enabled=document.querySelector<HTMLInputElement>("#tl-mastering-enabled")?.checked===true;
 if(!enabled){state.masteringSettings={...state.masteringSettings,enabled:false};return null;}
 const integratedLufs=Number(value("masteringIntegratedLufs")),loudnessRange=Number(value("masteringLoudnessRange")),truePeakDbtp=Number(value("masteringTruePeakDbtp")),dualMono=panel.querySelector<HTMLInputElement>('[name="masteringDualMono"]')?.checked===true;
 if(!Number.isFinite(integratedLufs)||integratedLufs< -70||integratedLufs> -5)throw new Error("Integrated loudness must be between −70 and −5 LUFS.");
 if(!Number.isFinite(loudnessRange)||loudnessRange<1||loudnessRange>50)throw new Error("Loudness range must be between 1 and 50 LU.");
 if(!Number.isFinite(truePeakDbtp)||truePeakDbtp< -9||truePeakDbtp>0)throw new Error("True-peak ceiling must be between −9 and 0 dBTP.");
 state.masteringSettings={enabled:true,integratedLufs,loudnessRange,truePeakDbtp,dualMono};
 return state.masteringSettings;
}

export function renderTimelineWorkspace(){
 return '<div id="timeline-workspace"><div class="timeline-toolbar"><label>Workspace <select id="tl-mode"><option value="local" '+(state.mode==="local"?"selected":"")+' >Local</option><option value="cloud" '+(state.mode==="cloud"?"selected":"")+' >Cloud project</option></select></label><label>Cloud project <select id="tl-cloud-project"><option value="">Select project</option>'+state.cloudProjects.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===state.cloudProjectId?'selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></label><label>Saved sequence <select id="tl-saved-sequence"><option value="">Current sequence</option>'+(state.mode==="cloud"?state.cloudTimelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""):state.timelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""))+'</select></label><button class="secondary" data-tl-create-cloud>＋ New cloud timeline</button><button class="secondary" data-tl-action="duplicate-variant">Duplicate as variant</button><span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="ready"?"TIMELINE SAVED":state.status==="auth"?"SIGN IN REQUIRED":state.status==="offline"?"API OFFLINE":"LOADING")+'</span><button class="secondary" data-tl-action="refresh">↻ Refresh</button><button class="secondary" data-tl-action="export">Export OTIO JSON</button>'+(state.mode==="cloud"&&state.cloudRenderJobId?'<button class="secondary" data-tl-action="cloud-job">Check cloud render · '+esc(state.cloudRenderJobStatus||"queued")+'</button>':'')+''+(state.ffmpeg?'<button class="primary" data-tl-action="render">Render master MP4</button>':'<span class="muted">FFmpeg required for master render</span>')+'</div>'+
 masteringPanel()+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+
 '<div class="timeline-editor-grid"><section class="panel"><div class="eyebrow">SEQUENCE SETTINGS</div><h3>'+(state.timeline?esc(state.timeline.name):"No sequence loaded")+'</h3>'+
 '<form id="tl-add-track"><label>Track name</label><input name="name" required placeholder="Video 2 / Music / Captions"><label>Track type</label><select name="kind"><option value="video">Video</option><option value="audio">Audio</option><option value="overlay">Overlay</option><option value="caption">Captions</option></select><button class="secondary">＋ Add track</button></form>'+
 '<div class="eyebrow" style="margin-top:18px">ADD SOURCE CLIP</div><form id="tl-add-clip"><label>Source asset</label><select id="tl-asset-select" name="assetId" required>'+assetOptions()+'</select><label>Destination track</label><select name="trackId">'+(state.timeline?.tracks.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join("")||"")+'</select><div class="form-grid"><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+maxEnd()+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="0"></div><div><label>Duration (timeline frames)</label><input name="duration" type="number" min="1" value="'+(fps()*5)+'"></div></div><button class="primary wide">＋ Place clip on timeline</button></form>'+
 '<form id="tl-add-marker"><div class="eyebrow" style="margin-top:18px">REVIEW MARKER</div><label>Marker title</label><input name="name" required placeholder="Hook / transition / review note"><label>Position (frames)</label><input name="frame" type="number" min="0" value="0"><button class="secondary">＋ Add marker</button></form></section>'+
 '<section class="panel"><div class="timeline-panel-heading"><div><div class="eyebrow">MULTI-TRACK EDITOR</div><h3>Sequence timeline</h3></div><small>'+(state.timeline?.frameRate.numerator+"/"+state.timeline?.frameRate.denominator+" fps")+'</small></div>'+
 previewMonitor()+
 (state.timeline?timelineCanvas():'<div class="empty">Sign in and create a sequence to begin.</div>')+
 clipInspector()+variantComparisonPanel()+creativeTraceabilityPanel()+timelineQualityPanel()+
  '<div class="timeline-marker-list">'+(state.timeline?.markers.map(m=>'<span>◆ '+esc(m.name)+' · '+Math.round(m.start.value)+'f</span>').join("")||"No review markers yet.")+'</div></section></div>'+
 '<div class="notice">Master rendering now supports synchronized audio mixing, image overlays and burned-in SRT/VTT captions. Frame preview/playback, transitions, effects, animated overlays and video-on-video compositing remain future milestones.</div></div>';
}
async function refresh(){
 if(state.mode==="cloud"){
  const projects=await apiRequest<{projects:CloudProject[]}>("/api/cloud/projects");
  state.cloudProjects=projects.projects||[];
  if(!state.cloudProjectId||!state.cloudProjects.some(p=>p.id===state.cloudProjectId))state.cloudProjectId=state.cloudProjects[0]?.id||"";
  if(!state.cloudProjectId){state.assets=[];state.cloudTimelines=[];state.cloudRenderJobs=[];state.cloudRenderJobId="";state.cloudRenderJobStatus="";state.masteringReport=null;state.timeline=null;state.message="Create a cloud project first, then select it here.";state.status="ready";return;}
  const query="?projectId="+encodeURIComponent(state.cloudProjectId);
  const [assets,timelines,jobs]=await Promise.all([
   apiRequest<{assets:Asset[]}>("/api/cloud/assets"+query),
   apiRequest<{timelines:CloudSavedTimeline[]}>("/api/cloud/timelines"+query),
   apiRequest<{jobs:CloudRenderJob[]}>("/api/cloud/jobs"+query+"&limit=20")
  ]);
  state.assets=assets.assets||[];state.cloudTimelines=timelines.timelines||[];state.cloudRenderJobs=jobs.jobs||[];state.timelines=[];
  if(state.cloudRenderJobs.length){
   const selectedJob=state.cloudRenderJobs.find(job=>job.id===state.cloudRenderJobId)||state.cloudRenderJobs[0];
   state.cloudRenderJobId=selectedJob.id;state.cloudRenderJobStatus=selectedJob.status;
   state.masteringReport=selectedJob.output?.mastering||null;
  }else{state.cloudRenderJobId="";state.cloudRenderJobStatus="";state.masteringReport=null;}
  if(state.timeline&&state.cloudTimelines.some(t=>t.id===state.timeline?.id)){
   const saved=state.cloudTimelines.find(t=>t.id===state.timeline?.id)!;state.timeline=saved.timeline;state.serverRevision=saved.revision;
  }else if(state.cloudTimelines.length){const saved=state.cloudTimelines[0];state.timeline=saved.timeline;state.serverRevision=saved.revision;}
  else state.timeline=null;
  state.ffmpeg=true;state.status="ready";state.message=state.timeline?"Cloud timeline loaded. Changes save to the selected private project.":"No saved cloud timeline yet. Create one to begin.";await loadVariantComparison();return;
 }
 const health=await apiRequest<{media:{ffmpeg:boolean}}>("/api/health");state.ffmpeg=health.media.ffmpeg;
 const [assetResponse,timelineResponse]=await Promise.all([apiRequest<{assets:Asset[]}>("/api/assets"),apiRequest<{timelines:SavedTimeline[]}>("/api/timelines")]);
 state.assets=assetResponse.assets;state.timelines=timelineResponse.timelines;
 if(state.timeline&&state.timelines.some(t=>t.id===state.timeline?.id)){
  const saved=await apiRequest<{timeline:SavedTimeline}>("/api/timelines/"+state.timeline.id);state.timeline=saved.timeline.document||state.timeline;state.serverRevision=saved.timeline.revision;
 }else if(state.timelines.length){
  const saved=await apiRequest<{timeline:SavedTimeline}>("/api/timelines/"+state.timelines[0].id);state.timeline=saved.timeline.document||null;state.serverRevision=saved.timeline.revision;
 }else{
  let timeline=createTimeline("","local-sequence","Untitled sequence",{numerator:24,denominator:1});
  timeline=addTrack(timeline,{id:crypto.randomUUID(),name:"Video 1",kind:"video",enabled:true,locked:false,clips:[]});
  timeline=addTrack(timeline,{id:crypto.randomUUID(),name:"Audio 1",kind:"audio",enabled:true,locked:false,clips:[]});
  const created=await apiRequest<{timeline:SavedTimeline}>("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:timeline.name,timeline})});
  state.timeline=created.timeline.document||null;state.serverRevision=created.timeline.revision;
 }
 state.selectedTrack=state.timeline?.tracks[0]?.id||"";
 if(!state.timeline?.tracks.some(track=>track.clips.some(clip=>clip.id===state.selectedClipId)))state.selectedClipId="";
 state.status="ready";state.message="";await loadVariantComparison();
}
async function persist(){
 if(!state.timeline)return;
 const otio=toOpenTimelineIo(state.timeline);
 if(state.mode==="cloud"){
  const result=await apiRequest<{timeline:CloudSavedTimeline}>("/api/cloud/timelines/"+state.timeline.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({expectedRevision:state.serverRevision,timeline:state.timeline,otio})});
  state.serverRevision=result.timeline.revision;state.timeline={...state.timeline,revision:result.timeline.revision};state.status="ready";state.message="Saved cloud revision "+result.timeline.revision+".";return;
 }
 const result=await apiRequest<{revision:number}>("/api/timelines/"+state.timeline.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:state.serverRevision,name:state.timeline.name,timeline:state.timeline,otio})});
 state.serverRevision=result.revision;state.timeline={...state.timeline,revision:result.revision};state.status="ready";state.message="Saved revision "+result.revision+".";
}
async function createCloudTimeline(){
 if(state.mode!=="cloud"||!state.cloudProjectId)throw new Error("Select a cloud project before creating a timeline.");
 let timeline=createTimeline(state.cloudProjectId,crypto.randomUUID(),"Untitled cloud sequence",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:crypto.randomUUID(),name:"Video 1",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:crypto.randomUUID(),name:"Audio 1",kind:"audio",enabled:true,locked:false,clips:[]});
 const result=await apiRequest<{timeline:CloudSavedTimeline}>("/api/cloud/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:state.cloudProjectId,name:timeline.name,timeline,otio:toOpenTimelineIo(timeline)})});
 state.timeline=result.timeline.timeline;state.serverRevision=result.timeline.revision;state.selectedTrack=timeline.tracks[0].id;state.message="Cloud timeline created.";state.status="ready";await refresh();paint();
}
export async function initTimelineWorkspace(){
 try{await refresh();}catch(error){state.status=error instanceof Error&&error.message.includes("Sign in")?"auth":"offline";state.message=error instanceof Error?error.message:"Timeline service unavailable.";}
 paint();
}
const waveformPending=new Set<string>();
async function loadTimelineWaveforms(){
 if(!state.timeline)return;
 const ids=[...new Set(state.timeline.tracks.filter(track=>track.enabled&&track.kind==="audio").flatMap(track=>track.clips.filter(clip=>clip.enabled).map(clip=>clip.assetId)))].slice(0,12);
 for(const assetId of ids){
  if(state.waveformCache[assetId]||waveformPending.has(assetId))continue;
  const asset=state.assets.find(item=>item.id===assetId);
  if(!asset||!asset.mediaType.startsWith("audio/"))continue;
  waveformPending.add(assetId);
  try{
   const waveformUrl=(state.mode==="cloud"?"/api/cloud/assets/":"/api/assets/")+encodeURIComponent(assetId)+"/waveform";
   const response=await fetch(waveformUrl,{credentials:"same-origin"});
   if(!response.ok){let message="Waveform generation failed ("+response.status+").";try{const body=await response.json() as {error?:{message?:string}};message=body.error?.message||message;}catch{}throw new Error(message);}
   state.waveformCache[assetId]='<img src="'+waveformUrl+'" alt="Audio waveform" />';
   state.waveformStatus[assetId]="";
   for(const node of document.querySelectorAll<HTMLElement>("[data-waveform-asset]"))if(node.dataset.waveformAsset===assetId)node.innerHTML=state.waveformCache[assetId];
  }catch(error){
   state.waveformStatus[assetId]=error instanceof Error?error.message:"Waveform decoding unavailable.";
   for(const node of document.querySelectorAll<HTMLElement>("[data-waveform-asset]"))if(node.dataset.waveformAsset===assetId)node.textContent=state.waveformStatus[assetId];
  }finally{waveformPending.delete(assetId);}
 }
}
function paint(){const root=document.querySelector<HTMLElement>("#timeline-workspace");if(root)root.outerHTML=renderTimelineWorkspace();void syncPreview();void loadTimelineWaveforms();}
async function runAction(action:HTMLElement){
 const type=action.dataset.tlAction||"";
 if(type==="refresh"){await refresh();paint();return;}
 if(type==="select-render-job"){
  const job=state.cloudRenderJobs.find(item=>item.id===action.dataset.jobId);
  if(!job)return;
  state.cloudRenderJobId=job.id;state.cloudRenderJobStatus=job.status;state.masteringReport=job.output?.mastering||null;
  state.message="Selected cloud render · "+job.status+(job.output?.outputAsset?.id?" · output asset "+job.output.outputAsset.id:"");
  paint();return;
 }
 if(type==="download-mastering-report"){
  const job=state.cloudRenderJobs.find(item=>item.id===state.cloudRenderJobId);
  const report=state.masteringReport||job?.output?.mastering;
  if(!report){state.message="No mastering report is available for the selected render.";paint();return;}
  const evidence={schema:"executive-visuals.mastering-report.v1",generatedAt:new Date().toISOString(),projectId:state.cloudProjectId,timelineId:state.timeline?.id||null,renderJob:{id:job?.id||state.cloudRenderJobId,status:job?.status||state.cloudRenderJobStatus,createdAt:job?.created_at||null,outputAsset:job?.output?.outputAsset||null},mastering:report,disclaimer:"This report records renderer-reported mastering measurements and findings. It is not an independent certification or a substitute for delivery-spec review."};
  const content=JSON.stringify(evidence,null,2),blob=new Blob([content],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download="mastering-report-"+(job?.id||"latest")+".json";link.click();URL.revokeObjectURL(url);return;
 }
 if(type==="cloud-job"&&state.cloudRenderJobId){try{const result=await apiRequest<{job:{id:string;status:string;progress?:number;output?:{outputAsset?:{id:string;name?:string};mastering?:NonNullable<typeof state.masteringReport>}}}>("/api/cloud/jobs/"+state.cloudRenderJobId);state.cloudRenderJobStatus=result.job.status;state.masteringReport=result.job.output?.mastering||null;state.message="Cloud render "+result.job.status+" · "+Number(result.job.progress||0)+"%"+(result.job.output?.outputAsset?.id?" · output asset "+result.job.output.outputAsset.id:"");if(result.job.status==="succeeded")await refresh();}catch(error){state.message=error instanceof Error?error.message:"Could not refresh cloud render status.";}paint();return;}
 if(type==="render"){
  if(!state.timeline||!state.ffmpeg){state.message="FFmpeg is required to render a master file.";paint();return;}
  try{
   await persist();
   if(state.mode==="cloud"){const mastering=readMasteringSettings();state.masteringReport=null;const queued=await apiRequest<{job:{id:string;status:string}}>("/api/cloud/timelines/"+state.timeline.id+"/render",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify(mastering?{mastering}:{})});state.cloudRenderJobId=queued.job.id;state.cloudRenderJobStatus=queued.job.status;}else await apiRequest("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType:"timeline.render",timelineId:state.timeline.id,projectId:state.timeline.projectId||undefined})});
   state.message=state.mode==="cloud"?"Cloud master render queued. Check Cloud Projects for durable job status.":"Master render queued. Check Production Operations for progress and the finished MP4.";
   window.dispatchEvent(new Event("ev:jobs-updated"));
  }catch(error){state.message=error instanceof Error?error.message:"Render could not be queued.";}
  paint();return;
 }
 if(type==="duplicate-variant"){try{await duplicateTimelineVariant();}catch(error){state.message=error instanceof Error?error.message:"Could not create timeline variant.";}paint();return;}
 if(!state.timeline)return;
 const trackId=action.dataset.track||"",clipId=action.dataset.clip||"";
 if(type==="split"){
  const track=state.timeline.tracks.find(t=>t.id===trackId),clip=track?.clips.find(c=>c.id===clipId);if(!track||!clip)return;
  const splitAt=Math.round(clip.timelineStart.value+clip.duration.value/2);
  state.timeline=splitClip(state.timeline,trackId,clipId,splitAt,crypto.randomUUID());
 }else if(type==="trim")state.timeline=trimClip(state.timeline,trackId,clipId,12,12);
 else if(type==="move"){
  const from=state.timeline.tracks.findIndex(t=>t.id===trackId);const target=state.timeline.tracks[(from+1)%state.timeline.tracks.length];if(!target)return;
  const clip=state.timeline.tracks[from].clips.find(c=>c.id===clipId);if(!clip)return;
  const start=maxEnd()+12;state.timeline=moveClip(state.timeline,trackId,clipId,target.id,start);
 }else if(type==="export"){
  const content=JSON.stringify(toOpenTimelineIo(state.timeline),null,2);
  const blob=new Blob([content],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=(state.timeline.name||"timeline").replace(/[^a-z0-9-_]/gi,"-")+".otio.json";a.click();URL.revokeObjectURL(url);return;
 }
 state.message="Saving timeline revision…";paint();
 try{await persist();}catch(error){state.message=error instanceof Error?error.message:"Save failed.";state.status="offline";}paint();
}
document.addEventListener("submit",event=>{
 const form=event.target as HTMLFormElement;if(!state.timeline)return;
 if(form.id==="tl-add-track"){
  event.preventDefault();const data=new FormData(form),name=String(data.get("name")||"").trim(),kind=String(data.get("kind")||"video") as TimelineTrack["kind"];
  if(!name)return;
  state.timeline=addTrack(state.timeline,{id:crypto.randomUUID(),name,kind,enabled:true,locked:false,clips:[]});
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-add-clip"){
  event.preventDefault();const data=new FormData(form),assetId=String(data.get("assetId")||""),trackId=String(data.get("trackId")||"");
  const start=Math.max(0,Number(data.get("start"))||0),sourceIn=Math.max(0,Number(data.get("sourceIn"))||0),duration=Math.max(1,Number(data.get("duration"))||1);
  const asset=state.assets.find(a=>a.id===assetId);if(!asset)return;
  const destination=state.timeline.tracks.find(t=>t.id===trackId);
  if(destination?.kind==="audio"&&!asset.mediaType.startsWith("audio/")){alert("Audio tracks require audio assets.");return;}
  if(destination?.kind==="video"&&!asset.mediaType.startsWith("video/")&&!asset.mediaType.startsWith("image/")){alert("Video tracks require image or video assets.");return;}
  if(destination?.kind==="overlay"&&!asset.mediaType.startsWith("image/")){alert("Overlay tracks currently require still-image assets.");return;}
  if(destination?.kind==="caption"&&(!["text/plain","text/vtt"].includes(asset.mediaType)||!["srt","vtt"].includes(asset.name.toLowerCase().split(".").pop()||""))){alert("Caption tracks require an SRT or VTT text file.");return;}
  const sourceFps=sourceRate(asset,destination?.kind||"video");
  const sourceDuration=duration/fps()*sourceFps;
  try{state.timeline=addClip(state.timeline,trackId,{id:crypto.randomUUID(),assetId,name:asset.name,sourceRange:{start:rational(sourceIn,sourceFps),duration:rational(sourceDuration,sourceFps)},timelineStart:rational(start,fps()),duration:rational(duration,fps()),enabled:true});}
  catch(error){alert(error instanceof Error?error.message:String(error));return;}
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-clip-inspector"){
  event.preventDefault();const data=new FormData(form),trackId=form.dataset.track||"",clipId=form.dataset.clip||"";
  const track=state.timeline.tracks.find(item=>item.id===trackId),clip=track?.clips.find(item=>item.id===clipId);if(!track||!clip)return;
  const asset=state.assets.find(item=>item.id===clip.assetId);if(!asset)return;
  const start=Math.max(0,Number(data.get("start"))||0),duration=Math.max(1,Number(data.get("duration"))||1),sourceIn=Math.max(0,Number(data.get("sourceIn"))||0),sourceFps=sourceRate(asset,track.kind);
  clip.name=String(data.get("name")||clip.name).trim()||clip.name;
  clip.timelineStart=rational(start,fps());clip.duration=rational(duration,fps());
  clip.sourceRange={start:rational(sourceIn,sourceFps),duration:rational(duration/fps()*sourceFps,sourceFps)};
  if(track.kind==="audio"){clip.gainDb=Math.max(-60,Math.min(24,Number(data.get("gainDb"))||0));clip.pan=Math.max(-1,Math.min(1,Number(data.get("pan"))||0));state.audioTrackStates[track.id]={muted:data.get("trackMuted")==="on",solo:data.get("trackSolo")==="on"};}
  if(track.kind==="overlay")clip.metadata={...clip.metadata,x:Number(data.get("x"))||0,y:Number(data.get("y"))||0,width:Math.max(16,Number(data.get("width"))||16),height:Math.max(16,Number(data.get("height"))||16),opacity:Math.max(0,Math.min(1,Number(data.get("opacity")??1)))};
  if(track.kind==="caption")clip.metadata={...clip.metadata,fontName:String(data.get("fontName")||"DejaVu Sans").slice(0,48),fontSize:Math.max(12,Math.min(96,Number(data.get("fontSize"))||32)),primaryColor:/^#[0-9a-f]{6}$/i.test(String(data.get("primaryColor")||""))?String(data.get("primaryColor")):"#FFFFFF",alignment:Math.max(1,Math.min(9,Number(data.get("alignment"))||2)),backgroundMode:data.get("backgroundMode")==="none"?"none":"box",backgroundColor:/^#[0-9a-f]{6}$/i.test(String(data.get("backgroundColor")||""))?String(data.get("backgroundColor")):"#000000",backgroundOpacity:Math.max(0,Math.min(1,Number(data.get("backgroundOpacity")??0.68))),outline:Math.max(0,Math.min(8,Number(data.get("outline")??2))),shadow:Math.max(0,Math.min(8,Number(data.get("shadow")??1))),marginV:Math.max(0,Math.min(240,Number(data.get("marginV"))||42))};
  const previousTrace=readCreativeTrace(clip),creativeTrace={storyBeat:String(data.get("storyBeat")||"").trim().slice(0,120),purpose:String(data.get("purpose")||"").trim().slice(0,500),audiencePromise:String(data.get("audiencePromise")||"").trim().slice(0,300),proofReference:String(data.get("proofReference")||"").trim().slice(0,300),decisionNote:String(data.get("decisionNote")||"").trim().slice(0,500)},nextTrace=Object.values(creativeTrace).some(Boolean)?creativeTrace:null;
  const decisionHistory=appendCreativeDecision(readCreativeDecisionHistory(clip),previousTrace,nextTrace,crypto.randomUUID(),new Date().toISOString());
  const nextMetadata:Record<string,unknown>={...clip.metadata,creativeTraceHistory:decisionHistory};
  if(nextTrace)nextMetadata.creativeTrace=nextTrace;else delete nextMetadata.creativeTrace;
  clip.metadata=nextMetadata;
  state.message="Saving clip properties…";void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-add-marker"){
  event.preventDefault();const data=new FormData(form);
  state.timeline=addMarker(state.timeline,{id:crypto.randomUUID(),name:String(data.get("name")),start:rational(Math.max(0,Number(data.get("frame"))||0),fps()),color:"YELLOW"});
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
});
document.addEventListener("input",event=>{
 const target=event.target as HTMLInputElement;
 if(target.hasAttribute("data-audio-master-volume")){state.audioMasterVolume=Math.max(0,Math.min(1,Number(target.value)/100));state.audioEngine?.setMasterVolume(state.audioMasterVolume);}
 if(target.id==="tl-playhead"){state.playheadFrame=Math.max(0,Math.min(timelineEndFrame(),Math.floor(Number(target.value)||0)));const label=document.querySelector<HTMLElement>("#tl-playhead-label");if(label)label.textContent="Frame "+state.playheadFrame+" · "+(state.playheadFrame/fps()).toFixed(3)+"s";void syncPreview();}
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLInputElement;
 if(target.id==="tl-mastering-enabled"){
  state.masteringSettings.enabled=target.checked;
  const panel=target.closest<HTMLElement>(".mastering-panel");
  panel?.querySelectorAll<HTMLInputElement>(".mastering-controls input").forEach(input=>{input.disabled=!target.checked;});
  panel?.querySelector<HTMLElement>(".mastering-controls")?.classList.toggle("is-disabled",!target.checked);
 }
 if(target.name==="masteringDualMono")state.masteringSettings.dualMono=target.checked;
 if(target.name==="masteringIntegratedLufs")state.masteringSettings.integratedLufs=Number(target.value);
 if(target.name==="masteringLoudnessRange")state.masteringSettings.loudnessRange=Number(target.value);
 if(target.name==="masteringTruePeakDbtp")state.masteringSettings.truePeakDbtp=Number(target.value);
 if(target.id==="tl-mode"){state.mode=target.value==="cloud"?"cloud":"local";state.timeline=null;state.selectedClipId="";void refresh().then(paint).catch(error=>{state.status="offline";state.message=error instanceof Error?error.message:"Workspace unavailable.";paint();});}
 if(target.id==="tl-cloud-project"){state.cloudProjectId=target.value;state.timeline=null;state.selectedClipId="";void refresh().then(paint).catch(error=>{state.status="offline";state.message=error instanceof Error?error.message:"Cloud project unavailable.";paint();});}
 if(target.id==="tl-saved-sequence"&&target.value){
  const saved=state.mode==="cloud"?state.cloudTimelines.find(t=>t.id===target.value):state.timelines.find(t=>t.id===target.value);
  if(saved){if(state.mode==="cloud"){const cloud=saved as CloudSavedTimeline;state.timeline=cloud.timeline;state.serverRevision=cloud.revision;void loadVariantComparison().then(paint);}
   else void apiRequest<{timeline:SavedTimeline}>("/api/timelines/"+saved.id).then(result=>{state.timeline=result.timeline.document||null;state.serverRevision=result.timeline.revision;void loadVariantComparison().then(paint);}).catch(error=>{state.message=error.message;paint();});}
 }
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLSelectElement;
 if(target.id==="tl-asset-select"){
  const asset=state.assets.find(a=>a.id===target.value);
  const probe=asset?.metadata?.probe as {format?:{duration?:string}}|undefined;
  const duration=asset?.mediaType==="text/vtt"?Number(asset.metadata?.durationSeconds):Number(probe?.format?.duration);
  const input=document.querySelector<HTMLInputElement>('#tl-add-clip input[name="duration"]');
  if(input&&Number.isFinite(duration))input.value=String(Math.max(1,Math.floor(duration*fps())));
 }
});
document.addEventListener("click",async event=>{
 const create=(event.target as HTMLElement).closest<HTMLElement>("[data-tl-create-cloud]");if(create){void createCloudTimeline().catch(error=>{state.message=error instanceof Error?error.message:"Cloud timeline creation failed.";paint();});return;}
 const keyframe=(event.target as HTMLElement).closest<HTMLElement>("[data-tl-audio-keyframe]");
 if(keyframe&&state.timeline){
  const track=state.timeline.tracks.find(item=>item.id===keyframe.dataset.track),clip=track?.clips.find(item=>item.id===keyframe.dataset.clip),form=document.querySelector<HTMLFormElement>("#tl-clip-inspector");
  if(!track||track.kind!=="audio"||!clip||!form)return;
  const localTime=state.playheadFrame/fps()-seconds(clip.timelineStart),duration=seconds(clip.duration);
  if(localTime<0||localTime>duration){alert("Move the playhead inside the selected audio clip before adding a keyframe.");return;}
  const formData=new FormData(form),gainDb=Math.max(-60,Math.min(24,Number(formData.get("gainDb"))||0)),pan=Math.max(-1,Math.min(1,Number(formData.get("pan"))||0));
  const points=[...(clip.audioAutomation||[])],existing=points.findIndex(point=>Math.abs(point.timeSeconds-localTime)<0.0005),point={timeSeconds:Number(localTime.toFixed(4)),gainDb,pan,interpolation:"linear" as const};
  if(existing>=0)points[existing]=point;else points.push(point);
  clip.audioAutomation=points.sort((a,b)=>a.timeSeconds-b.timeSeconds);
  state.selectedTrack=track.id;state.selectedClipId=clip.id;state.message="Saving audio automation keyframe…";
  try{await persist();state.message="Audio automation keyframe saved.";paint();}catch(error){state.message=error instanceof Error?error.message:"Could not save audio keyframe.";paint();}
  return;
 }
 const target=event.target as HTMLElement,select=target.closest<HTMLElement>("[data-tl-select]");
 if(select&&state.timeline){state.selectedTrack=select.dataset.track||"";state.selectedClipId=select.dataset.clip||"";paint();}
 const action=target.closest<HTMLElement>("[data-tl-action]");
 if(action)void runAction(action);
});
window.addEventListener("ev:authenticated",()=>void initTimelineWorkspace());
window.addEventListener("ev:assets-updated",()=>void refresh().then(paint).catch(error=>{state.message=error.message;paint();}));
