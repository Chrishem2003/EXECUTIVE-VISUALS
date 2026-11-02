import { apiRequest } from "../core/api";
import { analyzeTimelineQuality } from "../core/timeline-quality";
import { buildProductionReadinessReport } from "../core/production-readiness";
import { analyzeCreativeTraceability, readCreativeTrace } from "../core/creative-traceability";
import { appendCreativeDecision, readCreativeDecisionHistory } from "../core/creative-decision-ledger";
import { compareTimelineVariants, createTimelineVariant, type TimelineVariantComparison } from "../core/timeline-variants";
import { addClip, addMarker, addTrack, createTimeline, moveClip, rational, splitClip, toOpenTimelineIo, trimClip, type EditorialTimeline, type TimelineTrack } from "../core/timeline";

type Asset={id:string;name:string;mediaType:string;size:number;metadata?:Record<string,unknown>};
type SavedTimeline={id:string;projectId?:string|null;name:string;revision:number;document?:EditorialTimeline};
type CloudProject={id:string;name:string};
type CloudSavedTimeline={id:string;projectId?:string|null;name:string;revision:number;timeline:EditorialTimeline;updatedAt:string};
const state:{timeline:EditorialTimeline|null;serverRevision:number;timelines:SavedTimeline[];cloudTimelines:CloudSavedTimeline[];cloudProjects:CloudProject[];cloudProjectId:string;mode:"local"|"cloud";cloudRenderJobId:string;cloudRenderJobStatus:string;variantBase:EditorialTimeline|null;variantReport:TimelineVariantComparison|null;variantBaseName:string;assets:Asset[];status:"loading"|"ready"|"offline"|"auth";message:string;selectedTrack:string;selectedClipId:string;ffmpeg:boolean}={
 timeline:null,serverRevision:0,timelines:[],cloudTimelines:[],cloudProjects:[],cloudProjectId:"",mode:"local",cloudRenderJobId:"",cloudRenderJobStatus:"",variantBase:null,variantReport:null,variantBaseName:"",assets:[],status:"loading",message:"Loading editorial workspace…",selectedTrack:"",selectedClipId:"",ffmpeg:false
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
 state.timeline.tracks.map(track=>'<div class="editor-track"><div class="editor-track-label"><b>'+esc(track.name)+'</b><small>'+esc(track.kind)+(track.locked?' · locked':'')+'</small></div><div class="editor-track-lane">'+track.clips.map(clip=>'<article class="editor-clip '+(state.selectedClipId===clip.id?'selected':'')+'" data-tl-select="true" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'" style="left:'+Math.max(0,clip.timelineStart.value/total*100)+'%;width:'+Math.max(4,clip.duration.value/total*100)+'%"><b>'+esc(clip.name)+'</b><small>'+esc(clip.assetId.slice(0,8))+' · '+Math.round(clip.duration.value)+'f</small><div class="editor-clip-actions"><button data-tl-action="split" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Split</button><button data-tl-action="trim" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Trim 12f</button><button data-tl-action="move" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Next track</button></div></article>').join("")+'</div></div>').join("");
}
function clipInspector(){
 if(!state.timeline||!state.selectedClipId)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its timing, gain or visual properties.</p></div>';
 const track=state.timeline.tracks.find(item=>item.clips.some(clip=>clip.id===state.selectedClipId));
 const clip=track?.clips.find(item=>item.id===state.selectedClipId);
 if(!track||!clip)return '<div class="timeline-clip-inspector"><div class="eyebrow">CLIP INSPECTOR</div><p class="muted">Select a clip on the timeline to edit its properties.</p></div>';
 const metadata=clip.metadata||{},trace=readCreativeTrace(clip)||{storyBeat:"",purpose:"",audiencePromise:"",proofReference:"",decisionNote:""},decisions=readCreativeDecisionHistory(clip),start=Math.round(clip.timelineStart.value),duration=Math.round(clip.duration.value),sourceIn=Math.round(clip.sourceRange.start.value);
 let specific="";
 if(track.kind==="audio")specific='<div><label>Gain (dB)</label><input name="gainDb" type="number" min="-60" max="24" step="0.5" value="'+esc(clip.gainDb??0)+'"></div>';
 if(track.kind==="overlay")specific='<div><label>X position</label><input name="x" type="number" min="0" value="'+esc(metadata.x??Math.max(0,(state.timeline.width||1920)-Math.round((state.timeline.width||1920)*0.24)-24))+'"></div><div><label>Y position</label><input name="y" type="number" min="0" value="'+esc(metadata.y??24)+'"></div><div><label>Width (px)</label><input name="width" type="number" min="16" value="'+esc(metadata.width??Math.round((state.timeline.width||1920)*0.24))+'"></div><div><label>Height (px)</label><input name="height" type="number" min="16" value="'+esc(metadata.height??Math.round((state.timeline.height||1080)*0.24))+'"></div><div><label>Opacity</label><input name="opacity" type="number" min="0" max="1" step="0.05" value="'+esc(metadata.opacity??1)+'"></div>';
 if(track.kind==="caption")specific='<div><label>Font family</label><input name="fontName" value="'+esc(metadata.fontName??"DejaVu Sans")+'"></div><div><label>Font size</label><input name="fontSize" type="number" min="12" max="72" value="'+esc(metadata.fontSize??28)+'"></div><div><label>Alignment</label><select name="alignment">'+[1,2,3,4,5,6,7,8,9].map(n=>'<option value="'+n+'" '+(Number(metadata.alignment??2)===n?'selected':'')+'>'+n+'</option>').join("")+'</select></div><div><label>Bottom margin</label><input name="marginV" type="number" min="0" max="240" value="'+esc(metadata.marginV??42)+'"></div>';
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
 const hasCaptionTrack=!!state.timeline?.tracks.some(track=>track.kind==="caption"&&track.enabled!==false&&track.clips.length>0);
 const hasAudioTrack=!!state.timeline?.tracks.some(track=>track.kind==="audio"&&track.enabled!==false&&track.clips.length>0);
 const missingPrimary=findings.some(item=>item.code==="NO_PRIMARY_VIDEO");
 const pictureGap=findings.some(item=>item.code==="PICTURE_GAP");
 const missingSource=findings.some(item=>item.code==="ASSET_NOT_IN_LIBRARY"||item.code==="SOURCE_RANGE_EXCEEDS_MEDIA");
 const report=buildProductionReadinessReport({checks:{
  sequence:{status:!hasTimeline?"not_run":missingPrimary?"blocked":pictureGap?"review":"passed",summary:!hasTimeline?"No sequence is loaded.":missingPrimary?"The sequence has no primary picture track.":pictureGap?"Primary picture contains a gap that needs review.":"A primary picture sequence is present with no detected gap."},
  source_media:{status:missingSource?"blocked":"not_run",summary:missingSource?"A source asset is missing or a selected range exceeds probed media duration.":"Full source integrity and decode checks have not been run for every asset."},
  captions:{status:!hasTimeline?"not_run":hasCaptionTrack?"passed":"review",summary:!hasTimeline?"No sequence is loaded.":hasCaptionTrack?"An enabled caption track contains clips.":"No caption track is present; confirm whether this delivery requires captions."},
  audio:{status:!hasTimeline?"not_run":hasAudioTrack?"passed":"review",summary:!hasTimeline?"No sequence is loaded.":hasAudioTrack?"An enabled audio track contains clips.":"No audio track is present; confirm whether silence is intentional."}
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
 '<small class="muted">Only sequence structure and visible track presence are assessed here. Source-media, shot-engine compatibility, continuity, rights, full caption validation, audio signal analysis and delivery checks remain not run until their evidence adapters are connected. This report does not grant approval, submit a provider request or render media.</small></section>';
}
export function renderTimelineWorkspace(){
 return '<div id="timeline-workspace"><div class="timeline-toolbar"><label>Workspace <select id="tl-mode"><option value="local" '+(state.mode==="local"?"selected":"")+' >Local</option><option value="cloud" '+(state.mode==="cloud"?"selected":"")+' >Cloud project</option></select></label><label>Cloud project <select id="tl-cloud-project"><option value="">Select project</option>'+state.cloudProjects.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===state.cloudProjectId?'selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></label><label>Saved sequence <select id="tl-saved-sequence"><option value="">Current sequence</option>'+(state.mode==="cloud"?state.cloudTimelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""):state.timelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""))+'</select></label><button class="secondary" data-tl-create-cloud>＋ New cloud timeline</button><button class="secondary" data-tl-action="duplicate-variant">Duplicate as variant</button><span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="ready"?"TIMELINE SAVED":state.status==="auth"?"SIGN IN REQUIRED":state.status==="offline"?"API OFFLINE":"LOADING")+'</span><button class="secondary" data-tl-action="refresh">↻ Refresh</button><button class="secondary" data-tl-action="export">Export OTIO JSON</button>'+(state.mode==="cloud"&&state.cloudRenderJobId?'<button class="secondary" data-tl-action="cloud-job">Check cloud render · '+esc(state.cloudRenderJobStatus||"queued")+'</button>':'')+''+(state.ffmpeg?'<button class="primary" data-tl-action="render">Render master MP4</button>':'<span class="muted">FFmpeg required for master render</span>')+'</div>'+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+
 '<div class="timeline-editor-grid"><section class="panel"><div class="eyebrow">SEQUENCE SETTINGS</div><h3>'+(state.timeline?esc(state.timeline.name):"No sequence loaded")+'</h3>'+
 '<form id="tl-add-track"><label>Track name</label><input name="name" required placeholder="Video 2 / Music / Captions"><label>Track type</label><select name="kind"><option value="video">Video</option><option value="audio">Audio</option><option value="overlay">Overlay</option><option value="caption">Captions</option></select><button class="secondary">＋ Add track</button></form>'+
 '<div class="eyebrow" style="margin-top:18px">ADD SOURCE CLIP</div><form id="tl-add-clip"><label>Source asset</label><select id="tl-asset-select" name="assetId" required>'+assetOptions()+'</select><label>Destination track</label><select name="trackId">'+(state.timeline?.tracks.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join("")||"")+'</select><div class="form-grid"><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+maxEnd()+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="0"></div><div><label>Duration (timeline frames)</label><input name="duration" type="number" min="1" value="'+(fps()*5)+'"></div></div><button class="primary wide">＋ Place clip on timeline</button></form>'+
 '<form id="tl-add-marker"><div class="eyebrow" style="margin-top:18px">REVIEW MARKER</div><label>Marker title</label><input name="name" required placeholder="Hook / transition / review note"><label>Position (frames)</label><input name="frame" type="number" min="0" value="0"><button class="secondary">＋ Add marker</button></form></section>'+
 '<section class="panel"><div class="timeline-panel-heading"><div><div class="eyebrow">MULTI-TRACK EDITOR</div><h3>Sequence timeline</h3></div><small>'+(state.timeline?.frameRate.numerator+"/"+state.timeline?.frameRate.denominator+" fps")+'</small></div>'+
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
function paint(){const root=document.querySelector<HTMLElement>("#timeline-workspace");if(root)root.outerHTML=renderTimelineWorkspace();}
async function runAction(action:HTMLElement){
 const type=action.dataset.tlAction||"";
 if(type==="refresh"){await refresh();paint();return;}
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
  if(track.kind==="audio")clip.gainDb=Math.max(-60,Math.min(24,Number(data.get("gainDb"))||0));
  if(track.kind==="overlay")clip.metadata={...clip.metadata,x:Number(data.get("x"))||0,y:Number(data.get("y"))||0,width:Math.max(16,Number(data.get("width"))||16),height:Math.max(16,Number(data.get("height"))||16),opacity:Math.max(0,Math.min(1,Number(data.get("opacity")??1)))};
  if(track.kind==="caption")clip.metadata={...clip.metadata,fontName:String(data.get("fontName")||"DejaVu Sans"),fontSize:Math.max(12,Math.min(72,Number(data.get("fontSize"))||28)),alignment:Math.max(1,Math.min(9,Number(data.get("alignment"))||2)),marginV:Math.max(0,Math.min(240,Number(data.get("marginV"))||42))};
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
document.addEventListener("change",event=>{
 const target=event.target as HTMLSelectElement;
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
document.addEventListener("click",event=>{
 const create=(event.target as HTMLElement).closest<HTMLElement>("[data-tl-create-cloud]");if(create){void createCloudTimeline().catch(error=>{state.message=error instanceof Error?error.message:"Cloud timeline creation failed.";paint();});return;}
 const target=event.target as HTMLElement,select=target.closest<HTMLElement>("[data-tl-select]");
 if(select&&state.timeline){state.selectedTrack=select.dataset.track||"";state.selectedClipId=select.dataset.clip||"";paint();}
 const action=target.closest<HTMLElement>("[data-tl-action]");
 if(action)void runAction(action);
});
window.addEventListener("ev:authenticated",()=>void initTimelineWorkspace());
window.addEventListener("ev:assets-updated",()=>void refresh().then(paint).catch(error=>{state.message=error.message;paint();}));
