import { apiRequest, apiRequestBlob } from "../core/api";
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
import { addClip, addMarker, addTrack, createTimeline, moveClip, normalizeAudioMasteringSettings, rational, splitClip, toOpenTimelineIo, trimClip, type EditorialTimeline, type TimelineTrack } from "../core/timeline";
import { clampTimelineFrame, frameToTimelineSeconds, getTimelinePlaybackFrame, timelineDurationSeconds, selectTimelinePreviewAsset, isTimelinePreviewUrlFresh, shouldRetryTimelinePreviewUrl, shouldFallbackToTimelineSourcePreview } from "../core/timeline-playback";
import { TimelineRecoveryStore, assessTimelineRecovery, checksumTimeline, requestPersistentBrowserStorage, timelineRecoveryKey, type TimelineRecoveryDraft } from "../core/timeline-recovery";

type Asset={id:string;name:string;mediaType:string;size:number;derivativeOf?:string|null;metadata?:Record<string,unknown>};
type SavedTimeline={id:string;projectId?:string|null;name:string;revision:number;document?:EditorialTimeline};
type CloudProject={id:string;name:string};
type CloudSavedTimeline={id:string;projectId?:string|null;name:string;revision:number;timeline:EditorialTimeline;updatedAt:string};
type TimelineRevisionSummary={timelineId:string;revision:number;name:string;createdAt:string};
type TimelineRevisionSnapshot=TimelineRevisionSummary&{timeline:EditorialTimeline;otio:Record<string,unknown>|null};
const state:{timeline:EditorialTimeline|null;serverRevision:number;timelines:SavedTimeline[];cloudTimelines:CloudSavedTimeline[];cloudProjects:CloudProject[];cloudProjectId:string;mode:"local"|"cloud";cloudRenderJobId:string;cloudRenderJobStatus:string;variantBase:EditorialTimeline|null;variantReport:TimelineVariantComparison|null;variantBaseName:string;revisionHistory:TimelineRevisionSummary[];revisionHistoryOpen:boolean;selectedHistoryRevision:number;historyCompareTimeline:EditorialTimeline|null;historyComparison:TimelineVariantComparison|null;assets:Asset[];status:"loading"|"ready"|"offline"|"auth";message:string;selectedTrack:string;selectedClipId:string;ffmpeg:boolean;mediaJobId:string;mediaJobType:"media.proxy"|"media.thumbnail"|"";mediaClipId:string;previewFrameUrl:string;proxyPreviewUrl:string;previewAssetUrls:Record<string,string>;previewAssetUrlExpiresAt:Record<string,number>;previewLoaded:boolean;previewLoading:boolean;playheadFrame:number;isPlaying:boolean;playbackRaf:number;playbackLastTimestamp:number;previewUnavailableAssetIds:string[];previewRefreshAttemptedAssetIds:string[];recoveryStatus:"idle"|"saved"|"recovered"|"conflict"|"unavailable";recoveredDraft:TimelineRecoveryDraft|null;previewDiagnostics:{droppedFrames:number;totalFrames:number;stalls:number;errors:number;sourceCount:number;proxyCount:number;proxyFallbacks:number}}={
 timeline:null,serverRevision:0,timelines:[],cloudTimelines:[],cloudProjects:[],cloudProjectId:"",mode:"local",cloudRenderJobId:"",cloudRenderJobStatus:"",variantBase:null,variantReport:null,variantBaseName:"",revisionHistory:[],revisionHistoryOpen:false,selectedHistoryRevision:0,historyCompareTimeline:null,historyComparison:null,assets:[],status:"loading",message:"Loading editorial workspace…",selectedTrack:"",selectedClipId:"",ffmpeg:false,mediaJobId:"",mediaJobType:"",mediaClipId:"",previewFrameUrl:"",proxyPreviewUrl:"",previewAssetUrls:{},previewAssetUrlExpiresAt:{},previewLoaded:false,previewLoading:false,playheadFrame:0,isPlaying:false,playbackRaf:0,playbackLastTimestamp:0,previewUnavailableAssetIds:[],previewRefreshAttemptedAssetIds:[],recoveryStatus:"idle",recoveredDraft:null,previewDiagnostics:{droppedFrames:0,totalFrames:0,stalls:0,errors:0,sourceCount:0,proxyCount:0,proxyFallbacks:0}
};
const history:{timelineId:string;undo:EditorialTimeline[];redo:EditorialTimeline[]}={timelineId:"",undo:[],redo:[]};
function recordUndo(){if(!state.timeline)return;if(history.timelineId!==state.timeline.id){history.timelineId=state.timeline.id;history.undo=[];history.redo=[];}history.undo.push(structuredClone(state.timeline));if(history.undo.length>50)history.undo.shift();history.redo=[];}
let timelineRecoveryStore:TimelineRecoveryStore|null=null;
let timelineRecoverySequence=0;
function recoveryStore(){if(!timelineRecoveryStore)timelineRecoveryStore=new TimelineRecoveryStore();return timelineRecoveryStore;}
function currentRecoveryKey(){
 if(!state.timeline)return "";
 const projectId=state.mode==="cloud"?(state.timeline.projectId||state.cloudProjectId):state.timeline.projectId||"";
 return timelineRecoveryKey(state.mode,projectId,state.timeline.id);
}
async function saveRecoveryDraft(reason:string):Promise<TimelineRecoveryDraft|null>{
 if(!state.timeline)return null;
 try{
  const projectId=state.mode==="cloud"?(state.timeline.projectId||state.cloudProjectId):state.timeline.projectId||"";
  const draft=await recoveryStore().saveDraft({key:currentRecoveryKey(),projectId,timelineId:state.timeline.id,mode:state.mode,baseRevision:state.serverRevision,localRevision:state.timeline.revision,sequence:++timelineRecoverySequence,updatedAt:new Date().toISOString(),reason,snapshot:structuredClone(state.timeline)});
  state.recoveryStatus="saved";return draft;
 }catch(error){state.recoveryStatus="unavailable";state.message="Browser recovery storage is unavailable: "+(error instanceof Error?error.message:"unknown storage error")+". The server save will still be attempted.";return null;}
}
async function completeRecoveryCheckpoint(draft:TimelineRecoveryDraft|null,revision:number):Promise<void>{
 if(!draft)return;
 try{await recoveryStore().saveCheckpoint(draft,revision,"Server-confirmed timeline save");state.recoveryStatus="saved";state.recoveredDraft=null;}
 catch(error){state.recoveryStatus="unavailable";state.message="Timeline saved on the server, but its local checkpoint could not be finalized: "+(error instanceof Error?error.message:"storage error")+". The recovery draft was retained where possible.";}
}
async function restoreTimelineRecovery():Promise<void>{
 if(!state.timeline)return;
 try{
  const key=currentRecoveryKey(),draft=await recoveryStore().getDraft(key);
  if(draft)timelineRecoverySequence=Math.max(timelineRecoverySequence,draft.sequence);
  state.recoveredDraft=null;state.recoveryStatus="idle";
  const assessment=await assessTimelineRecovery(draft,state.serverRevision);
  if(assessment.disposition==="recover"&&assessment.draft){
   if(await checksumTimeline(state.timeline)===assessment.draft.checksum){await recoveryStore().saveCheckpoint(assessment.draft,state.serverRevision,"Confirmed server save recovered after interrupted checkpoint");state.recoveryStatus="saved";return;}
   state.timeline=structuredClone(assessment.draft.snapshot);state.recoveredDraft=assessment.draft;state.recoveryStatus="recovered";state.message=assessment.reason+" Save or discard it explicitly.";
  }else if(assessment.disposition==="conflict"&&assessment.draft){state.recoveredDraft=assessment.draft;state.recoveryStatus="conflict";state.message=assessment.reason+" The latest server timeline remains loaded and unchanged.";
  }else if(assessment.disposition==="invalid"){state.recoveryStatus="unavailable";state.message=assessment.reason;}
 }catch(error){state.recoveryStatus="unavailable";state.message="Could not inspect the browser recovery journal: "+(error instanceof Error?error.message:"unknown error")+".";}
}
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
function timelineMediaTools(track:TimelineTrack,clip:TimelineTrack["clips"][number],sourceIn:number,proxyAssetId:string,proxyName:string){
 if(track.kind!=="video")return "";
 if(state.mode==="cloud")return '<div class="timeline-media-tools"><div class="eyebrow">PROXY & FRAME PREVIEW</div><p class="muted">Playback prefers an accessible source-linked cloud proxy when attached. If proxy signing fails, playback falls back to the original. Cloud proxy generation and source-frame extraction remain disabled until cloud media-processing jobs are implemented.</p></div>';
 const asset=state.assets.find(item=>item.id===clip.assetId);
 if(!asset||!asset.mediaType.startsWith("video/"))return "";
 return '<div class="timeline-media-tools"><div class="eyebrow">PROXY & FRAME PREVIEW</div><p class="muted">Generate a compact editing copy for playback. Final master rendering continues to use the original source asset.</p><label>Source frame to extract</label><input id="tl-preview-source-frame" type="number" min="0" value="'+sourceIn+'"><p class="muted">'+(proxyAssetId?'Proxy linked · '+esc(proxyName||proxyAssetId.slice(0,8)):'No proxy attached')+'</p><div class="timeline-media-actions"><button type="button" class="secondary" data-tl-action="generate-proxy" data-clip="'+esc(clip.id)+'">'+(proxyAssetId?'Regenerate 960p proxy':'Generate 960p proxy')+'</button><button type="button" class="secondary" data-tl-action="generate-frame-preview" data-clip="'+esc(clip.id)+'">Extract source frame</button>'+(proxyAssetId?'<button type="button" class="secondary" data-tl-action="preview-proxy" data-clip="'+esc(clip.id)+'">Load proxy preview</button>':'')+'</div>'+(state.proxyPreviewUrl&&state.mediaClipId===clip.id?'<video class="timeline-proxy-preview" controls preload="metadata" src="'+esc(state.proxyPreviewUrl)+'"></video>':'')+(state.previewFrameUrl&&state.mediaClipId===clip.id?'<img class="timeline-frame-preview" alt="Extracted source frame" src="'+esc(state.previewFrameUrl)+'">':'')+'</div>';
}
const assetOptions=()=>state.assets.map(a=>{const probe=a.metadata?.probe as {format?:{duration?:string}}|undefined;const duration=Number(probe?.format?.duration);return '<option value="'+esc(a.id)+'">'+esc(a.name)+' · '+esc(a.mediaType)+(Number.isFinite(duration)?' · '+duration.toFixed(1)+'s':' · inspect for duration')+'</option>';}).join("");
function timelineCanvas(){
 if(!state.timeline)return '<div class="empty">'+esc(state.message)+'</div>';
 const total=maxEnd();
 return '<div class="timeline-ruler"><span>00:00</span><span>'+Math.round(total/2/fps())+'s</span><span>'+Math.round(total/fps())+'s</span></div>'+
 state.timeline.tracks.map(track=>'<div class="editor-track"><div class="editor-track-label"><b>'+esc(track.name)+'</b><small>'+esc(track.kind)+(track.locked?' · locked':'')+'</small></div><div class="editor-track-lane">'+track.clips.map(clip=>'<article class="editor-clip '+(state.selectedClipId===clip.id?'selected':'')+'" data-tl-select="true" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'" style="left:'+Math.max(0,clip.timelineStart.value/total*100)+'%;width:'+Math.max(4,clip.duration.value/total*100)+'%"><b>'+esc(clip.name)+'</b><small>'+esc(clip.assetId.slice(0,8))+' · '+Math.round(clip.duration.value)+'f</small><div class="editor-clip-actions"><button data-tl-action="split" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Split</button><button data-tl-action="trim" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Trim 12f</button><button data-tl-action="move" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Next track</button></div></article>').join("")+'</div></div>').join("");
}
function clipInspector(){
 if(!state.timeline||!state.selectedClipId)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its timing, gain or visual properties.</p></div>';
 const track=state.timeline.tracks.find(item=>item.clips.some(clip=>clip.id===state.selectedClipId));
 const clip=track?.clips.find(item=>item.id===state.selectedClipId);
 if(!track||!clip)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its properties.</p></div>';
 const metadata=clip.metadata||{},effects=(metadata.timelineEffects||{}) as Record<string,number>,proxyAssetId=typeof metadata.proxyAssetId==="string"?metadata.proxyAssetId:"",trace=readCreativeTrace(clip)||{storyBeat:"",purpose:"",audiencePromise:"",proofReference:"",decisionNote:""},decisions=readCreativeDecisionHistory(clip),start=Math.round(clip.timelineStart.value),duration=Math.round(clip.duration.value),sourceIn=Math.round(clip.sourceRange.start.value);
 let specific="";
 if(track.kind==="audio")specific='<div><label>Gain (dB)</label><input name="gainDb" type="number" min="-60" max="24" step="0.5" value="'+esc(clip.gainDb??0)+'"></div>';
 if(track.kind==="overlay")specific='<div><label>X position</label><input name="x" type="number" min="0" value="'+esc(metadata.x??Math.max(0,(state.timeline.width||1920)-Math.round((state.timeline.width||1920)*0.24)-24))+'"></div><div><label>Y position</label><input name="y" type="number" min="0" value="'+esc(metadata.y??24)+'"></div><div><label>Width (px)</label><input name="width" type="number" min="16" value="'+esc(metadata.width??Math.round((state.timeline.width||1920)*0.24))+'"></div><div><label>Height (px)</label><input name="height" type="number" min="16" value="'+esc(metadata.height??Math.round((state.timeline.height||1080)*0.24))+'"></div><div><label>Opacity</label><input name="opacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.opacity??1)+'"></div>';
 if(track.kind==="video")specific='<div class="full timeline-effect-stack"><div class="eyebrow">NON-DESTRUCTIVE EFFECT LAYER</div><p class="muted">Effects are saved with this clip and applied during rendering. Original media remains unchanged.</p><div class="form-grid"><div><label>Brightness</label><input name="effectBrightness" type="number" min="-0.5" max="0.5" step="0.01" value="'+esc(effects.brightness??0)+'"></div><div><label>Contrast</label><input name="effectContrast" type="number" min="0.5" max="2" step="0.05" value="'+esc(effects.contrast??1)+'"></div><div><label>Saturation</label><input name="effectSaturation" type="number" min="0" max="2" step="0.05" value="'+esc(effects.saturation??1)+'"></div><div><label>Denoise</label><input name="effectDenoise" type="number" min="0" max="10" step="0.25" value="'+esc(effects.denoise??0)+'"></div><div><label>Sharpen</label><input name="effectSharpen" type="number" min="0" max="1" step="0.05" value="'+esc(effects.sharpen??0)+'"></div></div></div>';
 if(track.kind==="caption")specific='<div><label>Font family</label><input name="fontName" value="'+esc(metadata.fontName??"DejaVu Sans")+'"></div><div><label>Font size</label><input name="fontSize" type="number" min="12" max="96" value="'+esc(metadata.fontSize??32)+'"></div><div><label>Text color</label><input name="primaryColor" type="color" value="'+esc(metadata.primaryColor??"#FFFFFF")+'"></div><div><label>Caption placement</label><select name="alignment">'+[1,2,3,4,5,6,7,8,9].map(n=>'<option value="'+n+'" '+(Number(metadata.alignment??2)===n?'selected':'')+'>'+n+'</option>').join("")+'</select></div><div><label>Background panel</label><select name="backgroundMode"><option value="box" '+(metadata.backgroundMode!=="none"?'selected':'')+'>Behind captions</option><option value="none" '+(metadata.backgroundMode==="none"?'selected':'')+'>No panel</option></select></div><div><label>Panel color</label><input name="backgroundColor" type="color" value="'+esc(metadata.backgroundColor??"#000000")+'"></div><div><label>Panel opacity</label><input name="backgroundOpacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.backgroundOpacity??0.68)+'"></div><div><label>Outline</label><input name="outline" type="number" min="0" max="8" step="0.5" value="'+esc(metadata.outline??2)+'"></div><div><label>Shadow</label><input name="shadow" type="number" min="0" max="8" step="0.5" value="'+esc(metadata.shadow??1)+'"></div><div><label>Bottom safe-area margin</label><input name="marginV" type="number" min="0" max="240" value="'+esc(metadata.marginV??42)+'"></div>';
 return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR · '+esc(track.kind.toUpperCase())+'</div><form id="tl-clip-inspector" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'"><div class="form-grid"><div><label>Clip name</label><input name="name" value="'+esc(clip.name)+'" required></div><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+start+'"></div><div><label>Duration (frames)</label><input name="duration" type="number" min="1" value="'+duration+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="'+sourceIn+'"></div>'+specific+'</div><div class="eyebrow" style="margin-top:16px">CREATIVE INTENT LINK</div><div class="form-grid"><div><label>Story beat</label><input name="storyBeat" maxlength="120" value="'+esc(trace.storyBeat)+'" placeholder="Opening hook / Proof / Payoff"></div><div><label>Audience promise served</label><input name="audiencePromise" maxlength="300" value="'+esc(trace.audiencePromise)+'" placeholder="What did we promise viewers?"></div><div class="full"><label>Why this shot exists</label><textarea name="purpose" maxlength="500" rows="2" placeholder="What information, emotion or transition does it contribute?">'+esc(trace.purpose)+'</textarea></div><div><label>Proof / source reference</label><input name="proofReference" maxlength="300" value="'+esc(trace.proofReference)+'" placeholder="Evidence ID, source or approved claim"></div><div><label>Creative decision note</label><input name="decisionNote" maxlength="500" value="'+esc(trace.decisionNote)+'" placeholder="Why this take, framing or edit was chosen"></div></div>'+(decisions.length?'<div class="eyebrow" style="margin-top:16px">CREATIVE DECISION HISTORY · '+decisions.length+'</div><div class="timeline-quality-list">'+decisions.slice().reverse().slice(0,8).map(item=>'<article class="timeline-quality-item info"><b>r'+item.sequence+' · '+esc(item.summary)+'</b><p>'+esc(item.recordedAt)+'</p></article>').join("")+'</div>':'')+'<button class="secondary">Save clip properties and intent</button></form>'+timelineMediaTools(track,clip,sourceIn,proxyAssetId,String(metadata.proxyAssetName||""))+'</div>';
}
async function loadRevisionHistory(){
 if(state.mode!=="cloud"||!state.timeline)throw new Error("Revision history is available for a selected cloud timeline.");
 const result=await apiRequest<{revisions:TimelineRevisionSummary[]}>("/api/cloud/timelines/"+encodeURIComponent(state.timeline.id)+"/revisions?limit=50");
 state.revisionHistory=result.revisions||[];state.revisionHistoryOpen=true;state.historyCompareTimeline=null;state.historyComparison=null;state.selectedHistoryRevision=0;
}
function timelineRevisionPanel(){
 if(!state.revisionHistoryOpen)return "";
 const rows=state.revisionHistory.map(item=>'<article class="timeline-history-row"><div><b>r'+item.revision+' · '+esc(item.name)+'</b><small>'+esc(new Date(item.createdAt).toLocaleString())+'</small></div><div class="timeline-history-actions"><button class="secondary" data-tl-action="compare-revision" data-revision="'+item.revision+'">Compare</button><button class="secondary" data-tl-action="restore-revision" data-revision="'+item.revision+'" '+(item.revision===state.serverRevision?'disabled':'')+'>Restore</button></div></article>').join("");
 const comparison=state.historyComparison?'<div class="timeline-history-comparison"><b>Comparison · r'+state.selectedHistoryRevision+' → current r'+state.serverRevision+'</b><p>'+esc(state.historyComparison.summary)+'</p>'+(state.historyComparison.changes.length?'<ul>'+state.historyComparison.changes.slice(0,24).map(change=>'<li>'+esc(change.kind)+' · '+esc(change.clipName)+' — '+esc(change.fields.join(", "))+'</li>').join("")+'</ul>':'<p class="muted">No clip-level differences detected.</p>')+'</div>':"";
 return '<section class="panel timeline-history"><div class="timeline-panel-heading"><div><div class="eyebrow">DURABLE CLOUD REVISION HISTORY</div><h3>Saved sequence versions</h3></div><button class="secondary" data-tl-action="close-revision-history">Close</button></div><p class="muted">Immutable snapshots are captured by the database when a timeline revision is created or updated. Restoring a snapshot creates a new current revision; it never rewrites history.</p>'+(rows||'<p class="muted">No saved revisions are available yet. Apply the revision-history database migration to enable snapshots.</p>')+comparison+'</section>';
}
function previewAssetForClip(clip:TimelineTrack["clips"][number],source:Asset){
 const selected=selectTimelinePreviewAsset(clip,source,state.assets);return state.previewUnavailableAssetIds.includes(selected.id)?source:selected;
}
function updatePreviewDiagnostics(){
 const output=document.querySelector<HTMLElement>("#tl-preview-diagnostics");
 if(output)output.textContent="Sources "+state.previewDiagnostics.sourceCount+" · proxies "+state.previewDiagnostics.proxyCount+" · proxy fallbacks "+state.previewDiagnostics.proxyFallbacks+" · dropped frames "+state.previewDiagnostics.droppedFrames+"/"+state.previewDiagnostics.totalFrames+" · stalls "+state.previewDiagnostics.stalls+" · media errors "+state.previewDiagnostics.errors;
}
function releaseTimelinePreview(){
 stopTimelinePlayback();
 for(const url of Object.values(state.previewAssetUrls))if(url.startsWith("blob:"))URL.revokeObjectURL(url);
 state.previewAssetUrls={};state.previewAssetUrlExpiresAt={};state.previewUnavailableAssetIds=[];state.previewRefreshAttemptedAssetIds=[];state.previewLoaded=false;state.previewLoading=false;state.playheadFrame=0;state.previewDiagnostics={droppedFrames:0,totalFrames:0,stalls:0,errors:0,sourceCount:0,proxyCount:0,proxyFallbacks:0};
}
async function signedCloudPreviewUrl(asset:Asset):Promise<string>{
 const signed=await apiRequest<{asset:Asset;url:string;expiresIn:number}>("/api/cloud/assets/"+encodeURIComponent(asset.id));
 let mediaUrl:URL;try{mediaUrl=new URL(signed.url);}catch{throw new Error("Cloud storage returned an invalid preview URL.");}
 if(signed.asset?.id!==asset.id||signed.asset.mediaType!==asset.mediaType||mediaUrl.protocol!=="https:"||mediaUrl.username||mediaUrl.password||mediaUrl.hash||!mediaUrl.pathname.includes("/storage/v1/object/sign/")||!Number.isInteger(signed.expiresIn)||signed.expiresIn<30||signed.expiresIn>3600)throw new Error("Cloud storage returned an unsafe or mismatched preview asset.");
 state.previewAssetUrlExpiresAt[asset.id]=Date.now()+signed.expiresIn*1000;
 return mediaUrl.href;
}
async function previewUrlForAsset(asset:Asset):Promise<string>{
 const cached=state.previewAssetUrls[asset.id];
 if(state.mode==="cloud"){
  if(cached&&isTimelinePreviewUrlFresh(state.previewAssetUrlExpiresAt[asset.id]||0))return cached;
  try{
   const renewed=await signedCloudPreviewUrl(asset);
   state.previewAssetUrls[asset.id]=renewed;
   return renewed;
  }catch(error){
   delete state.previewAssetUrls[asset.id];
   delete state.previewAssetUrlExpiresAt[asset.id];
   throw error;
  }
 }
 if(cached)return cached;
 const blob=await apiRequestBlob("/api/assets/"+encodeURIComponent(asset.id)+"/file");
 const url=URL.createObjectURL(blob);
 state.previewAssetUrls[asset.id]=url;
 return url;
}
async function loadTimelinePreview(){
 if(!state.timeline)throw new Error("Open a timeline before loading playback media.");
 state.previewLoading=true;state.previewUnavailableAssetIds=[];
 const required=new Map<string,{asset:Asset;source:Asset}>();let proxyCount=0;
 for(const track of state.timeline.tracks){
  if(!track.enabled||track.kind==="caption")continue;
  for(const clip of track.clips){
   if(!clip.enabled)continue;
   const source=state.assets.find(item=>item.id===clip.assetId);
   if(!source||!(source.mediaType.startsWith("video/")||source.mediaType.startsWith("audio/")||source.mediaType.startsWith("image/")))continue;
   const selected=previewAssetForClip(clip,source);if(selected.id!==source.id)proxyCount++;
   if(track.kind==="overlay"&&!selected.mediaType.startsWith("image/"))continue;required.set(selected.id,{asset:selected,source});
  }
 }
 if(!required.size){state.previewLoading=false;throw new Error("No enabled accessible video, audio or image clips are available for preview.");}
 try{
  let fallbacks=0;
  for(const {asset,source} of required.values()){
   try{await previewUrlForAsset(asset);}
   catch(error){
    if(asset.id===source.id)throw error;
    state.previewUnavailableAssetIds.push(asset.id);fallbacks++;
    await previewUrlForAsset(source);
   }
  }
  state.previewDiagnostics={...state.previewDiagnostics,droppedFrames:0,totalFrames:0,stalls:0,errors:0,sourceCount:required.size,proxyCount,proxyFallbacks:fallbacks};
  state.previewLoaded=true;state.previewLoading=false;state.message="Preview media loaded for "+required.size+" accessible source(s)"+(proxyCount?" · "+proxyCount+" verified proxy selection(s)":"")+(fallbacks?" · "+fallbacks+" proxy fallback(s) to originals":"")+".";
 }catch(error){releaseTimelinePreview();throw error;}
}
function stopTimelinePlayback(){
 state.isPlaying=false;
 if(state.playbackRaf)cancelAnimationFrame(state.playbackRaf);
 state.playbackRaf=0;state.playbackLastTimestamp=0;
 document.querySelectorAll<HTMLMediaElement>("#timeline-playback video[data-preview-media], #timeline-playback audio[data-preview-media]").forEach(media=>media.pause());
}
function syncPreviewAtFrame(frame:number){
 if(!state.timeline)return;
 const maxFrame=Math.ceil(timelineDurationSeconds(state.timeline)*fps());state.playheadFrame=Math.min(maxFrame,Math.max(0,Number.isFinite(frame)?frame:0));
 const seconds=frameToTimelineSeconds(Math.round(state.playheadFrame),state.timeline);
 const playback=getTimelinePlaybackFrame(state.timeline,seconds);
 const active=new Map(playback.active.map(item=>[item.clipId,item]));
 const topVideo=playback.activeVideo[playback.activeVideo.length-1];
 const audioActive=playback.activeAudio.length>0;
 const hasPicture=playback.active.some(item=>state.assets.some(asset=>asset.id===item.assetId&&((item.trackKind==="video"&&(asset.mediaType.startsWith("video/")||asset.mediaType.startsWith("image/")))||(item.trackKind==="overlay"&&asset.mediaType.startsWith("image/")))));
 const placeholder=document.querySelector<HTMLElement>("#timeline-playback .timeline-preview-placeholder");if(placeholder)placeholder.style.display=hasPicture?"none":"grid";
 document.querySelectorAll<HTMLElement>("#timeline-playback [data-preview-media]").forEach(element=>{
  const clipId=element.dataset.previewClip||"",item=active.get(clipId),kind=element.dataset.previewKind||"";
  const isAudio=kind==="audio",isImage=kind==="image";
  if(isImage){element.style.display=item?"block":"none";return;}
  const media=element as HTMLMediaElement;
  if(!item){media.pause();media.style.display="none";return;}
  media.style.display=isAudio?"none":"block";
  const drift=Math.abs(media.currentTime-item.mediaTimeSeconds);
  if(Number.isFinite(item.mediaTimeSeconds)&&drift>(state.isPlaying?(isAudio?0.08:0.12):0.025)){
   try{media.currentTime=Math.max(0,item.mediaTimeSeconds);}catch{/* wait for media metadata */}
  }
  media.playbackRate=Math.max(0.25,Math.min(4,item.speed||1));
  if(isAudio){
   media.volume=Math.max(0,Math.min(1,Math.pow(10,item.gainDb/20)));
  }else{
   media.muted=audioActive||item.clipId!==topVideo?.clipId;
   media.volume=Math.max(0,Math.min(1,Math.pow(10,item.gainDb/20)));
  }
  if(state.isPlaying&&media.paused)void media.play().catch(()=>{state.message="Browser playback was blocked. Press Play again after interacting with the preview.";stopTimelinePlayback();paint();});
  if(!state.isPlaying&&!media.paused)media.pause();
 });
 const output=document.querySelector<HTMLElement>("#tl-preview-time");
 if(output)output.textContent=formatPlaybackTime(state.playheadFrame);
 const slider=document.querySelector<HTMLInputElement>("#tl-preview-seek");
 if(slider&&document.activeElement!==slider)slider.value=String(Math.round(state.playheadFrame));
 let dropped=0,total=0;
 document.querySelectorAll<HTMLVideoElement>("#timeline-playback video[data-preview-media]").forEach(video=>{
  const quality=video.getVideoPlaybackQuality?.();
  if(quality){dropped+=quality.droppedVideoFrames;total+=quality.totalVideoFrames;}
  else{const legacy=video as HTMLVideoElement&{webkitDroppedFrameCount?:number;webkitDecodedFrameCount?:number};dropped+=Number(legacy.webkitDroppedFrameCount||0);total+=Number(legacy.webkitDecodedFrameCount||0);}
 });
 state.previewDiagnostics.droppedFrames=dropped;state.previewDiagnostics.totalFrames=total;updatePreviewDiagnostics();
}
function formatPlaybackTime(frame:number){
 const rate=fps(),seconds=Math.floor(Math.max(0,frame)/rate),ff=Math.floor(Math.max(0,frame)%rate);
 const hh=Math.floor(seconds/3600),mm=Math.floor(seconds%3600/60),ss=seconds%60;
 return [hh,mm,ss,ff].map(value=>String(value).padStart(2,"0")).join(":");
}
async function startTimelinePlayback(){
 if(!state.previewLoaded)await loadTimelinePreview();
 if(!state.timeline)return;
 const endFrame=clampTimelineFrame(timelineDurationSeconds(state.timeline)*fps(),state.timeline);
 if(state.playheadFrame>=endFrame)state.playheadFrame=0;
 state.isPlaying=true;state.playbackLastTimestamp=performance.now();
 syncPreviewAtFrame(state.playheadFrame);
 const tick=(now:number)=>{
  if(!state.isPlaying||!state.timeline)return;
  const delta=Math.max(0,Math.min(0.1,(now-state.playbackLastTimestamp)/1000));
  state.playbackLastTimestamp=now;
  const next=state.playheadFrame+delta*fps();
  if(next>=endFrame){state.playheadFrame=endFrame;stopTimelinePlayback();syncPreviewAtFrame(endFrame);return;}
  state.playheadFrame=next;syncPreviewAtFrame(next);
  state.playbackRaf=requestAnimationFrame(tick);
 };
 state.playbackRaf=requestAnimationFrame(tick);
}
function stepTimelineFrame(direction:number){
 if(!state.timeline)return;
 stopTimelinePlayback();
 syncPreviewAtFrame(state.playheadFrame+Math.sign(direction));
}
function timelinePlaybackPanel(){
 if(!state.timeline)return "";
 const duration=clampTimelineFrame(timelineDurationSeconds(state.timeline)*fps(),state.timeline);
 const elements=state.previewLoaded?state.timeline.tracks.flatMap((track,trackIndex)=>track.enabled&&track.kind!=="caption"?track.clips.filter(clip=>clip.enabled).map(clip=>{
  const source=state.assets.find(item=>item.id===clip.assetId),asset=source?previewAssetForClip(clip,source):undefined,src=asset?state.previewAssetUrls[asset.id]:"";
  if(!asset||!src||track.kind==="overlay"&&!asset.mediaType.startsWith("image/"))return "";
  const base='data-preview-media="true" data-preview-clip="'+esc(clip.id)+'" data-preview-kind="'+(asset.mediaType.startsWith("audio/")||track.kind==="audio"?"audio":asset.mediaType.startsWith("image/")?"image":"video")+'" data-preview-proxy="'+(source&&asset.id!==source.id?'true':'false')+'" data-preview-asset="'+esc(asset.id)+'" data-preview-track-index="'+trackIndex+'"';
  if(asset.mediaType.startsWith("audio/")||track.kind==="audio")return '<audio '+base+' preload="metadata" src="'+esc(src)+'"></audio>';
  if(asset.mediaType.startsWith("image/")){
   const metadata=clip.metadata||{},x=track.kind==="overlay"?Number(metadata.x)||0:0,y=track.kind==="overlay"?Number(metadata.y)||0:0,w=track.kind==="overlay"?Number(metadata.width)||state.timeline!.width:state.timeline!.width,h=track.kind==="overlay"?Number(metadata.height)||state.timeline!.height:state.timeline!.height,opacity=track.kind==="overlay"?Math.max(0,Math.min(1,Number(metadata.opacity??1))):1;
   return '<img '+base+' alt="'+esc(clip.name)+'" src="'+esc(src)+'" style="display:none;z-index:'+trackIndex+';left:'+(x/state.timeline!.width*100)+'%;top:'+(y/state.timeline!.height*100)+'%;width:'+(w/state.timeline!.width*100)+'%;height:'+(h/state.timeline!.height*100)+'%;opacity:'+opacity+'">';
  }
  return '<video '+base+' playsinline preload="metadata" src="'+esc(src)+'" style="display:none;z-index:'+trackIndex+'"></video>';
 }).join(""):"").join(""):"";
 return '<section class="panel timeline-playback" id="timeline-playback"><div class="timeline-panel-heading"><div><div class="eyebrow">PROGRAM MONITOR · MULTI-TRACK TRANSPORT</div><h3>Sequence playback</h3></div><span class="muted">'+(state.mode==="local"?"LOCAL MEDIA":"PRIVATE CLOUD MEDIA")+'</span></div>'+'<div class="timeline-preview-stage" style="aspect-ratio:'+state.timeline.width+'/'+state.timeline.height+'"><div class="timeline-preview-placeholder">'+(state.previewLoaded?"No active picture at this playhead position." :"Load preview media to synchronize picture and sound tracks.")+'</div>'+elements+'</div><div class="timeline-preview-transport"><button class="secondary" data-tl-action="preview-load" '+(state.previewLoading?'disabled':'')+'>'+(state.previewLoading?"Loading media…":state.previewLoaded?"Refresh media":"Load preview media")+'</button><button class="secondary" data-tl-action="preview-step-back" '+(!state.previewLoaded?'disabled':'')+'>−1 frame</button><button class="primary" data-tl-action="preview-play" '+(state.isPlaying||!state.previewLoaded?'disabled':'')+'>▶ Play</button><button class="secondary" data-tl-action="preview-pause" '+(!state.isPlaying?'disabled':'')+'>Pause</button><button class="secondary" data-tl-action="preview-step-forward" '+(!state.previewLoaded?'disabled':'')+'>+1 frame</button><output id="tl-preview-time">'+formatPlaybackTime(state.playheadFrame)+'</output></div><input id="tl-preview-seek" class="timeline-preview-seek" type="range" min="0" max="'+duration+'" step="1" value="'+Math.min(duration,Math.round(state.playheadFrame))+'" '+(!state.previewLoaded?'disabled':'')+'><div class="timeline-preview-meta"><span>00:00:00:00</span><span>'+formatPlaybackTime(duration)+'</span><span>'+fps().toFixed(3)+' fps</span></div><div class="timeline-preview-diagnostics" id="tl-preview-diagnostics">Sources 0 · proxies 0 · proxy fallbacks 0 · dropped frames 0/0 · stalls 0 · media errors 0</div><p class="muted">Active video, image overlays and dedicated audio clips follow one sequence clock. Verified source-linked proxies are preferred for playback; final renders continue using canonical originals. Browser seeking remains best-effort.</p></section>';
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
export function renderTimelineWorkspace(){
 return '<div id="timeline-workspace"><div class="timeline-toolbar"><label>Workspace <select id="tl-mode"><option value="local" '+(state.mode==="local"?"selected":"")+' >Local</option><option value="cloud" '+(state.mode==="cloud"?"selected":"")+' >Cloud project</option></select></label><label>Cloud project <select id="tl-cloud-project"><option value="">Select project</option>'+state.cloudProjects.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===state.cloudProjectId?'selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></label><label>Saved sequence <select id="tl-saved-sequence"><option value="">Current sequence</option>'+(state.mode==="cloud"?state.cloudTimelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""):state.timelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""))+'</select></label><button class="secondary" data-tl-create-cloud>＋ New cloud timeline</button><button class="secondary" data-tl-action="undo" '+(history.undo.length?'':'disabled')+'>↶ Undo</button><button class="secondary" data-tl-action="redo" '+(history.redo.length?'':'disabled')+'>↷ Redo</button>'+(state.mode==="cloud"&&state.timeline?'<button class="secondary" data-tl-action="revision-history">Revision history</button>':'')+'<button class="secondary" data-tl-action="duplicate-variant">Duplicate as variant</button><span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="ready"?"TIMELINE SAVED":state.status==="auth"?"SIGN IN REQUIRED":state.status==="offline"?"API OFFLINE":"LOADING")+'</span><button class="secondary" data-tl-action="refresh">↻ Refresh</button><button class="secondary" data-tl-action="export">Export OTIO JSON</button>'+(state.mediaJobId?'<button class="secondary" data-tl-action="media-job-check">Check media job</button>':'')+(state.mode==="cloud"&&state.cloudRenderJobId?'<button class="secondary" data-tl-action="cloud-job">Check cloud render · '+esc(state.cloudRenderJobStatus||"queued")+'</button>':'')+''+(state.ffmpeg?'<button class="primary" data-tl-action="render">Render master MP4</button>':'<span class="muted">FFmpeg required for master render</span>')+'</div>'+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+(state.recoveredDraft?'<section class="panel timeline-quality"><div class="eyebrow">BROWSER RECOVERY · '+(state.recoveryStatus==="conflict"?"REVISION CONFLICT":"UNSAVED DRAFT")+'</div><p>'+esc(state.recoveryStatus==="conflict"?"Recovered edits are based on server revision "+state.recoveredDraft.baseRevision+", while the current server revision is "+state.serverRevision+". The server timeline has not been replaced.":"Recovered unsaved edits from browser storage. Review them before continuing.")+'</p><div class="toolbar">'+(state.recoveryStatus==="conflict"?'<button class="primary" data-tl-action="restore-recovered-variant">Save recovered edits as a new variant</button>':'<button class="primary" data-tl-action="save-recovered-draft">Save recovered edits</button>')+'<button class="secondary" data-tl-action="discard-recovered-draft">Discard recovered draft</button></div></section>':"")+
 '<div class="timeline-editor-grid"><section class="panel"><div class="eyebrow">SEQUENCE SETTINGS</div><h3>'+(state.timeline?esc(state.timeline.name):"No sequence loaded")+'</h3>'+
 '<form id="tl-add-track"><label>Track name</label><input name="name" required placeholder="Video 2 / Music / Captions"><label>Track type</label><select name="kind"><option value="video">Video</option><option value="audio">Audio</option><option value="overlay">Overlay</option><option value="caption">Captions</option></select><button class="secondary">＋ Add track</button></form>'+
 '<div class="eyebrow" style="margin-top:18px">CLOUD AUDIO MASTERING</div>'+(state.mode==="cloud"?'<form id="tl-audio-mastering" class="timeline-mastering-form"><label class="inline-check"><input name="enabled" type="checkbox" '+(state.timeline?.audioMastering?.enabled===true?'checked':'')+'> Enable loudness mastering</label><label class="inline-check"><input name="dualMono" type="checkbox" '+(state.timeline?.audioMastering?.dualMono===true?'checked':'')+'> Treat mono sources as dual-mono</label><label>Mastering profile</label><select name="profile"><option value="web-podcast" '+(state.timeline?.audioMastering?.profile!=="ebu-r128"&&state.timeline?.audioMastering?.profile!=="custom"?"selected":"")+ '>Web / Podcast (-16 LUFS)</option><option value="ebu-r128" '+(state.timeline?.audioMastering?.profile==="ebu-r128"?"selected":"")+ '>EBU R128 broadcast (-23 LUFS)</option><option value="custom" '+(state.timeline?.audioMastering?.profile==="custom"?"selected":"")+ '>Custom target</option></select><div class="form-grid"><div><label>Integrated loudness (LUFS)</label><input name="integratedLoudness" type="number" min="-70" max="-5" step="0.1" value="'+Number(state.timeline?.audioMastering?.integratedLoudness??-16)+'" '+(state.timeline?.audioMastering?.profile==="custom"?"":"disabled")+' aria-describedby="tl-mastering-profile-help"></div><div><label>Loudness range (LU)</label><input name="loudnessRange" type="number" min="1" max="50" step="0.1" value="'+Number(state.timeline?.audioMastering?.loudnessRange??11)+'"></div><div><label>True peak (dBTP)</label><input name="truePeak" type="number" min="-9" max="0" step="0.1" value="'+Number(state.timeline?.audioMastering?.truePeak??-1.5)+'"></div></div><button class="secondary" type="submit">Save mastering settings</button><small id="tl-mastering-profile-help" class="muted">Applied by cloud rendering only. Web / Podcast enforces -16 LUFS; EBU R128 enforces -23 LUFS. The integrated loudness target is editable only for Custom. LRA and true peak remain editable for every profile; the renderer validates all targets again.</small></form>':'<p class="muted">Switch to a cloud project to configure EBU R128 mastering. Local rendering is unchanged.</p>')+
 '<div class="eyebrow" style="margin-top:18px">ADD SOURCE CLIP</div><form id="tl-add-clip"><label>Source asset</label><select id="tl-asset-select" name="assetId" required>'+assetOptions()+'</select><label>Destination track</label><select name="trackId">'+(state.timeline?.tracks.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join("")||"")+'</select><div class="form-grid"><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+maxEnd()+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="0"></div><div><label>Duration (timeline frames)</label><input name="duration" type="number" min="1" value="'+(fps()*5)+'"></div></div><button class="primary wide">＋ Place clip on timeline</button></form>'+
 '<form id="tl-add-marker"><div class="eyebrow" style="margin-top:18px">REVIEW MARKER</div><label>Marker title</label><input name="name" required placeholder="Hook / transition / review note"><label>Position (frames)</label><input name="frame" type="number" min="0" value="0"><button class="secondary">＋ Add marker</button></form></section>'+
 '<section class="panel"><div class="timeline-panel-heading"><div><div class="eyebrow">MULTI-TRACK EDITOR</div><h3>Sequence timeline</h3></div><small>'+(state.timeline?.frameRate.numerator+"/"+state.timeline?.frameRate.denominator+" fps")+'</small></div>'+
 (state.timeline?timelineCanvas():'<div class="empty">Sign in and create a sequence to begin.</div>')+
 timelinePlaybackPanel()+clipInspector()+variantComparisonPanel()+timelineRevisionPanel()+creativeTraceabilityPanel()+timelineQualityPanel()+
  '<div class="timeline-marker-list">'+(state.timeline?.markers.map(m=>'<span>◆ '+esc(m.name)+' · '+Math.round(m.start.value)+'f</span>').join("")||"No review markers yet.")+'</div></section></div>'+
 '<div class="notice">Master rendering now supports synchronized audio mixing, image overlays and burned-in SRT/VTT captions. Frame preview/playback, transitions, effects, animated overlays and video-on-video compositing remain future milestones.</div></div>';
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
 const recoveryDraft=await saveRecoveryDraft("timeline-edit");
 const otio=toOpenTimelineIo(state.timeline);
 if(state.mode==="cloud"){
  const result=await apiRequest<{timeline:CloudSavedTimeline}>("/api/cloud/timelines/"+state.timeline.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({expectedRevision:state.serverRevision,timeline:state.timeline,otio})});
  state.serverRevision=result.timeline.revision;state.timeline={...state.timeline,revision:result.timeline.revision};state.status="ready";state.message="Saved cloud revision "+result.timeline.revision+".";await completeRecoveryCheckpoint(recoveryDraft,result.timeline.revision);return;
 }
 const result=await apiRequest<{revision:number}>("/api/timelines/"+state.timeline.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:state.serverRevision,name:state.timeline.name,timeline:state.timeline,otio})});
 state.serverRevision=result.revision;state.timeline={...state.timeline,revision:result.revision};state.status="ready";state.message="Saved revision "+result.revision+".";await completeRecoveryCheckpoint(recoveryDraft,result.revision);
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
 try{await requestPersistentBrowserStorage();await refresh();await restoreTimelineRecovery();}catch(error){state.status=error instanceof Error&&error.message.includes("Sign in")?"auth":"offline";state.message=error instanceof Error?error.message:"Timeline service unavailable.";}
 paint();
}
function paint(){const root=document.querySelector<HTMLElement>("#timeline-workspace");if(root)root.outerHTML=renderTimelineWorkspace();if(state.previewLoaded){syncPreviewAtFrame(state.playheadFrame);updatePreviewDiagnostics();}}
async function runAction(action:HTMLElement){
 const type=action.dataset.tlAction||"";
 if(type==="save-recovered-draft"){
  try{await persist();state.recoveredDraft=null;state.message="Recovered edits saved as a new server revision.";}
  catch(error){state.message=error instanceof Error?error.message:"Recovered draft could not be saved.";}
  paint();return;
 }
 if(type==="discard-recovered-draft"){
  try{if(state.recoveredDraft)await recoveryStore().clearDraft(state.recoveredDraft.key);state.recoveredDraft=null;state.recoveryStatus="idle";state.message="Recovered browser draft discarded. The server timeline was left unchanged.";}
  catch(error){state.message=error instanceof Error?error.message:"Could not discard recovered draft.";}
  paint();return;
 }
 if(type==="restore-recovered-variant"){
  if(!state.recoveredDraft){state.message="There is no recovered draft to restore.";paint();return;}
  const recovered=state.recoveredDraft;
  try{state.timeline=structuredClone(recovered.snapshot);await duplicateTimelineVariant();await recoveryStore().clearDraft(recovered.key);state.recoveredDraft=null;state.recoveryStatus="saved";state.message="Recovered edits saved as an independent timeline variant. The newer server revision was preserved.";}
  catch(error){state.message=error instanceof Error?error.message:"Recovered edits could not be saved as a variant.";}
  paint();return;
 }
 if(type==="preview-load"){releaseTimelinePreview();state.previewLoading=true;paint();try{await loadTimelinePreview();}catch(error){state.message=error instanceof Error?error.message:"Preview media could not be loaded.";}paint();return;}
 if(type==="preview-play"){try{await startTimelinePlayback();}catch(error){state.message=error instanceof Error?error.message:"Playback could not start.";}paint();return;}
 if(type==="preview-pause"){stopTimelinePlayback();syncPreviewAtFrame(state.playheadFrame);paint();return;}
 if(type==="preview-step-back"){stepTimelineFrame(-1);paint();return;}
 if(type==="preview-step-forward"){stepTimelineFrame(1);paint();return;}
 if(type==="refresh"){await refresh();paint();return;}
 if(type==="undo"&&state.timeline&&history.undo.length){history.redo.push(structuredClone(state.timeline));state.timeline=history.undo.pop()!;state.message="Restoring previous edit…";try{await persist();}catch(error){state.message=error instanceof Error?error.message:"Undo could not be saved.";}paint();return;}
 if(type==="redo"&&state.timeline&&history.redo.length){history.undo.push(structuredClone(state.timeline));state.timeline=history.redo.pop()!;state.message="Reapplying edit…";try{await persist();}catch(error){state.message=error instanceof Error?error.message:"Redo could not be saved.";}paint();return;}
 if(type==="revision-history"){try{await loadRevisionHistory();}catch(error){state.message=error instanceof Error?error.message:"Could not load revision history.";}paint();return;}
 if(type==="close-revision-history"){state.revisionHistoryOpen=false;state.historyCompareTimeline=null;state.historyComparison=null;paint();return;}
 if(type==="compare-revision"||type==="restore-revision"){
  if(state.mode!=="cloud"||!state.timeline){state.message="Open a cloud timeline to use revision history.";paint();return;}
  const revision=Number(action.dataset.revision);
  if(!Number.isSafeInteger(revision)||revision<1){state.message="Invalid timeline revision.";paint();return;}
  try{
   const result=await apiRequest<{revision:TimelineRevisionSnapshot}>("/api/cloud/timelines/"+encodeURIComponent(state.timeline.id)+"/revisions/"+revision);
   const snapshot=result.revision;
   if(type==="compare-revision"){
    state.historyCompareTimeline=snapshot.timeline;
    state.historyComparison=compareTimelineVariants(snapshot.timeline,state.timeline);
    state.selectedHistoryRevision=revision;
    state.message="Compared saved revision "+revision+" with current revision "+state.serverRevision+".";
   }else{
    if(revision===state.serverRevision){state.message="This is already the current revision.";paint();return;}
    if(!window.confirm("Restore revision "+revision+"? This creates a new revision and preserves the current version in history."))return;
    const current=state.timeline;
    state.timeline={...structuredClone(snapshot.timeline),id:current.id,projectId:current.projectId,name:current.name,revision:state.serverRevision,createdAt:current.createdAt,updatedAt:new Date().toISOString(),metadata:{...snapshot.timeline.metadata,restoredFromRevision:revision,restoredAt:new Date().toISOString()}};
    await persist();
    await refresh();
    await loadRevisionHistory();
    state.message="Restored revision "+revision+" as new revision "+state.serverRevision+". Previous revisions remain available.";
   }
  }catch(error){state.message=error instanceof Error?error.message:"Revision history action failed.";}
  paint();return;
 }

 if(type==="cloud-job"&&state.cloudRenderJobId){try{const result=await apiRequest<{job:{id:string;status:string;progress?:number;output?:{outputAsset?:{id:string;name?:string}}}}>("/api/cloud/jobs/"+state.cloudRenderJobId);state.cloudRenderJobStatus=result.job.status;state.message="Cloud render "+result.job.status+" · "+Number(result.job.progress||0)+"%"+(result.job.output?.outputAsset?.id?" · output asset "+result.job.output.outputAsset.id:"");if(result.job.status==="succeeded")await refresh();}catch(error){state.message=error instanceof Error?error.message:"Could not refresh cloud render status.";}paint();return;}
 if(type==="render"){
  if(!state.timeline||!state.ffmpeg){state.message="FFmpeg is required to render a master file.";paint();return;}
  try{
   await persist();
   if(state.mode==="cloud"){const queued=await apiRequest<{job:{id:string;status:string}}>("/api/cloud/timelines/"+state.timeline.id+"/render",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({})});state.cloudRenderJobId=queued.job.id;state.cloudRenderJobStatus=queued.job.status;}else await apiRequest("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType:"timeline.render",timelineId:state.timeline.id,projectId:state.timeline.projectId||undefined})});
   state.message=state.mode==="cloud"?"Cloud master render queued. Check Cloud Projects for durable job status.":"Master render queued. Check Production Operations for progress and the finished MP4.";
   window.dispatchEvent(new Event("ev:jobs-updated"));
  }catch(error){state.message=error instanceof Error?error.message:"Render could not be queued.";}
  paint();return;
 }
 if(type==="duplicate-variant"){try{await duplicateTimelineVariant();}catch(error){state.message=error instanceof Error?error.message:"Could not create timeline variant.";}paint();return;} 
 if(type==="media-job-check"&&state.mediaJobId){
  try{
   const result=await apiRequest<{job:{status:string;progress?:number;output?:{outputAsset?:{id:string;name?:string;sha256?:string}};error?:{message?:string}}}>((state.mode==="cloud"?"/api/cloud/jobs/":"/api/jobs/")+state.mediaJobId);
   state.message="Media job "+result.job.status+" · "+Number(result.job.progress||0)+"%";
   if(result.job.status==="succeeded"){
    const output=result.job.output?.outputAsset;if(!output?.id)throw new Error("The completed media job did not return an output asset.");
    const kind=state.mediaJobType,clipId=state.mediaClipId;await refresh();
    if(kind==="media.proxy"){
     const track=state.timeline?.tracks.find(item=>item.clips.some(clip=>clip.id===clipId)),clip=track?.clips.find(item=>item.id===clipId);
     if(!clip)throw new Error("The source clip is no longer in the selected timeline. The proxy remains in your asset library.");
     clip.metadata={...clip.metadata,proxyAssetId:output.id,proxyAssetName:output.name||"Editing proxy",proxyAssetSha256:output.sha256||"",proxyProfile:"timeline-preview-960p"};
     await persist();
     if(state.mode==="cloud"){
      const proxyAsset=state.assets.find(item=>item.id===output.id);
      if(!proxyAsset)throw new Error("The completed cloud proxy is not visible in the private asset library yet.");
      await previewUrlForAsset(proxyAsset);
      state.message="Private cloud proxy generated, linked to this clip and verified for preview. Master renders still use the original source.";
     }else{
      const blob=await apiRequestBlob("/api/assets/"+encodeURIComponent(output.id)+"/file");
      if(state.proxyPreviewUrl)URL.revokeObjectURL(state.proxyPreviewUrl);
      state.proxyPreviewUrl=URL.createObjectURL(blob);
      state.message="Proxy generated, linked to this clip and loaded for preview. Master renders still use the original source.";
     }
    }else{
     if(state.mode==="cloud"){
      const thumbnailAsset=state.assets.find(item=>item.id===output.id);
      if(!thumbnailAsset)throw new Error("The completed private thumbnail is not visible in the asset library yet.");
      state.previewFrameUrl=await previewUrlForAsset(thumbnailAsset);
     }else{
      const blob=await apiRequestBlob("/api/assets/"+encodeURIComponent(output.id)+"/file");
      if(state.previewFrameUrl.startsWith("blob:"))URL.revokeObjectURL(state.previewFrameUrl);
      state.previewFrameUrl=URL.createObjectURL(blob);
     }
     state.message="Private source-frame thumbnail extracted and loaded into the clip preview.";
    }
    state.mediaJobId="";state.mediaJobType="";
   }else if(result.job.status==="failed"||result.job.status==="cancelled"){
    state.message=result.job.error?.message||("Media job "+result.job.status+".");state.mediaJobId="";state.mediaJobType="";
   }
  }catch(error){state.message=error instanceof Error?error.message:"Could not check media job.";}
  paint();return;
 }
 if(type==="preview-proxy"){
  const clip=state.timeline?.tracks.flatMap(track=>track.clips).find(item=>item.id===action.dataset.clip);
  const proxyId=typeof clip?.metadata?.proxyAssetId==="string"?clip.metadata.proxyAssetId:"";
  if(!proxyId){state.message="Generate a proxy before previewing this clip.";paint();return;}
  try{if(state.mode==="cloud"){const asset=state.assets.find(item=>item.id===proxyId);if(!asset)throw new Error("The private proxy asset is not available in this project.");await previewUrlForAsset(asset);}else{const blob=await apiRequestBlob("/api/assets/"+encodeURIComponent(proxyId)+"/file");if(state.proxyPreviewUrl)URL.revokeObjectURL(state.proxyPreviewUrl);state.proxyPreviewUrl=URL.createObjectURL(blob);}state.mediaClipId=clip!.id;state.message="Proxy preview loaded. Original media remains the master-render source.";}catch(error){state.message=error instanceof Error?error.message:"Proxy preview could not be loaded."; }
  paint();return;
 }
 if(type==="generate-proxy"||type==="generate-frame-preview"){
  const timeline=state.timeline;
  if(state.mode==="cloud"){
   if(!timeline){state.message="Open a timeline before creating a proxy or frame preview.";paint();return;}
   const clipId=action.dataset.clip||"",clip=timeline.tracks.flatMap(track=>track.clips).find(item=>item.id===clipId),asset=clip?state.assets.find(item=>item.id===clip.assetId):null;
   if(!clip||!asset||!asset.mediaType.startsWith("video/")){state.message="Select a cloud video clip with an accessible source asset.";paint();return;}
   try{
    const frameInput=document.querySelector<HTMLInputElement>("#tl-preview-source-frame");
    const sourceFrame=Math.max(0,Math.min(100000000,Number(frameInput?.value??clip.sourceRange.start.value)||0));
    const seconds=Math.min(3600,sourceFrame/sourceRate(asset,"video"));
    const operation=type==="generate-proxy"?"proxy":"thumbnail";
    const queued=await apiRequest<{job:{id:string;status:string}}>("/api/cloud/assets/"+encodeURIComponent(asset.id)+"/media-jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify(operation==="proxy"?{operation}:{operation,seconds})});
    state.mediaJobId=queued.job.id;state.mediaJobType=operation==="proxy"?"media.proxy":"media.thumbnail";state.mediaClipId=clipId;state.message=operation==="proxy"?"Private cloud editing proxy queued. Original source remains unchanged.":"Private cloud frame thumbnail queued.";
    window.dispatchEvent(new Event("ev:jobs-updated"));
   }catch(error){state.message=error instanceof Error?error.message:"Cloud preview job could not be queued.";}
   paint();return;
  }
  if(!timeline){state.message="Open a timeline before creating a proxy or frame preview.";paint();return;}
  const clipId=action.dataset.clip||"",clip=timeline.tracks.flatMap(track=>track.clips).find(item=>item.id===clipId),asset=clip?state.assets.find(item=>item.id===clip.assetId):null;
  if(!clip||!asset||!asset.mediaType.startsWith("video/")){state.message="Select a video clip with an accessible source asset.";paint();return;}
  try{
   const jobType=type==="generate-proxy"?"media.proxy":"media.thumbnail";
   const frameInput=document.querySelector<HTMLInputElement>("#tl-preview-source-frame");
   const sourceFrame=Math.max(0,Math.min(100000000,Number(frameInput?.value??clip.sourceRange.start.value)||0));
   const seconds=sourceFrame/sourceRate(asset,"video");
   const body=jobType==="media.proxy"?{jobType,sourceAssetId:asset.id,projectId:timeline.projectId||undefined,container:"mp4",videoCodec:"libx264",audioCodec:"aac",preset:"veryfast",proxyWidth:960,proxyCrf:28,proxyProfile:"timeline-preview-960p"}:{jobType,sourceAssetId:asset.id,projectId:timeline.projectId||undefined,seconds};
   const queued=await apiRequest<{job:{id:string;status:string}}>("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify(body)});
   state.mediaJobId=queued.job.id;state.mediaJobType=jobType;state.mediaClipId=clipId;state.message=(jobType==="media.proxy"?"960p editing proxy":"Frame preview")+" queued. Use Check media job to attach or load the output.";
   window.dispatchEvent(new Event("ev:jobs-updated"));
  }catch(error){state.message=error instanceof Error?error.message:"Media job could not be queued.";}
  paint();return;
 }

 if(!state.timeline)return;
 const trackId=action.dataset.track||"",clipId=action.dataset.clip||"";
 if(type==="split"){
  recordUndo();const track=state.timeline.tracks.find(t=>t.id===trackId),clip=track?.clips.find(c=>c.id===clipId);if(!track||!clip)return;
  const splitAt=Math.round(clip.timelineStart.value+clip.duration.value/2);
  state.timeline=splitClip(state.timeline,trackId,clipId,splitAt,crypto.randomUUID());
 }else if(type==="trim"){recordUndo();state.timeline=trimClip(state.timeline,trackId,clipId,12,12);}
 else if(type==="move"){
  recordUndo();const from=state.timeline.tracks.findIndex(t=>t.id===trackId);const target=state.timeline.tracks[(from+1)%state.timeline.tracks.length];if(!target)return;
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
 if(form.id==="tl-audio-mastering"){
  event.preventDefault();
  if(state.mode!=="cloud"){state.message="Audio mastering controls are available for cloud rendering only.";paint();return;}
  const data=new FormData(form);
  let mastering;
  try{mastering=normalizeAudioMasteringSettings({enabled:data.get("enabled")==="on",profile:data.get("profile"),integratedLoudness:data.get("integratedLoudness"),loudnessRange:data.get("loudnessRange"),truePeak:data.get("truePeak"),dualMono:data.get("dualMono")==="on"});}
  catch(error){state.message=error instanceof Error?error.message:"Mastering settings are invalid.";paint();return;}
  recordUndo();state.timeline.audioMastering=mastering;
  state.message="Saving cloud audio mastering settings…";
  void persist().then(()=>{state.message="Cloud audio mastering settings saved to this timeline revision.";paint();}).catch(error=>{state.message=error instanceof Error?error.message:"Mastering settings could not be saved.";paint();});
  return;
 }
 if(form.id==="tl-add-track"){
  event.preventDefault();const data=new FormData(form),name=String(data.get("name")||"").trim(),kind=String(data.get("kind")||"video") as TimelineTrack["kind"];
  if(!name)return;
  recordUndo();state.timeline=addTrack(state.timeline,{id:crypto.randomUUID(),name,kind,enabled:true,locked:false,clips:[]});
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
  recordUndo();const sourceFps=sourceRate(asset,destination?.kind||"video");
  const sourceDuration=duration/fps()*sourceFps;
  try{state.timeline=addClip(state.timeline,trackId,{id:crypto.randomUUID(),assetId,name:asset.name,sourceRange:{start:rational(sourceIn,sourceFps),duration:rational(sourceDuration,sourceFps)},timelineStart:rational(start,fps()),duration:rational(duration,fps()),enabled:true});}
  catch(error){alert(error instanceof Error?error.message:String(error));return;}
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
 if(form.id==="tl-clip-inspector"){
  event.preventDefault();const data=new FormData(form),trackId=form.dataset.track||"",clipId=form.dataset.clip||"";
  const track=state.timeline.tracks.find(item=>item.id===trackId),clip=track?.clips.find(item=>item.id===clipId);if(!track||!clip)return;
  const asset=state.assets.find(item=>item.id===clip.assetId);if(!asset)return;
  recordUndo();const start=Math.max(0,Number(data.get("start"))||0),duration=Math.max(1,Number(data.get("duration"))||1),sourceIn=Math.max(0,Number(data.get("sourceIn"))||0),sourceFps=sourceRate(asset,track.kind);
  clip.name=String(data.get("name")||clip.name).trim()||clip.name;
  clip.timelineStart=rational(start,fps());clip.duration=rational(duration,fps());
  clip.sourceRange={start:rational(sourceIn,sourceFps),duration:rational(duration/fps()*sourceFps,sourceFps)};
  if(track.kind==="video")clip.metadata={...clip.metadata,timelineEffects:{brightness:Math.max(-0.5,Math.min(0.5,Number(data.get("effectBrightness"))||0)),contrast:Math.max(0.5,Math.min(2,Number(data.get("effectContrast"))||1)),saturation:Math.max(0,Math.min(2,Number(data.get("effectSaturation"))||1)),denoise:Math.max(0,Math.min(10,Number(data.get("effectDenoise"))||0)),sharpen:Math.max(0,Math.min(1,Number(data.get("effectSharpen"))||0))}};
  if(track.kind==="audio")clip.gainDb=Math.max(-60,Math.min(24,Number(data.get("gainDb"))||0));
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
  event.preventDefault();const data=new FormData(form);recordUndo();
  state.timeline=addMarker(state.timeline,{id:crypto.randomUUID(),name:String(data.get("name")),start:rational(Math.max(0,Number(data.get("frame"))||0),fps()),color:"YELLOW"});
  void persist().then(paint).catch(error=>{state.message=error.message;paint();});
 }
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLSelectElement;
 if(target.name==="profile"&&target.form?.id==="tl-audio-mastering"){
  const loudness=target.form.querySelector<HTMLInputElement>('input[name="integratedLoudness"]');
  if(loudness){loudness.disabled=target.value!=="custom";loudness.setAttribute("aria-disabled",String(loudness.disabled));}
 }
 if(target.id==="tl-mode"){history.timelineId="";history.undo=[];history.redo=[];releaseTimelinePreview();state.mode=target.value==="cloud"?"cloud":"local";state.timeline=null;state.selectedClipId="";state.revisionHistoryOpen=false;state.revisionHistory=[];state.historyComparison=null;state.historyCompareTimeline=null;void refresh().then(paint).catch(error=>{state.status="offline";state.message=error instanceof Error?error.message:"Workspace unavailable.";paint();});}
 if(target.id==="tl-cloud-project"){history.timelineId="";history.undo=[];history.redo=[];releaseTimelinePreview();state.cloudProjectId=target.value;state.timeline=null;state.selectedClipId="";state.revisionHistoryOpen=false;state.revisionHistory=[];state.historyComparison=null;state.historyCompareTimeline=null;void refresh().then(paint).catch(error=>{state.status="offline";state.message=error instanceof Error?error.message:"Cloud project unavailable.";paint();});}
 if(target.id==="tl-saved-sequence"&&target.value){
  const saved=state.mode==="cloud"?state.cloudTimelines.find(t=>t.id===target.value):state.timelines.find(t=>t.id===target.value);
  if(saved){history.timelineId=saved.id;history.undo=[];history.redo=[];releaseTimelinePreview();state.revisionHistoryOpen=false;state.revisionHistory=[];state.historyComparison=null;state.historyCompareTimeline=null;if(state.mode==="cloud"){const cloud=saved as CloudSavedTimeline;state.timeline=cloud.timeline;state.serverRevision=cloud.revision;void loadVariantComparison().then(paint);}
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
function isTimelinePreviewMediaEvent(event:Event){
 const target=event.target;
 return (target instanceof HTMLMediaElement||target instanceof HTMLImageElement)&&Boolean(target.closest("#timeline-playback"));
}
document.addEventListener("waiting",event=>{
 if(!isTimelinePreviewMediaEvent(event))return;
 state.previewDiagnostics.stalls++;updatePreviewDiagnostics();
},true);
document.addEventListener("error",event=>{
 if(!isTimelinePreviewMediaEvent(event))return;
 const media=event.target as HTMLMediaElement,assetId=media.dataset.previewAsset||"";
 state.previewDiagnostics.errors++;
 const failedAsset=state.assets.find(asset=>asset.id===assetId);
 if(failedAsset&&shouldRetryTimelinePreviewUrl(state.mode,assetId,state.previewRefreshAttemptedAssetIds)){
  state.previewRefreshAttemptedAssetIds.push(assetId);
  delete state.previewAssetUrls[assetId];delete state.previewAssetUrlExpiresAt[assetId];
  void previewUrlForAsset(failedAsset).then(()=>paint()).catch(()=>fallbackToOriginalPreview(media));
  updatePreviewDiagnostics();return;
 }
 fallbackToOriginalPreview(media);
 updatePreviewDiagnostics();
},true);
function fallbackToOriginalPreview(media:HTMLMediaElement){
 if(media.dataset.previewProxy!=="true"){state.message="The original source preview could not be loaded after one signed-URL refresh. Check private asset access and media availability.";paint();return;}
 const clipId=media.dataset.previewClip||"",clip=state.timeline?.tracks.flatMap(track=>track.clips).find(item=>item.id===clipId);
 const source=clip?state.assets.find(asset=>asset.id===clip.assetId):undefined;
 const proxy=clip&&source?selectTimelinePreviewAsset(clip,source,state.assets):undefined;
 if(!source||!proxy||!shouldFallbackToTimelineSourcePreview(media.dataset.previewProxy==="true",source.id,proxy.id,state.previewUnavailableAssetIds))return;
 state.previewUnavailableAssetIds.push(proxy.id);state.previewDiagnostics.proxyFallbacks++;
 void previewUrlForAsset(source).then(()=>{state.message="Editing proxy unavailable; playback has fallen back to the original private source.";paint();}).catch(()=>{state.message="Both the linked proxy and original source could not be loaded. Check private asset access.";paint();});
}
document.addEventListener("input",event=>{
 const target=event.target as HTMLInputElement;
 if(target.id==="tl-preview-seek"&&state.timeline&&state.previewLoaded){
  stopTimelinePlayback();syncPreviewAtFrame(Number(target.value));
  const output=document.querySelector<HTMLElement>("#tl-preview-time");if(output)output.textContent=formatPlaybackTime(state.playheadFrame);
 }
});
document.addEventListener("click",event=>{
 const create=(event.target as HTMLElement).closest<HTMLElement>("[data-tl-create-cloud]");if(create){void createCloudTimeline().catch(error=>{state.message=error instanceof Error?error.message:"Cloud timeline creation failed.";paint();});return;}
 const target=event.target as HTMLElement,select=target.closest<HTMLElement>("[data-tl-select]");
 if(select&&state.timeline){state.selectedTrack=select.dataset.track||"";state.selectedClipId=select.dataset.clip||"";paint();}
 const action=target.closest<HTMLElement>("[data-tl-action]");
 if(action)void runAction(action);
});
window.addEventListener("ev:authenticated",()=>void initTimelineWorkspace());
window.addEventListener("beforeunload",()=>releaseTimelinePreview());
window.addEventListener("ev:assets-updated",()=>{releaseTimelinePreview();void refresh().then(paint).catch(error=>{state.message=error.message;paint();});});
