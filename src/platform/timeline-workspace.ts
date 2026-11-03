import { apiRequest } from "../core/api";
import { analyzeTimelineQuality, assessTimelineRenderPreflight } from "../core/timeline-quality";
import { buildProductionReadinessReport } from "../core/production-readiness";
import { assessSourceMediaEvidence } from "../core/source-media-evidence";
import { assessRightsEvidence } from "../core/rights-evidence";
import { assessAudioEvidence } from "../core/audio-evidence";
import { assessCaptionEvidence } from "../core/caption-evidence";
import { assessDeliveryEvidence } from "../core/delivery-evidence";
import { analyzeCreativeTraceability, readCreativeTrace } from "../core/creative-traceability";
import { appendCreativeDecision, readCreativeDecisionHistory } from "../core/creative-decision-ledger";
import { compareTimelineVariants, createTimelineVariant, type TimelineVariantComparison } from "../core/timeline-variants";
import { addClip, addMarker, addTrack, createTimeline, moveClip, rational, removeClip, snapTimelineFrame, splitClip, toOpenTimelineIo, trimClip, setAudioTrackState, type EditorialTimeline, type TimelineTrack } from "../core/timeline";
import { clampPreviewSeconds, previewSecondsAtScrubFrame, stepPreviewSeconds } from "../core/timeline-preview";
import { assessDerivativeEligibility, replaceTimelineClipAsset } from "../core/timeline-derivatives";
import { createTimelineHistory, recordTimelineHistory, undoTimeline, redoTimeline, type TimelineHistory } from "../core/timeline-history";
import { getTimelineHistoryShortcut } from "../core/timeline-shortcuts";
import { getCaptionStylePreset, listCaptionStylePresets } from "../core/caption-style-presets";
import { applyTimelineTemplate, listTimelineTemplates } from "../core/timeline-templates";

type Asset={id:string;name:string;mediaType:string;size:number;sha256?:string;derivativeOf?:string|null;metadata?:Record<string,unknown>};
type SavedTimeline={id:string;projectId?:string|null;name:string;revision:number;document?:EditorialTimeline};
type CloudProject={id:string;name:string};
type CloudSavedTimeline={id:string;projectId?:string|null;name:string;revision:number;timeline:EditorialTimeline;updatedAt:string};
const state:{timeline:EditorialTimeline|null;serverRevision:number;timelines:SavedTimeline[];cloudTimelines:CloudSavedTimeline[];cloudProjects:CloudProject[];cloudProjectId:string;mode:"local"|"cloud";cloudRenderJobId:string;cloudRenderJobStatus:string;deliveryReview:{profileLabel?:string;status:string;counts?:{errors:number;warnings:number};findings?:Array<{code:string;severity:string;message:string}>;outputAsset?:{id:string;name?:string};sha256?:string;byteSize?:number;deliveryManifest?:{schemaVersion:number;fingerprint:string;timelineId:string;timelineRevision:string|number;outputAsset:string;sha256:string;byteSize:number;mediaType:string;profileId:string|null}}|null;deliveryApproval:{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}|null;deliveryApprovalHistory:Array<{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}>;deliveryApprovalBusy:boolean;deliveryPackageLink:{url:string;filename:string;expiresAt:number}|null;mediaQualityReport:{status:string;counts?:{errors:number;warnings:number};findings?:Array<{code:string;severity:string;message:string;startSeconds?:number;endSeconds?:number}>;signalAnalysis?:{lumaSampleCount:number;lumaCoverageSeconds:number;lumaAnalysisTruncated:boolean;unavailable?:Array<{check:string;reason:string}>}}|null;previewKey:string;previewUrl:string;previewExpiresAt:number;previewLoading:boolean;previewError:string;previewUsingProxy:boolean;previewWaveformUrl:string;derivativeComparison:{sourceId:string;derivativeId:string;sourceUrl:string;derivativeUrl:string;sourceName:string;derivativeName:string;sourceType:string;derivativeType:string;expiresAt:number}|null;derivativeComparisonLoading:boolean;derivativeComparisonError:string;variantBase:EditorialTimeline|null;variantReport:TimelineVariantComparison|null;variantBaseName:string;assets:Asset[];status:"loading"|"ready"|"offline"|"auth";message:string;selectedTrack:string;selectedClipId:string;ffmpeg:boolean;historyBusy:boolean;history:TimelineHistory}={
 timeline:null,serverRevision:0,timelines:[],cloudTimelines:[],cloudProjects:[],cloudProjectId:"",mode:"local",cloudRenderJobId:"",cloudRenderJobStatus:"",deliveryReview:null,deliveryApproval:null,deliveryApprovalHistory:[],deliveryApprovalBusy:false,deliveryPackageLink:null,mediaQualityReport:null,previewKey:"",previewUrl:"",previewExpiresAt:0,previewLoading:false,previewError:"",previewUsingProxy:false,previewWaveformUrl:"",derivativeComparison:null,derivativeComparisonLoading:false,derivativeComparisonError:"",variantBase:null,variantReport:null,variantBaseName:"",assets:[],status:"loading",message:"Loading editorial workspace…",selectedTrack:"",selectedClipId:"",ffmpeg:false,historyBusy:false,history:createTimelineHistory(50)
};
function recordEdit(){if(state.timeline)state.history=recordTimelineHistory(state.history,state.timeline);}
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
 state.timeline.tracks.map(track=>'<div class="editor-track"><div class="editor-track-label"><b>'+esc(track.name)+'</b><small>'+esc(track.kind)+(track.locked?' · locked':'')+'</small><button class="secondary" type="button" data-tl-action="track-toggle" data-track="'+esc(track.id)+'" aria-pressed="'+String(track.enabled!==false)+'" title="'+(track.enabled!==false?"Disable":"Enable")+' track">'+(track.enabled!==false?"Disable":"Enable")+'</button>'+(track.kind==="audio"?'<button class="secondary" type="button" data-tl-action="track-mute" data-track="'+esc(track.id)+'" aria-pressed="'+String(track.muted===true)+'">'+(track.muted===true?"Unmute":"Mute")+'</button><button class="secondary" type="button" data-tl-action="track-solo" data-track="'+esc(track.id)+'" aria-pressed="'+String(track.solo===true)+'">'+(track.solo===true?"Unsolo":"Solo")+'</button>':'')+'</div><div class="editor-track-lane">'+track.clips.map(clip=>'<article class="editor-clip '+(state.selectedClipId===clip.id?'selected':'')+'" data-tl-select="true" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'" style="left:'+Math.max(0,clip.timelineStart.value/total*100)+'%;width:'+Math.max(4,clip.duration.value/total*100)+'%"><b>'+esc(clip.name)+'</b>'+(state.selectedClipId===clip.id&&track.kind==="audio"&&state.previewWaveformUrl?'<img class="timeline-clip-waveform" style="display:block;width:100%;height:24px;object-fit:fill;opacity:.9" src="'+esc(state.previewWaveformUrl)+'" alt="Audio waveform">':'')+'<small>'+esc(clip.assetId.slice(0,8))+' · '+Math.round(clip.duration.value)+'f</small><div class="editor-clip-actions"><button data-tl-action="split" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Split</button><button data-tl-action="trim" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Trim 12f</button><button data-tl-action="move" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Next track</button><button data-tl-action="ripple-delete" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'" title="Remove this clip and close the gap on this track">Ripple delete</button></div></article>').join("")+'</div></div>').join("");
}
function selectedPreview(){
 if(!state.timeline)return null;
 const track=state.timeline.tracks.find(item=>item.clips.some(clip=>clip.id===state.selectedClipId));
 const clip=track?.clips.find(item=>item.id===state.selectedClipId);
 const asset=clip?state.assets.find(item=>item.id===clip.assetId):undefined;
 return track&&clip&&asset?{track,clip,asset}:null;
}
async function ensureCloudPreviewTicket(){
 if(state.mode!=="cloud"||!state.timeline)return;
 const selected=selectedPreview();if(!selected)return;
 const key=state.timeline.id+":"+state.serverRevision+":"+selected.asset.id;
 if(state.previewKey===key&&(state.previewLoading||state.previewUrl&&state.previewExpiresAt>Date.now()+15000))return;
 state.previewKey=key;state.previewUrl="";state.previewError="";state.previewUsingProxy=false;state.previewWaveformUrl="";state.previewLoading=true;
 try{
  const result=await apiRequest<{preview:{url:string;expiresIn:number;timelineRevision:number;usingProxy?:boolean;waveformUrl?:string|null}}>("/api/cloud/timelines/"+encodeURIComponent(state.timeline.id)+"/preview/"+encodeURIComponent(selected.asset.id)+"?revision="+encodeURIComponent(String(state.serverRevision)));
  const parsed=new URL(result.preview.url);
  if(parsed.protocol!=="https:"||result.preview.timelineRevision!==state.serverRevision)throw new Error("The private preview ticket was invalid or belongs to a stale timeline revision.");
  if(state.mode!=="cloud"||!state.timeline||state.previewKey!==key||state.timeline.id+":"+state.serverRevision+":"+selectedPreview()?.asset.id!==key)return;
  state.previewUrl=result.preview.url;state.previewUsingProxy=result.preview.usingProxy===true;state.previewWaveformUrl=result.preview.waveformUrl||"";state.previewExpiresAt=Date.now()+Math.max(30,Math.min(300,result.preview.expiresIn||300))*1000;
 }catch(error){
  if(state.previewKey===key)state.previewError=error instanceof Error?error.message:"Private media preview could not be opened.";
 }finally{
  if(state.previewKey===key){state.previewLoading=false;paint();}
 }
}
function timelinePreviewPanel(){
 if(!state.timeline)return '<section class="timeline-preview panel"><div class="eyebrow">SOURCE PREVIEW</div><p class="muted">Load a sequence to preview a source clip.</p></section>';
 const selected=selectedPreview(),track=selected?.track,clip=selected?.clip,asset=selected?.asset;
 const heading='<div class="timeline-panel-heading"><div><div class="eyebrow">SOURCE PREVIEW MONITOR</div><h3>'+(clip?esc(clip.name):'Select a timeline clip')+'</h3></div><small>'+(clip?'Source-range preview':'No clip selected')+'</small></div>';
 if(!track||!clip||!asset)return '<section class="timeline-preview panel">'+heading+'<div class="preview-empty">Select a video, audio or image clip on the timeline.</div></section>';
 const start=clip.sourceRange.start.value/clip.sourceRange.start.rate,end=start+clip.sourceRange.duration.value/clip.sourceRange.duration.rate;
 const mediaUrl=state.mode==="cloud"?state.previewUrl:'/api/assets/'+encodeURIComponent(asset.id)+'/file';
 if(state.mode==="cloud"&&!mediaUrl)return '<section class="timeline-preview panel">'+heading+'<div class="preview-empty">'+(state.previewError?esc(state.previewError)+' <button class="secondary" data-tl-action="preview-refresh">Retry private preview</button>':"Preparing a short-lived private media preview…")+'</div></section>';
 const previewRate=track.kind==="audio"?100:sourceRate(asset,track.kind),isVideoPreview=asset.mediaType.startsWith("video/");
 const media=asset.mediaType.startsWith("video/")?'<video id="tl-preview-media" class="preview-media" controls playsinline preload="metadata" src="'+esc(mediaUrl)+'" data-source-in="'+start+'" data-source-out="'+end+'" data-source-fps="'+previewRate+'"></video>':asset.mediaType.startsWith("audio/")?'<audio id="tl-preview-media" class="preview-audio" controls preload="metadata" src="'+esc(mediaUrl)+'" data-source-in="'+start+'" data-source-out="'+end+'" data-source-fps="'+previewRate+'"></audio>'+(state.previewWaveformUrl?'<img class="timeline-waveform-preview" src="'+esc(state.previewWaveformUrl)+'" alt="Audio waveform for '+esc(asset.name)+'">':'<small class="muted">Generate a waveform from the clip inspector.</small>'):asset.mediaType.startsWith("image/")?'<img class="preview-still" src="'+esc(mediaUrl)+'" alt="'+esc(asset.name)+'">':'<div class="preview-empty">This media type cannot be previewed.</div>';
 const frameButtons=isVideoPreview?'<button class="secondary" data-tl-action="preview-step-back">−1 frame</button><button class="secondary" data-tl-action="preview-step-forward">+1 frame</button>':'';
 const controls=asset.mediaType.startsWith("video/")||asset.mediaType.startsWith("audio/")?'<div class="preview-transport"><button class="secondary" data-tl-action="preview-in">Go to source in</button>'+frameButtons+'<button class="secondary" data-tl-action="preview-out">Go to source out</button><input id="tl-preview-scrub" aria-label="'+(isVideoPreview?"Seek by source frame":"Seek by 10 milliseconds")+'" type="range" min="0" max="'+Math.max(1,Math.ceil((end-start)*previewRate))+'" value="0" step="1"><output id="tl-preview-time">Loading media…</output></div>':'';
 return '<section class="timeline-preview panel">'+heading+'<div class="preview-stage">'+media+'</div>'+controls+'<small class="muted">Private cloud previews use expiring signed media tickets'+(state.previewUsingProxy?' and a validated proxy for responsive playback':'')+'. Playback is limited to this clip’s saved source range. The original source remains attached to the timeline; a verified master render is still required for delivery.</small></section>';
}
function seekPreview(action:string){
 const media=document.querySelector<HTMLMediaElement>("#tl-preview-media");if(!media)return;
 const start=Number(media.dataset.sourceIn),end=Number(media.dataset.sourceOut),rate=Number(media.dataset.sourceFps);
 if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(rate)||rate<=0)return;
 const target=action==="preview-in"?start:action==="preview-out"?end:stepPreviewSeconds(media.currentTime,action==="preview-step-back"?-1:1,rate,start,end);
 media.currentTime=clampPreviewSeconds(target,start,end);
 const output=document.querySelector<HTMLOutputElement>("#tl-preview-time");if(output)output.value=media.currentTime.toFixed(3)+" s";const scrub=document.querySelector<HTMLInputElement>("#tl-preview-scrub");if(scrub){const start=Number(media.dataset.sourceIn),rate=Number(media.dataset.sourceFps);scrub.value=String(Math.max(0,Math.round((media.currentTime-start)*rate)));}
}
function clipInspector(){
 if(!state.timeline||!state.selectedClipId)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its timing, gain or visual properties.</p></div>';
 const track=state.timeline.tracks.find(item=>item.clips.some(clip=>clip.id===state.selectedClipId));
 const clip=track?.clips.find(item=>item.id===state.selectedClipId);
 if(!track||!clip)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its properties.</p></div>';
 const metadata=clip.metadata||{},trace=readCreativeTrace(clip)||{storyBeat:"",purpose:"",audiencePromise:"",proofReference:"",decisionNote:""},decisions=readCreativeDecisionHistory(clip),start=Math.round(clip.timelineStart.value),duration=Math.round(clip.duration.value),sourceIn=Math.round(clip.sourceRange.start.value);
  const isVideoLayer=track.kind==="video"&&state.timeline.tracks.filter(item=>item.kind==="video").findIndex(item=>item.id===track.id)>0;
 const captionDefaults=(()=>{try{return getCaptionStylePreset(track.kind==="caption"?String(metadata.captionPreset||"standard"):"standard");}catch{return getCaptionStylePreset("standard");}})();
 const derivativeAssets=state.assets.filter(item=>item.derivativeOf===clip.assetId);
 const eligibleDerivatives=derivativeAssets.filter(item=>assessDerivativeEligibility(item,clip.assetId,state.assets.find(source=>source.id===clip.assetId)?.mediaType).eligible);
 const derivativePanel=derivativeAssets.length?'<div class="derivative-replacement"><div class="eyebrow">APPROVED ENHANCEMENTS</div><p class="muted">Replace only this clip’s media reference. The original asset remains in the library; timing, trims, track and creative intent are preserved.</p><label>Verified derivative</label><select name="replacementAssetId"><option value="">Choose an approved derivative</option>'+eligibleDerivatives.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join("")+'</select><button class="secondary" name="replaceDerivative" value="1" type="submit" '+(eligibleDerivatives.length?"":"disabled")+'>Replace clip with approved derivative</button>'+derivativeAssets.filter(item=>!assessDerivativeEligibility(item,clip.assetId,state.assets.find(source=>source.id===clip.assetId)?.mediaType).eligible).map(item=>'<small class="muted">'+esc(item.name)+' — not selectable: '+esc(assessDerivativeEligibility(item,clip.assetId,state.assets.find(source=>source.id===clip.assetId)?.mediaType).reason)+'</small>').join("")+'</div>':"";

 const comparison=state.derivativeComparison?.sourceId===clip.assetId&&state.derivativeComparison.expiresAt>Date.now()?state.derivativeComparison:null;
 const comparisonPreview=(url:string,type:string,label:string)=>type.startsWith("image/")?'<img src="'+esc(url)+'" alt="'+esc(label)+' comparison" loading="lazy">':type.startsWith("video/")?'<video src="'+esc(url)+'" controls playsinline preload="metadata"></video>':type.startsWith("audio/")?'<audio src="'+esc(url)+'" controls preload="metadata"></audio>':'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">Open private preview</a>';
 const comparisonPanel=derivativeAssets.length?'<div class="derivative-comparison"><div class="eyebrow">SOURCE ↔ ENHANCED COMPARISON</div><p class="muted">Inspect both private previews before replacing the clip. Comparison does not change the timeline.</p><label>Derivative to compare</label><select id="tl-compare-derivative"><option value="">Choose a derivative</option>'+derivativeAssets.map(item=>'<option value="'+esc(item.id)+'" '+(comparison?.derivativeId===item.id?"selected":"")+'>'+esc(item.name)+'</option>').join("")+'</select><button type="button" class="secondary" data-tl-action="compare-derivative" '+(state.derivativeComparisonLoading?"disabled":"")+'>'+(state.derivativeComparisonLoading?"Preparing comparison…":"Compare source and derivative")+'</button>'+(state.derivativeComparisonError?'<small class="lineage-error">'+esc(state.derivativeComparisonError)+'</small>':"")+(comparison?'<div class="derivative-comparison-grid"><div><b>Original · '+esc(comparison.sourceName)+'</b>'+comparisonPreview(comparison.sourceUrl,comparison.sourceType,comparison.sourceName)+'</div><div><b>Derivative · '+esc(comparison.derivativeName)+'</b>'+comparisonPreview(comparison.derivativeUrl,comparison.derivativeType,comparison.derivativeName)+'</div></div><small class="muted">Private signed links expire in approximately five minutes. Files and timeline remain unchanged.</small>':"")+'</div>':"";
 let specific="";
 if(track.kind==="video"||track.kind==="audio")specific='<div><label>Fade in (seconds)</label><input name="fadeInSeconds" type="number" min="0" max="30" step="0.05" value="'+esc(metadata.fadeInSeconds??0)+'"></div><div><label>Fade out (seconds)</label><input name="fadeOutSeconds" type="number" min="0" max="30" step="0.05" value="'+esc(metadata.fadeOutSeconds??0)+'"></div>';
  if(track.kind==="audio")specific+='<div class="full"><button type="button" class="secondary" data-tl-action="generate-waveform" '+(state.mode==="cloud"&&state.cloudProjectId?"":"disabled")+'>Generate / refresh waveform</button><small class="muted">Creates a private, checksummed PNG derivative. Original audio is not modified.</small></div>';
  if(track.kind==="audio")specific+='<div><label>Gain (dB)</label><input name="gainDb" type="number" min="-60" max="24" step="0.5" value="'+esc(clip.gainDb??0)+'"></div><div><label>Audio role</label><select name="audioRole"><option value="other" '+(metadata.audioRole!=="voice"&&metadata.audioRole!=="music"?'selected':'')+'>Other</option><option value="voice" '+(metadata.audioRole==="voice"?'selected':'')+'>Voice / dialogue</option><option value="music" '+(metadata.audioRole==="music"?'selected':'')+'>Background music</option></select></div><div class="full"><label><input type="checkbox" name="duckingEnabled" '+(metadata.duckingEnabled===true?'checked':'')+'> Automatically lower this music under voice clips</label></div><div><label>Ducking threshold (dB)</label><input name="duckingThresholdDb" type="number" min="-60" max="-6" value="'+esc(metadata.duckingThresholdDb??-24)+'"></div><div><label>Ducking ratio</label><input name="duckingRatio" type="number" min="1" max="20" step="0.5" value="'+esc(metadata.duckingRatio??8)+'"></div>';
 if(track.kind==="overlay"||isVideoLayer)specific='<div><label>X position</label><input name="x" type="number" min="0" value="'+esc(metadata.x??(isVideoLayer?0:Math.max(0,(state.timeline.width||1920)-Math.round((state.timeline.width||1920)*0.24)-24)))+'"></div><div><label>Y position</label><input name="y" type="number" min="0" value="'+esc(metadata.y??(isVideoLayer?0:24))+'"></div><div><label>Width (px)</label><input name="width" type="number" min="16" value="'+esc(metadata.width??(isVideoLayer?(state.timeline.width||1920):Math.round((state.timeline.width||1920)*0.24)))+'"></div><div><label>Height (px)</label><input name="height" type="number" min="16" value="'+esc(metadata.height??(isVideoLayer?(state.timeline.height||1080):Math.round((state.timeline.height||1080)*0.24)))+'"></div><div><label>Opacity</label><input name="opacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.opacity??1)+'"></div>';
  if(track.kind==="overlay"||isVideoLayer)specific+='<div class="full"><label>Motion keyframes · JSON</label><textarea name="motionKeyframes" rows="5" spellcheck="false" placeholder=\'[{"frame":0,"x":40,"y":40,"scale":1},{"frame":48,"x":500,"y":180,"scale":1.25}]\'>'+esc(JSON.stringify(metadata.motionKeyframes||[],null,2))+'</textarea><small class="muted">Frames are relative to this clip. Each keyframe sets frame, X, Y and scale (0.1–4). Up to 50 unique keyframes; motion is interpolated between them.</small></div>';
 if(track.kind==="caption")specific='<div class="full"><label>Caption style preset</label><select id="tl-caption-preset" name="captionPreset">'+listCaptionStylePresets().map(preset=>'<option value="'+esc(preset.id)+'" '+(String(metadata.captionPreset||"standard")===preset.id?'selected':'')+'>'+esc(preset.label)+'</option>').join("")+'</select></div><div><label>Font family</label><input name="fontName" value="'+esc(metadata.fontName??captionDefaults.fontName)+'"></div><div><label>Font size</label><input name="fontSize" type="number" min="12" max="96" value="'+esc(metadata.fontSize??captionDefaults.fontSize)+'"></div><div><label>Text color</label><input name="primaryColor" type="color" value="'+esc(metadata.primaryColor??captionDefaults.primaryColor)+'"></div><div><label>Caption placement</label><select name="alignment">'+[1,2,3,4,5,6,7,8,9].map(n=>'<option value="'+n+'" '+(Number(metadata.alignment??2)===n?'selected':'')+'>'+n+'</option>').join("")+'</select></div><div><label>Background panel</label><select name="backgroundMode"><option value="box" '+(metadata.backgroundMode!=="none"?'selected':'')+'>Behind captions</option><option value="none" '+(metadata.backgroundMode==="none"?'selected':'')+'>No panel</option></select></div><div><label>Panel color</label><input name="backgroundColor" type="color" value="'+esc(metadata.backgroundColor??"#000000")+'"></div><div><label>Panel opacity</label><input name="backgroundOpacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.backgroundOpacity??0.68)+'"></div><div><label>Outline</label><input name="outline" type="number" min="0" max="8" step="0.5" value="'+esc(metadata.outline??2)+'"></div><div><label>Shadow</label><input name="shadow" type="number" min="0" max="8" step="0.5" value="'+esc(metadata.shadow??1)+'"></div><div><label>Bottom safe-area margin</label><input name="marginV" type="number" min="0" max="240" value="'+esc(metadata.marginV??42)+'"></div>';
 return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR · '+esc(track.kind.toUpperCase())+'</div><form id="tl-clip-inspector" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'"><div class="form-grid"><div><label>Clip name</label><input name="name" value="'+esc(clip.name)+'" required></div><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+start+'"></div><div><label>Duration (frames)</label><input name="duration" type="number" min="1" value="'+duration+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="'+sourceIn+'"></div>'+specific+'</div>'+derivativePanel+''+comparisonPanel+'<div class="eyebrow" style="margin-top:16px">CREATIVE INTENT LINK</div><div class="form-grid"><div><label>Story beat</label><input name="storyBeat" maxlength="120" value="'+esc(trace.storyBeat)+'" placeholder="Opening hook / Proof / Payoff"></div><div><label>Audience promise served</label><input name="audiencePromise" maxlength="300" value="'+esc(trace.audiencePromise)+'" placeholder="What did we promise viewers?"></div><div class="full"><label>Why this shot exists</label><textarea name="purpose" maxlength="500" rows="2" placeholder="What information, emotion or transition does it contribute?">'+esc(trace.purpose)+'</textarea></div><div><label>Proof / source reference</label><input name="proofReference" maxlength="300" value="'+esc(trace.proofReference)+'" placeholder="Evidence ID, source or approved claim"></div><div><label>Creative decision note</label><input name="decisionNote" maxlength="500" value="'+esc(trace.decisionNote)+'" placeholder="Why this take, framing or edit was chosen"></div></div>'+(decisions.length?'<div class="eyebrow" style="margin-top:16px">CREATIVE DECISION HISTORY · '+decisions.length+'</div><div class="timeline-quality-list">'+decisions.slice().reverse().slice(0,8).map(item=>'<article class="timeline-quality-item info"><b>r'+item.sequence+' · '+esc(item.summary)+'</b><p>'+esc(item.recordedAt)+'</p></article>').join("")+'</div>':'')+'<button class="secondary">Save clip properties and intent</button></form></div>';
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
function mediaQualityPanel(){
 const report=state.mediaQualityReport;
 if(!report)return "";
 const status=report.status==="passed"?"completed":report.status==="review"?"running":"failed";
 const findings=report.findings||[];
 const signal=report.signalAnalysis;
 return '<section class="panel timeline-quality"><div class="timeline-panel-heading"><div><div class="eyebrow">RENDERED MEDIA QUALITY</div><h3>Decoded-frame analysis</h3></div><span class="job-status '+status+'">'+esc(report.status.toUpperCase())+'</span></div>'+
 '<div class="creative-plan-meta"><span>'+(report.counts?.errors||0)+' errors</span><span>'+(report.counts?.warnings||0)+' warnings</span><span>'+(signal?.lumaSampleCount||0)+' frame samples</span></div>'+
 (signal?'<p class="muted">Luminance scan: '+Number(signal.lumaCoverageSeconds||0).toFixed(1)+' seconds covered · '+(signal.lumaAnalysisTruncated?'partial scan':'reported scan complete')+'</p>':'')+
 (signal?.unavailable?.length?'<p class="muted">Unavailable checks: '+signal.unavailable.map(item=>esc(item.check)+' ('+esc(item.reason)+')').join(' · ')+'</p>':'')+
 (findings.length?'<div class="timeline-quality-list">'+findings.map(item=>'<article class="timeline-quality-item '+(item.severity==="error"?"warning":"info")+'"><b>'+esc(item.code.replaceAll("_"," ").toLowerCase())+'</b><p>'+esc(item.message)+'</p>'+(Number.isFinite(item.startSeconds)?'<small>'+Number(item.startSeconds).toFixed(2)+'s'+(Number.isFinite(item.endSeconds)?' – '+Number(item.endSeconds).toFixed(2)+'s':'')+'</small>':'')+'</article>').join("")+'</div>':'<p class="muted">No temporal luminance warnings were recorded in the analysed interval. This is not a full perceptual-quality certification.</p>')+
 '<small class="muted">Analysis samples a downscaled stream at 12 fps for up to 120 seconds. It does not certify high-frequency flicker, colour accuracy, sharpness or subjective visual quality.</small></section>';
}
function deliveryReviewPanel(){
 const review=state.deliveryReview;
 if(!review)return '<section class="panel timeline-quality"><div class="eyebrow">DELIVERY REVIEW</div><h3>Export validation</h3><p class="muted">Render a cloud master with a delivery profile to see its validation report and output evidence here.</p></section>';
 const status=review.status==="passed"?"completed":review.status==="review"?"running":"failed";
 const findings=review.findings||[];
 return '<section class="panel timeline-quality"><div class="timeline-panel-heading"><div><div class="eyebrow">DELIVERY REVIEW</div><h3>'+esc(review.profileLabel||"Export validation")+'</h3></div><span class="job-status '+status+'">'+esc(review.status.toUpperCase())+'</span></div>'+
 '<div class="creative-plan-meta"><span>'+(review.counts?.errors||0)+' errors</span><span>'+(review.counts?.warnings||0)+' warnings</span></div>'+
 (findings.length?'<div class="timeline-quality-list">'+findings.map(item=>'<article class="timeline-quality-item '+(item.severity==="error"?"warning":"info")+'"><b>'+esc(item.code.replaceAll("_"," ").toLowerCase())+'</b><p>'+esc(item.message)+'</p></article>').join("")+'</div>':'<p class="muted">No profile validation findings were recorded.</p>')+
 (review.outputAsset?'<p class="muted">Output asset: '+esc(review.outputAsset.name||review.outputAsset.id)+' · '+esc(review.outputAsset.id)+'</p>':'')+
 (review.sha256?'<p class="muted">SHA-256: <code>'+esc(review.sha256)+'</code></p>':'')+
 (review.byteSize?'<p class="muted">File size: '+(review.byteSize/1024/1024).toFixed(2)+' MB</p>':'')+
 (review.deliveryManifest?'<p class="muted">Delivery receipt fingerprint: <code>'+esc(review.deliveryManifest.fingerprint)+'</code></p>':'')+(state.mode==="cloud"&&state.cloudRenderJobId&&review.deliveryManifest?'<div class="delivery-package-actions"><button data-tl-action="delivery-package" '+(state.deliveryApprovalBusy?'disabled':'')+'>Build verified delivery package</button><small class="muted">Creates a fingerprinted JSON handoff with the render evidence and a five-minute private master download link.</small>'+(state.deliveryPackageLink&&state.deliveryPackageLink.expiresAt>Date.now()?'<a class="button secondary" href="'+esc(state.deliveryPackageLink.url)+'" target="_blank" rel="noopener noreferrer">Download verified master · expires in 5 min</a>':'')+'</div>':'')+
 (state.mode==="cloud"&&state.cloudRenderJobId&&review.deliveryManifest?'<div class="delivery-approval"><div class="eyebrow">INDEPENDENT DELIVERY SIGN-OFF</div>'+(state.deliveryApproval?'<p><b>'+esc(state.deliveryApproval.decision.replaceAll("_"," ").toUpperCase())+'</b> · reviewer '+esc(state.deliveryApproval.reviewerId)+'</p><p class="muted">'+esc(state.deliveryApproval.note||"No review note")+'</p>':'<p class="muted">No independent review decision has been recorded for this exact delivery fingerprint.</p>')+(state.mediaQualityReport?.status==="review"&&Number(state.mediaQualityReport.counts?.warnings)>0?'<p class="muted"><b>Quality acknowledgement required:</b> this render contains '+Number(state.mediaQualityReport.counts?.warnings)+' media-quality warning(s). An approval must include a note that acknowledges the flagged findings.</p>':'')+'<label for="tl-delivery-review-note">Review note</label><textarea id="tl-delivery-review-note" maxlength="2000" rows="2" placeholder="Record visual/audio review observations; acknowledge any quality warnings before approval"></textarea><div class="button-row"><button class="secondary" data-tl-action="delivery-review-refresh" '+(state.deliveryApprovalBusy?'disabled':'')+'>Refresh review</button><button class="secondary" data-tl-action="delivery-review-changes" '+(state.deliveryApprovalBusy?'disabled':'')+'>Request changes</button><button class="secondary" data-tl-action="delivery-review-reject" '+(state.deliveryApprovalBusy?'disabled':'')+'>Reject</button><button data-tl-action="delivery-review-approve" '+(state.deliveryApprovalBusy?'disabled':'')+'>Approve delivery</button></div>'+(state.deliveryApprovalHistory.length?'<div class="timeline-quality-list">'+state.deliveryApprovalHistory.map(item=>'<article class="timeline-quality-item info"><b>'+esc(item.decision.toUpperCase())+' · '+esc(item.reviewerId)+'</b><p>'+esc(item.note||"No note")+'</p><small>'+esc(item.reviewedAt)+'</small></article>').join("")+'</div>':'')+'<small class="muted">Approval requires a different authorized project reviewer. Each decision is tied to the immutable delivery fingerprint; it does not certify creative quality or recipient acceptance.</small></div>':'')+
 '<small class="muted">Metadata/profile validation is not a substitute for human visual review, true-peak certification or recipient acceptance.</small></section>';
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
  derivative_integrity:{status:findings.some(item=>item.code.startsWith("DERIVATIVE_")&&item.severity==="error")?"blocked":findings.some(item=>item.code.startsWith("DERIVATIVE_")&&item.severity==="warning")?"review":"passed",summary:findings.some(item=>item.code.startsWith("DERIVATIVE_"))?"Derivative provenance, parent checksums, output integrity and independent review have findings that must be resolved or reviewed.": "No derivative integrity issues were detected in the current sequence.",findings:findings.filter(item=>item.code.startsWith("DERIVATIVE_")).map(item=>({code:item.code,detail:item.detail}))},
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
export function renderTimelineWorkspace(){
 return '<div id="timeline-workspace"><div class="timeline-toolbar"><label>Workspace <select id="tl-mode"><option value="local" '+(state.mode==="local"?"selected":"")+' >Local</option><option value="cloud" '+(state.mode==="cloud"?"selected":"")+' >Cloud project</option></select></label><label>Cloud project <select id="tl-cloud-project"><option value="">Select project</option>'+state.cloudProjects.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===state.cloudProjectId?'selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></label><label>Saved sequence <select id="tl-saved-sequence"><option value="">Current sequence</option>'+(state.mode==="cloud"?state.cloudTimelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""):state.timelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""))+'</select></label>'+(state.mode==="cloud"&&state.timeline?'<label>Export profile <select id="tl-delivery-profile"><option value="">Custom sequence settings</option><option value="social-vertical" '+(state.timeline.deliveryProfileId==="social-vertical"?"selected":"")+'>Social vertical · 1080×1920</option><option value="youtube-1080p" '+(state.timeline.deliveryProfileId==="youtube-1080p"?"selected":"")+'>YouTube · 1080p</option><option value="youtube-4k" '+(state.timeline.deliveryProfileId==="youtube-4k"?"selected":"")+'>YouTube · 4K</option><option value="broadcast-1080p25" '+(state.timeline.deliveryProfileId==="broadcast-1080p25"?"selected":"")+'>Broadcast review · 1080p25</option><option value="instagram-square" '+(state.timeline.deliveryProfileId==="instagram-square"?"selected":"")+'>Instagram square · 1080×1080</option><option value="social-landscape" '+(state.timeline.deliveryProfileId==="social-landscape"?"selected":"")+'>Social landscape · 1080p</option><option value="youtube-1440p" '+(state.timeline.deliveryProfileId==="youtube-1440p"?"selected":"")+'>YouTube · 1440p</option><option value="web-720p" '+(state.timeline.deliveryProfileId==="web-720p"?"selected":"")+'>Web lightweight · 720p</option></select></label>':'')+'<label>New sequence template <select id="tl-timeline-template">'+listTimelineTemplates().map(template=>'<option value="'+esc(template.id)+'">'+esc(template.label)+'</option>').join("")+'</select></label><button class="secondary" data-tl-create-cloud>＋ New cloud timeline</button><button class="secondary" data-tl-action="undo" '+(state.history.undo.length&&!state.historyBusy?"":"disabled")+ '>↶ Undo</button><button class="secondary" data-tl-action="redo" '+(state.history.redo.length&&!state.historyBusy?"":"disabled")+ '>↷ Redo</button><button class="secondary" data-tl-action="duplicate-variant">Duplicate as variant</button><span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="ready"?"TIMELINE SAVED":state.status==="auth"?"SIGN IN REQUIRED":state.status==="offline"?"API OFFLINE":"LOADING")+'</span><button class="secondary" data-tl-action="refresh">↻ Refresh</button><button class="secondary" data-tl-action="export">Export OTIO JSON</button>'+(state.mode==="cloud"&&state.cloudRenderJobId?'<button class="secondary" data-tl-action="cloud-job">Check cloud render · '+esc(state.cloudRenderJobStatus||"queued")+'</button>':'')+''+(state.ffmpeg?'<button class="primary" data-tl-action="render">Render master MP4</button>':'<span class="muted">FFmpeg required for master render</span>')+'</div>'+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+
 '<div class="timeline-editor-grid"><section class="panel"><div class="eyebrow">SEQUENCE SETTINGS</div><h3>'+(state.timeline?esc(state.timeline.name):"No sequence loaded")+'</h3>'+
 '<form id="tl-add-track"><label>Track name</label><input name="name" required placeholder="Video 2 / Music / Captions"><label>Track type</label><select name="kind"><option value="video">Video</option><option value="audio">Audio</option><option value="overlay">Overlay</option><option value="caption">Captions</option></select><button class="secondary">＋ Add track</button></form>'+
 '<div class="eyebrow" style="margin-top:18px">ADD SOURCE CLIP</div><form id="tl-add-clip"><label>Source asset</label><select id="tl-asset-select" name="assetId" required>'+assetOptions()+'</select><label>Destination track</label><select name="trackId">'+(state.timeline?.tracks.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join("")||"")+'</select><div class="form-grid"><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+maxEnd()+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="0"></div><div><label>Duration (timeline frames)</label><input name="duration" type="number" min="1" value="'+(fps()*5)+'"></div></div><button class="primary wide">＋ Place clip on timeline</button><button class="secondary wide" type="submit" name="generatedHandoff" value="1" '+(state.mode==="cloud"?"":"disabled title=\"Choose Cloud project mode to use verified generated-media handoff\"")+'>Send verified generated media to timeline</button><small class="muted">Generated-media handoff requires server-verified media metadata and a completed generation job. Ordinary imports continue through the standard clip workflow.</small></form>'+
 '<form id="tl-add-marker"><div class="eyebrow" style="margin-top:18px">REVIEW MARKER</div><label>Marker title</label><input name="name" required placeholder="Hook / transition / review note"><label>Position (frames)</label><input name="frame" type="number" min="0" value="0"><label>Review note</label><textarea name="note" maxlength="500" rows="2" placeholder="What should the reviewer inspect at this point?"></textarea><label>Marker color</label><select name="color"><option value="YELLOW">Yellow · review</option><option value="RED">Red · issue</option><option value="GREEN">Green · approved</option><option value="BLUE">Blue · reference</option></select><button class="secondary">＋ Add marker</button></form></section>'+
 '<section class="panel"><div class="timeline-panel-heading"><div><div class="eyebrow">MULTI-TRACK EDITOR</div><h3>Sequence timeline</h3></div><small>'+(state.timeline?.frameRate.numerator+"/"+state.timeline?.frameRate.denominator+" fps")+'</small></div>'+
 timelinePreviewPanel()+(state.timeline?timelineCanvas():'<div class="empty">Sign in and create a sequence to begin.</div>')+
 clipInspector()+variantComparisonPanel()+creativeTraceabilityPanel()+mediaQualityPanel()+deliveryReviewPanel()+timelineQualityPanel()+
  '<div class="timeline-marker-list">'+(state.timeline?.markers.map(m=>'<article><b>◆ '+esc(m.name)+'</b> · '+Math.round(m.start.value)+'f'+(m.note?'<p>'+esc(m.note)+'</p>':'')+'</article>').join("")||"No review markers yet.")+'</div></section></div>'+
 '<div class="notice">Master rendering supports synchronized audio, image overlays and captions. The preview monitor plays selected local source clips within saved source trims; cloud preview awaits authenticated private-media playback support. Transitions and effects remain future milestones.</div></div>';
}
async function refresh(){
 if(state.mode==="cloud"){
  const projects=await apiRequest<{projects:CloudProject[]}>("/api/cloud/projects");
  state.cloudProjects=projects.projects||[];
  if(!state.cloudProjectId||!state.cloudProjects.some(p=>p.id===state.cloudProjectId))state.cloudProjectId=state.cloudProjects[0]?.id||"";
  if(!state.cloudProjectId){state.assets=[];state.cloudTimelines=[];state.timeline=null;state.message="Create a cloud project first, then select it here.";state.status="ready";return;}
  const query="?projectId="+encodeURIComponent(state.cloudProjectId);
  const [assets,timelines]=await Promise.all([
   apiRequest<{assets:Asset[]}>("/api/cloud/assets"+query),
   apiRequest<{timelines:CloudSavedTimeline[]}>("/api/cloud/timelines"+query)
  ]);
  state.assets=assets.assets||[];state.cloudTimelines=timelines.timelines||[];state.timelines=[];
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
 const templateId=document.querySelector<HTMLSelectElement>("#tl-timeline-template")?.value||"social-short";
 const template=listTimelineTemplates().find(item=>item.id===templateId);
 if(!template)throw new Error("Choose a valid editorial template.");
 let timeline=createTimeline(state.cloudProjectId,crypto.randomUUID(),template.label,{numerator:template.fps,denominator:1});
 timeline=applyTimelineTemplate(timeline,templateId);
 const result=await apiRequest<{timeline:CloudSavedTimeline}>("/api/cloud/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:state.cloudProjectId,name:timeline.name,timeline,otio:toOpenTimelineIo(timeline)})});
 state.timeline=result.timeline.timeline;state.serverRevision=result.timeline.revision;state.selectedTrack=timeline.tracks[0].id;state.message="Cloud timeline created.";state.status="ready";await refresh();paint();
}
export async function initTimelineWorkspace(){
 try{await refresh();}catch(error){state.status=error instanceof Error&&error.message.includes("Sign in")?"auth":"offline";state.message=error instanceof Error?error.message:"Timeline service unavailable.";}
 paint();
}
function paint(){
 const root=document.querySelector<HTMLElement>("#timeline-workspace");if(root)root.outerHTML=renderTimelineWorkspace();
 if(state.mode==="cloud"&&state.timeline&&selectedPreview()&&(!state.previewUrl||state.previewExpiresAt<=Date.now()+15000)&&!state.previewLoading&&!state.previewError)void ensureCloudPreviewTicket();
 const media=document.querySelector<HTMLMediaElement>("#tl-preview-media");
 if(media){
  const setIn=()=>{const start=Number(media.dataset.sourceIn),duration=media.duration,end=Number(media.dataset.sourceOut);if(Number.isFinite(start)){const safeStart=Math.min(start,Number.isFinite(duration)?duration:start);media.currentTime=safeStart;}if(Number.isFinite(end)&&Number.isFinite(duration)&&end>duration)media.dataset.sourceOut=String(duration);};
  if(media.readyState>=1)setIn();else media.addEventListener("loadedmetadata",setIn,{once:true});
  media.addEventListener("error",()=>{if(state.mode==="cloud"){state.previewKey="";state.previewUrl="";state.previewExpiresAt=0;state.previewError="Private preview expired or could not be loaded. Select the clip again to request a fresh ticket.";}});media.addEventListener("timeupdate",()=>{const output=document.querySelector<HTMLOutputElement>("#tl-preview-time");if(output)output.value=media.currentTime.toFixed(3)+" s";const start=Number(media.dataset.sourceIn),end=Math.min(Number(media.dataset.sourceOut),Number.isFinite(media.duration)?media.duration:Number(media.dataset.sourceOut)),rate=Number(media.dataset.sourceFps),scrub=document.querySelector<HTMLInputElement>("#tl-preview-scrub");if(scrub&&Number.isFinite(rate)&&rate>0)scrub.value=String(Math.max(0,Math.round((media.currentTime-start)*rate)));if(Number.isFinite(end)&&media.currentTime>=end){media.pause();media.currentTime=end;}});
 }
}
async function runAction(action:HTMLElement){
 const type=action.dataset.tlAction||"";

 if(type==="compare-derivative"){
  const selected=selectedPreview(),select=document.querySelector<HTMLSelectElement>("#tl-compare-derivative"),derivativeId=select?.value||"";
  if(state.mode!=="cloud"||!selected||!derivativeId){state.derivativeComparisonError=state.mode!=="cloud"?"Private side-by-side comparison is available for saved cloud projects.":"Choose a derivative to compare.";paint();return;}
  const derivative=state.assets.find(item=>item.id===derivativeId);
  if(!derivative||derivative.derivativeOf!==selected.asset.id){state.derivativeComparisonError="The selected derivative is not linked to this clip's current source.";paint();return;}
  state.derivativeComparisonLoading=true;state.derivativeComparisonError="";state.derivativeComparison=null;paint();
  const sourceId=selected.asset.id;
  try{
   const [sourceLink,derivativeLink]=await Promise.all([
    apiRequest<{url:string}>("/api/cloud/assets/"+encodeURIComponent(sourceId)),
    apiRequest<{url:string}>("/api/cloud/assets/"+encodeURIComponent(derivative.id))
   ]);
   const sourceUrl=new URL(sourceLink.url),derivativeUrl=new URL(derivativeLink.url);
   if(sourceUrl.protocol!=="https:"||derivativeUrl.protocol!=="https:")throw new Error("Private preview links must use HTTPS.");
   if(state.mode!=="cloud"||selectedPreview()?.asset.id!==sourceId)throw new Error("Selection changed while comparison previews were loading.");
   state.derivativeComparison={sourceId,derivativeId:derivative.id,sourceUrl:sourceLink.url,derivativeUrl:derivativeLink.url,sourceName:selected.asset.name,derivativeName:derivative.name,sourceType:selected.asset.mediaType,derivativeType:derivative.mediaType,expiresAt:Date.now()+300000};
  }catch(error){state.derivativeComparisonError=error instanceof Error?error.message:"Unable to create private comparison previews.";}
  finally{state.derivativeComparisonLoading=false;paint();}
  return;
 }
 if(type==="refresh"){state.previewKey="";state.previewUrl="";state.previewWaveformUrl="";state.previewExpiresAt=0;await refresh();paint();return;}
 if(type==="undo"||type==="redo"){
  if(!state.timeline||state.historyBusy)return;
  const result=type==="undo"?undoTimeline(state.history,state.timeline):redoTimeline(state.history,state.timeline);
  if(!result.timeline){state.message=type==="undo"?"Nothing to undo.":"Nothing to redo.";paint();return;}
  const previousTimeline=state.timeline,previousHistory=state.history;
  state.historyBusy=true;state.history=result.history;state.timeline=result.timeline;
  state.message=type==="undo"?"Undoing last edit…":"Restoring next edit…";paint();
  try{await persist();}catch(error){state.timeline=previousTimeline;state.history=previousHistory;state.message=error instanceof Error?error.message:"History change could not be saved.";state.status="offline";}
  finally{state.historyBusy=false;}paint();return;
 }
 if(type==="cloud-job"&&state.cloudRenderJobId){try{const result=await apiRequest<{job:{id:string;status:string;progress?:number;output?:{outputAsset?:{id:string;name?:string};deliveryReport?:{profileLabel?:string;status:string;counts?:{errors:number;warnings:number};findings?:Array<{code:string;severity:string;message:string}>};sha256?:string;byteSize?:number;deliveryManifest?:{schemaVersion:number;fingerprint:string;timelineId:string;timelineRevision:string|number;outputAsset:string;sha256:string;byteSize:number;mediaType:string;profileId:string|null};qualityReport?:{status:string;counts?:{errors:number;warnings:number};findings?:Array<{code:string;severity:string;message:string;startSeconds?:number;endSeconds?:number}>;signalAnalysis?:{lumaSampleCount:number;lumaCoverageSeconds:number;lumaAnalysisTruncated:boolean;unavailable?:Array<{check:string;reason:string}>}}}}}>("/api/cloud/jobs/"+state.cloudRenderJobId);state.cloudRenderJobStatus=result.job.status;if(result.job.output?.qualityReport)state.mediaQualityReport=result.job.output.qualityReport;if(result.job.output?.deliveryReport)state.deliveryReview={...result.job.output.deliveryReport,outputAsset:result.job.output.outputAsset,sha256:result.job.output.sha256,byteSize:result.job.output.byteSize,deliveryManifest:result.job.output.deliveryManifest};if(result.job.status==="succeeded"&&result.job.output?.deliveryManifest){const review=await apiRequest<{approval:{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}|null;approvalHistory:Array<{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}>}>("/api/cloud/jobs/"+state.cloudRenderJobId+"/delivery-approval");state.deliveryApproval=review.approval;state.deliveryApprovalHistory=review.approvalHistory||[];}state.message="Cloud render "+result.job.status+" · "+Number(result.job.progress||0)+"%"+(result.job.output?.outputAsset?.id?" · output asset "+result.job.output.outputAsset.id:"");if(result.job.status==="succeeded")await refresh();}catch(error){state.message=error instanceof Error?error.message:"Could not refresh cloud render status.";}paint();return;}
 if(type==="render"){
  if(!state.timeline||!state.ffmpeg){state.message="FFmpeg is required to render a master file.";paint();return;}
  const preflight=assessTimelineRenderPreflight(state.timeline,state.assets);
  if(!preflight.ready){state.message="Render blocked by "+preflight.blockers.length+" timeline integrity error(s): "+preflight.blockers.slice(0,3).map(item=>item.title).join("; ")+". Resolve these errors before rendering.";paint();return;}
  const preflightWarningNote=preflight.warnings.length?" Preflight recorded "+preflight.warnings.length+" warning(s); review the Production readiness panel before delivery.":"";
  try{
   await persist();
   if(state.mode==="cloud"){const queued=await apiRequest<{job:{id:string;status:string}}>("/api/cloud/timelines/"+state.timeline.id+"/render",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({})});state.cloudRenderJobId=queued.job.id;state.cloudRenderJobStatus=queued.job.status;state.deliveryReview=null;state.mediaQualityReport=null;state.deliveryApproval=null;state.deliveryApprovalHistory=[];state.deliveryPackageLink=null;}else await apiRequest("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType:"timeline.render",timelineId:state.timeline.id,projectId:state.timeline.projectId||undefined})});
   state.message=(state.mode==="cloud"?"Cloud master render queued. Check Cloud Projects for durable job status.":"Master render queued. Check Production Operations for progress and the finished MP4.")+preflightWarningNote;
   window.dispatchEvent(new Event("ev:jobs-updated"));
  }catch(error){state.message=error instanceof Error?error.message:"Render could not be queued.";}
  paint();return;
 }
 if(type==="delivery-package"&&state.cloudRenderJobId){
  try{
   action.setAttribute("disabled","true");state.message="Verifying delivery evidence and preparing package…";paint();
   const result=await apiRequest<{deliveryPackage:{packageFingerprint:string;jobId:string;master:{filename:string;downloadUrl:string};[key:string]:unknown}}>("/api/cloud/jobs/"+state.cloudRenderJobId+"/delivery-package");
   const parsed=new URL(result.deliveryPackage.master.downloadUrl);
   if(parsed.protocol!=="https:"||!result.deliveryPackage.packageFingerprint)throw new Error("The delivery package returned invalid evidence or an unsafe master link.");
   const blob=new Blob([JSON.stringify(result.deliveryPackage,null,2)],{type:"application/json"});
   const url=URL.createObjectURL(blob),download=document.createElement("a");download.href=url;download.download="executive-visuals-delivery-"+result.deliveryPackage.jobId+".json";document.body.appendChild(download);download.click();download.remove();URL.revokeObjectURL(url);
   state.deliveryPackageLink={url:parsed.href,filename:result.deliveryPackage.master.filename,expiresAt:Date.now()+300000};
   state.message="Verified delivery package downloaded. Use the master-download link in this panel before it expires in five minutes.";
  }catch(error){state.message=error instanceof Error?error.message:"Could not build the delivery package.";}
  finally{action.removeAttribute("disabled");paint();}
  return;
 }
 if(type.startsWith("delivery-review-")&&state.cloudRenderJobId){
  if(type==="delivery-review-refresh"){try{state.deliveryApprovalBusy=true;paint();const result=await apiRequest<{approval:{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}|null;approvalHistory:Array<{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}>}>("/api/cloud/jobs/"+state.cloudRenderJobId+"/delivery-approval");state.deliveryApproval=result.approval;state.deliveryApprovalHistory=result.approvalHistory||[];state.message="Delivery review history refreshed.";}catch(error){state.message=error instanceof Error?error.message:"Could not load delivery review history.";}finally{state.deliveryApprovalBusy=false;}paint();return;}
  const decision=type==="delivery-review-approve"?"approved":type==="delivery-review-reject"?"rejected":"changes_requested";
  try{state.deliveryApprovalBusy=true;paint();const note=(document.querySelector<HTMLTextAreaElement>("#tl-delivery-review-note")?.value||"").trim();const result=await apiRequest<{approval:{decision:string;reviewerId:string;note:string;fingerprint:string;reviewedAt:string}}>("/api/cloud/jobs/"+state.cloudRenderJobId+"/delivery-approval",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({decision,note})});state.deliveryApproval=result.approval;state.deliveryApprovalHistory=[...state.deliveryApprovalHistory,result.approval];state.message="Delivery review recorded: "+decision.replaceAll("_"," ")+ ".";}catch(error){state.message=error instanceof Error?error.message:"Delivery review could not be recorded.";}finally{state.deliveryApprovalBusy=false;}paint();return;
 }
 if(type==="generate-waveform"){
  const selected=selectedPreview();
  if(state.mode!=="cloud"||!state.cloudProjectId||!selected||selected.track.kind!=="audio"){state.message="Select an audio clip in a cloud project to generate its waveform.";paint();return;}
  try{
   action.setAttribute("disabled","true");state.message="Queueing private audio waveform generation…";paint();
   const result=await apiRequest<{job:{id:string;status:string}}>("/api/cloud/waveforms",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({projectId:state.cloudProjectId,sourceAssetId:selected.asset.id,width:1200,height:180})});
   state.message="Waveform job "+result.job.status+". Refresh the timeline after the worker completes to display the waveform.";
   window.dispatchEvent(new Event("ev:jobs-updated"));
  }catch(error){state.message=error instanceof Error?error.message:"Waveform generation could not be queued.";}
  finally{action.removeAttribute("disabled");paint();}
  return;
 }
 if(type==="preview-refresh"){state.previewKey="";state.previewUrl="";state.previewWaveformUrl="";state.previewExpiresAt=0;state.previewError="";state.previewLoading=false;state.derivativeComparison=null;state.derivativeComparisonError="";paint();return;}
 if(type.startsWith("preview-")){seekPreview(type);return;}
 if(type==="duplicate-variant"){try{await duplicateTimelineVariant();}catch(error){state.message=error instanceof Error?error.message:"Could not create timeline variant.";}paint();return;}
 if(!state.timeline)return;
 if(type==="track-mute"||type==="track-solo"){
  const trackId=action.dataset.track||"",track=state.timeline.tracks.find(item=>item.id===trackId);
  if(!track||track.kind!=="audio")return;
  const patch=type==="track-mute"?{muted:track.muted!==true}:{solo:track.solo!==true};
  recordEdit();state.timeline=setAudioTrackState(state.timeline,trackId,patch);
  state.message=type==="track-mute"?(patch.muted?"Muted ":"Unmuted ")+(track.name)+".":(patch.solo?"Soloed ":"Unsoloed ")+(track.name)+".";
  paint();
  try{await persist();}catch(error){state.message=error instanceof Error?error.message:"Audio track state could not be saved.";state.status="offline";}paint();return;
 }
 if(type==="track-toggle"){
  const trackId=action.dataset.track||"",track=state.timeline.tracks.find(item=>item.id===trackId);if(!track||track.locked)return;
  recordEdit();state.timeline={...state.timeline,revision:state.timeline.revision+1,updatedAt:new Date().toISOString(),tracks:state.timeline.tracks.map(item=>item.id===trackId?{...item,enabled:item.enabled===false}:item)};
  state.message=(track.enabled===false?"Enabled ":"Muted ")+track.name+".";paint();
  try{await persist();}catch(error){state.message=error instanceof Error?error.message:"Track state could not be saved.";state.status="offline";}paint();return;
 }
 const trackId=action.dataset.track||"",clipId=action.dataset.clip||"";
 if(type==="split"){
  const track=state.timeline.tracks.find(t=>t.id===trackId),clip=track?.clips.find(c=>c.id===clipId);if(!track||!clip)return;
  const splitAt=Math.round(clip.timelineStart.value+clip.duration.value/2);
  const nextTimeline=splitClip(state.timeline,trackId,clipId,splitAt,crypto.randomUUID());recordEdit();state.timeline=nextTimeline;
 }else if(type==="trim"){const nextTimeline=trimClip(state.timeline,trackId,clipId,12,12);recordEdit();state.timeline=nextTimeline;}
 else if(type==="move"){
  const from=state.timeline.tracks.findIndex(t=>t.id===trackId);const target=state.timeline.tracks[(from+1)%state.timeline.tracks.length];if(!target)return;
  const clip=state.timeline.tracks[from].clips.find(c=>c.id===clipId);if(!clip)return;
  const start=maxEnd()+12,nextTimeline=moveClip(state.timeline,trackId,clipId,target.id,start);recordEdit();state.timeline=nextTimeline;
 }else if(type==="ripple-delete"){
  const nextTimeline=removeClip(state.timeline,trackId,clipId,true);recordEdit();state.timeline=nextTimeline;
  if(state.selectedClipId===clipId)state.selectedClipId="";
 }else if(type==="export"){
  const content=JSON.stringify(toOpenTimelineIo(state.timeline),null,2);
  const blob=new Blob([content],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=(state.timeline.name||"timeline").replace(/[^a-z0-9-_]/gi,"-")+".otio.json";a.click();URL.revokeObjectURL(url);return;
 }
 state.message="Saving timeline revision…";paint();
 try{await persist();}catch(error){state.message=error instanceof Error?error.message:"Save failed.";state.status="offline";}paint();
}
document.addEventListener("keydown",event=>{
 const target=event.target as HTMLElement|null;
 const editable=!!target&&(target.isContentEditable||!!target.closest('input,textarea,select,[contenteditable="true"],[data-shortcuts-disabled]'));
 const shortcut=getTimelineHistoryShortcut({key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,altKey:event.altKey,isComposing:event.isComposing,editableTarget:editable});
 if(!shortcut||!state.timeline)return;
 const action=document.querySelector<HTMLElement>('[data-tl-action="'+shortcut+'"]');
 if(!action||("disabled" in action&&(action as HTMLButtonElement).disabled))return;
 event.preventDefault();void runAction(action);
});
document.addEventListener("submit",async event=>{
 const form=event.target as HTMLFormElement;if(!state.timeline)return;
 if(form.id==="tl-add-track"){
  event.preventDefault();const data=new FormData(form),name=String(data.get("name")||"").trim(),kind=String(data.get("kind")||"video") as TimelineTrack["kind"];
  if(!name)return;
  const nextTimeline=addTrack(state.timeline,{id:crypto.randomUUID(),name,kind,enabled:true,locked:false,clips:[]});recordEdit();state.timeline=nextTimeline;
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-add-clip"){
  event.preventDefault();const data=new FormData(form),assetId=String(data.get("assetId")||""),trackId=String(data.get("trackId")||"");
  const submitter=(event as SubmitEvent).submitter as HTMLButtonElement|null;
  if(submitter?.name==="generatedHandoff"){
   if(state.mode!=="cloud"||!state.timeline){state.message="Choose a saved cloud timeline before sending generated media.";paint();return;}
   const asset=state.assets.find(item=>item.id===assetId),track=state.timeline.tracks.find(item=>item.id===trackId);
   const jobId=String(asset?.metadata?.jobId||"");
   if(!asset||asset.metadata?.generated!==true||!jobId||!track){state.message="Select a generated asset with its server-recorded generation job and a destination track.";paint();return;}
   const requestedStartFrames=Math.max(0,Number(data.get("start"))||0),handoffSnap=snapTimelineFrame(requestedStartFrames,state.timeline,trackId,6),startFrames=handoffSnap.frame;
   const requestedDurationFrames=Math.max(1,Number(data.get("duration"))||1);const requestBody={assetId:asset.id,jobId,trackId,clipId:crypto.randomUUID(),clipName:asset.name,playheadSeconds:startFrames/fps(),expectedRevision:state.serverRevision,...(asset.mediaType.startsWith("image/")?{durationSeconds:requestedDurationFrames/fps()}:{})};
   try{
    const result=await apiRequest<{timeline:CloudSavedTimeline;idempotentReplay?:boolean}>("/api/cloud/timelines/"+state.timeline.id+"/handoff",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(requestBody)});
    recordEdit();state.timeline=result.timeline.timeline;state.serverRevision=result.timeline.revision;state.selectedClipId=requestBody.clipId;state.selectedTrack=trackId;state.status="ready";state.message=result.idempotentReplay?"Generated media was already on the timeline.":"Verified generated media added and saved at revision "+result.timeline.revision+".";await refresh();paint();
   }catch(error){state.message=error instanceof Error?error.message:"Generated-media handoff failed.";state.status="ready";paint();}
   return;
  }
  const requestedStart=Math.max(0,Number(data.get("start"))||0),snapped=snapTimelineFrame(requestedStart,state.timeline,trackId,6),start=snapped.frame,sourceIn=Math.max(0,Number(data.get("sourceIn"))||0),duration=Math.max(1,Number(data.get("duration"))||1);
  const asset=state.assets.find(a=>a.id===assetId);if(!asset)return;
  const destination=state.timeline.tracks.find(t=>t.id===trackId);
  if(destination?.kind==="audio"&&!asset.mediaType.startsWith("audio/")){alert("Audio tracks require audio assets.");return;}
  if(destination?.kind==="video"&&!asset.mediaType.startsWith("video/")&&!asset.mediaType.startsWith("image/")){alert("Video tracks require image or video assets.");return;}
  if(destination?.kind==="overlay"&&!asset.mediaType.startsWith("image/")){alert("Overlay tracks currently require still-image assets.");return;}
  if(destination?.kind==="caption"&&(!["text/plain","text/vtt"].includes(asset.mediaType)||!["srt","vtt"].includes(asset.name.toLowerCase().split(".").pop()||""))){alert("Caption tracks require an SRT or VTT text file.");return;}
  const sourceFps=sourceRate(asset,destination?.kind||"video");
  const sourceDuration=duration/fps()*sourceFps;
  try{const nextTimeline=addClip(state.timeline,trackId,{id:crypto.randomUUID(),assetId,name:asset.name,sourceRange:{start:rational(sourceIn,sourceFps),duration:rational(sourceDuration,sourceFps)},timelineStart:rational(start,fps()),duration:rational(duration,fps()),enabled:true});recordEdit();state.timeline=nextTimeline;if(snapped.snappedTo!==null)state.message="Clip aligned to frame "+snapped.snappedTo+" using timeline snapping.";}
  catch(error){alert(error instanceof Error?error.message:String(error));return;}
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-clip-inspector"){
  event.preventDefault();const data=new FormData(form),trackId=form.dataset.track||"",clipId=form.dataset.clip||"";
  const track=state.timeline.tracks.find(item=>item.id===trackId),clip=track?.clips.find(item=>item.id===clipId);if(!track||!clip)return;
  const submitter=(event as SubmitEvent).submitter as HTMLButtonElement|null;
  if(submitter?.name==="replaceDerivative"){
   const replacementId=String(data.get("replacementAssetId")||"");
   const replacement=state.assets.find(item=>item.id===replacementId);
   if(!replacement||!assessDerivativeEligibility(replacement,clip.assetId,state.assets.find(source=>source.id===clip.assetId)?.mediaType).eligible){state.message="Choose a derivative whose parent, checksums, decoder, dimensions and independent review are verified.";paint();return;}
   const previousTimeline=state.timeline,previousHistory=state.history;
   try{
    const nextTimeline=replaceTimelineClipAsset(state.timeline,trackId,clipId,replacement.id);
    recordEdit();state.timeline=nextTimeline;state.message="Replacing clip media while preserving its editorial decisions…";paint();
    await persist();state.message="Clip now uses the approved derivative. Original source remains unchanged.";state.status="ready";await refresh();state.selectedClipId=clipId;paint();
   }catch(error){state.timeline=previousTimeline;state.history=previousHistory;state.message=error instanceof Error?error.message:"Derivative replacement could not be saved.";state.status="ready";paint();}
   return;
  }
  const asset=state.assets.find(item=>item.id===clip.assetId);if(!asset)return;
  const requestedStart=Math.max(0,Number(data.get("start"))||0),snapped=snapTimelineFrame(requestedStart,state.timeline,trackId,6),start=snapped.frame,duration=Math.max(1,Number(data.get("duration"))||1),sourceIn=Math.max(0,Number(data.get("sourceIn"))||0),sourceFps=sourceRate(asset,track.kind);
  recordEdit();
  clip.name=String(data.get("name")||clip.name).trim()||clip.name;
  clip.timelineStart=rational(start,fps());clip.duration=rational(duration,fps());
  clip.sourceRange={start:rational(sourceIn,sourceFps),duration:rational(duration/fps()*sourceFps,sourceFps)};
  if(track.kind==="audio"){clip.gainDb=Math.max(-60,Math.min(24,Number(data.get("gainDb"))||0));const audioRole=["voice","music"].includes(String(data.get("audioRole")))?String(data.get("audioRole")):"other";clip.metadata={...clip.metadata,audioRole,duckingEnabled:audioRole==="music"&&data.get("duckingEnabled")==="on",duckingThresholdDb:Math.max(-60,Math.min(-6,Number(data.get("duckingThresholdDb"))||-24)),duckingRatio:Math.max(1,Math.min(20,Number(data.get("duckingRatio"))||8))};}
  if(track.kind==="overlay"){
   let motionKeyframes:unknown[]=[];
   try{const parsed=JSON.parse(String(data.get("motionKeyframes")||"[]"));if(!Array.isArray(parsed)||parsed.length>50)throw new Error("Use a JSON array containing no more than 50 keyframes.");motionKeyframes=parsed;}catch(error){alert(error instanceof Error?error.message:"Motion keyframes must be valid JSON.");return;}
   const seenFrames=new Set<number>(),maxFrame=Math.max(1,Math.round(duration));
   for(const item of motionKeyframes as Array<Record<string,unknown>>){
    const frame=Number(item?.frame),x=Number(item?.x),y=Number(item?.y),scale=Number(item?.scale??1);
    if(!Number.isSafeInteger(frame)||frame<0||frame>maxFrame||seenFrames.has(frame)||!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>state.timeline.width||y<0||y>state.timeline.height||!Number.isFinite(scale)||scale<0.1||scale>4){alert("Each keyframe needs a unique frame within the clip, valid X/Y positions and scale from 0.1 to 4.");return;}
    seenFrames.add(frame);
   }
   clip.metadata={...clip.metadata,x:Number(data.get("x"))||0,y:Number(data.get("y"))||0,width:Math.max(16,Number(data.get("width"))||16),height:Math.max(16,Number(data.get("height"))||16),opacity:Math.max(0,Math.min(1,Number(data.get("opacity")??1))),motionKeyframes:(motionKeyframes as Array<Record<string,unknown>>).map(item=>({frame:Number(item.frame),x:Math.round(Number(item.x)),y:Math.round(Number(item.y)),scale:Number(item.scale??1)})).sort((a,b)=>a.frame-b.frame)};
  }
  if(track.kind==="caption")clip.metadata={...clip.metadata,fontName:String(data.get("fontName")||"DejaVu Sans").slice(0,48),fontSize:Math.max(12,Math.min(96,Number(data.get("fontSize"))||32)),primaryColor:/^#[0-9a-f]{6}$/i.test(String(data.get("primaryColor")||""))?String(data.get("primaryColor")):"#FFFFFF",alignment:Math.max(1,Math.min(9,Number(data.get("alignment"))||2)),backgroundMode:data.get("backgroundMode")==="none"?"none":"box",backgroundColor:/^#[0-9a-f]{6}$/i.test(String(data.get("backgroundColor")||""))?String(data.get("backgroundColor")):"#000000",backgroundOpacity:Math.max(0,Math.min(1,Number(data.get("backgroundOpacity")??0.68))),outline:Math.max(0,Math.min(8,Number(data.get("outline")??2))),shadow:Math.max(0,Math.min(8,Number(data.get("shadow")??1))),marginV:Math.max(0,Math.min(240,Number(data.get("marginV"))||42)),captionPreset:String(data.get("captionPreset")||"standard")};
  const previousTrace=readCreativeTrace(clip),creativeTrace={storyBeat:String(data.get("storyBeat")||"").trim().slice(0,120),purpose:String(data.get("purpose")||"").trim().slice(0,500),audiencePromise:String(data.get("audiencePromise")||"").trim().slice(0,300),proofReference:String(data.get("proofReference")||"").trim().slice(0,300),decisionNote:String(data.get("decisionNote")||"").trim().slice(0,500)},nextTrace=Object.values(creativeTrace).some(Boolean)?creativeTrace:null;
  const decisionHistory=appendCreativeDecision(readCreativeDecisionHistory(clip),previousTrace,nextTrace,crypto.randomUUID(),new Date().toISOString());
  const clipDurationSeconds=duration/fps();
  const fadeInSeconds=Math.max(0,Math.min(clipDurationSeconds,Number(data.get("fadeInSeconds"))||0));
  const fadeOutSeconds=Math.max(0,Math.min(clipDurationSeconds,Number(data.get("fadeOutSeconds"))||0));
  const nextMetadata:Record<string,unknown>={...clip.metadata,creativeTraceHistory:decisionHistory,...(track.kind==="video"||track.kind==="audio"?{fadeInSeconds,fadeOutSeconds}:{})};
  if(nextTrace)nextMetadata.creativeTrace=nextTrace;else delete nextMetadata.creativeTrace;
  clip.metadata=nextMetadata;
  state.message="Saving clip properties…";void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-add-marker"){
  event.preventDefault();const data=new FormData(form);
  const nextTimeline=addMarker(state.timeline,{id:crypto.randomUUID(),name:String(data.get("name")).trim().slice(0,120),start:rational(Math.max(0,Number(data.get("frame"))||0),fps()),color:["YELLOW","RED","GREEN","BLUE"].includes(String(data.get("color")))?String(data.get("color")):"YELLOW",note:String(data.get("note")||"").trim().slice(0,500)});recordEdit();state.timeline=nextTimeline;
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLSelectElement;
 if(target.id==="tl-caption-preset"){
  const preset=getCaptionStylePreset(target.value);
  const values:Record<string,string>={fontName:preset.fontName,fontSize:String(preset.fontSize),primaryColor:preset.primaryColor,alignment:String(preset.alignment),backgroundMode:preset.backgroundMode,backgroundColor:preset.backgroundColor,backgroundOpacity:String(preset.backgroundOpacity),outline:String(preset.outline),shadow:String(preset.shadow),marginV:String(preset.marginV)};
  for(const [name,value] of Object.entries(values)){const field=document.querySelector<HTMLInputElement|HTMLSelectElement>('#tl-clip-inspector [name="'+name+'"]');if(field)field.value=value;}
  return;
 }
 if(target.id==="tl-delivery-profile"&&state.timeline&&state.mode==="cloud"){
  const previous=state.timeline.deliveryProfileId;
  state.timeline={...state.timeline,deliveryProfileId:target.value||undefined};
  state.message="Saving export profile…";paint();
  void persist().then(()=>{state.message=target.value?"Export profile saved. Cloud renders will encode and validate against it.":"Custom sequence export settings restored.";state.status="ready";}).catch(error=>{if(state.timeline)state.timeline={...state.timeline,deliveryProfileId:previous};state.message=error instanceof Error?error.message:"Could not save export profile.";state.status="offline";}).finally(paint);
 }
 if(target.id==="tl-mode"){state.mode=target.value==="cloud"?"cloud":"local";state.timeline=null;state.history=createTimelineHistory(50);state.selectedClipId="";void refresh().then(paint).catch(error=>{state.status="offline";state.message=error instanceof Error?error.message:"Workspace unavailable.";paint();});}
 if(target.id==="tl-cloud-project"){state.cloudProjectId=target.value;state.timeline=null;state.history=createTimelineHistory(50);state.selectedClipId="";void refresh().then(paint).catch(error=>{state.status="offline";state.message=error instanceof Error?error.message:"Cloud project unavailable.";paint();});}
 if(target.id==="tl-saved-sequence"&&target.value){
  const saved=state.mode==="cloud"?state.cloudTimelines.find(t=>t.id===target.value):state.timelines.find(t=>t.id===target.value);
  if(saved){state.history=createTimelineHistory(50);if(state.mode==="cloud"){const cloud=saved as CloudSavedTimeline;state.timeline=cloud.timeline;state.serverRevision=cloud.revision;void loadVariantComparison().then(paint);}
   else void apiRequest<{timeline:SavedTimeline}>("/api/timelines/"+saved.id).then(result=>{state.history=createTimelineHistory(50);state.timeline=result.timeline.document||null;state.serverRevision=result.timeline.revision;void loadVariantComparison().then(paint);}).catch(error=>{state.message=error.message;paint();});}
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
document.addEventListener("input",event=>{const target=event.target as HTMLInputElement;if(target.id!=="tl-preview-scrub")return;const media=document.querySelector<HTMLMediaElement>("#tl-preview-media");if(!media)return;const start=Number(media.dataset.sourceIn),end=Number(media.dataset.sourceOut),rate=Number(media.dataset.sourceFps);if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(rate)||rate<=0)return;media.currentTime=clampPreviewSeconds(start+Number(target.value)/rate,start,end);});
document.addEventListener("click",event=>{
 const create=(event.target as HTMLElement).closest<HTMLElement>("[data-tl-create-cloud]");if(create){void createCloudTimeline().catch(error=>{state.message=error instanceof Error?error.message:"Cloud timeline creation failed.";paint();});return;}
 const target=event.target as HTMLElement,select=target.closest<HTMLElement>("[data-tl-select]");
 if(select&&state.timeline){state.selectedTrack=select.dataset.track||"";state.selectedClipId=select.dataset.clip||"";state.previewKey="";state.previewUrl="";state.previewWaveformUrl="";state.previewExpiresAt=0;state.previewError="";state.previewLoading=false;paint();}
 const action=target.closest<HTMLElement>("[data-tl-action]");
 if(action)void runAction(action);
});
document.addEventListener("input",event=>{
 const target=event.target as HTMLInputElement|null;
 if(!target||target.id!=="tl-preview-scrub")return;
 const media=document.querySelector<HTMLMediaElement>("#tl-preview-media");if(!media)return;
 const start=Number(media.dataset.sourceIn),end=Number(media.dataset.sourceOut),rate=Number(media.dataset.sourceFps),frame=Number(target.value);
 try{media.currentTime=previewSecondsAtScrubFrame(frame,start,rate,end);const output=document.querySelector<HTMLOutputElement>("#tl-preview-time");if(output)output.value=media.currentTime.toFixed(3)+" s";}
 catch{target.value="0";}
});
window.addEventListener("ev:authenticated",()=>void initTimelineWorkspace());
window.addEventListener("ev:assets-updated",()=>void refresh().then(paint).catch(error=>{state.message=error.message;paint();}));
