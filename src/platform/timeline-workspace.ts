import { apiRequest } from "../core/api";
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
import { addClip, addMarker, addTrack, createTimeline, moveClip, rational, splitClip, toOpenTimelineIo, trimClip, type EditorialTimeline, type TimelineTrack } from "../core/timeline";
import { clampPreviewSeconds, decibelsToLinearGain, frameToSeconds, getTimelineDurationFrames, isPreviewTrackAudible, resolveTimelineFrame, resolveTimelineOverlays, secondsToFrame, stepPreviewSeconds } from "../core/timeline-preview";
import { activeCaptionCues, parseCaptionCues, type CaptionCue } from "../core/caption-preview";
import { validatePrivateMediaUrl } from "../core/private-media-url";

type Asset={id:string;name:string;mediaType:string;size:number;createdAt?:string;metadata?:Record<string,unknown>};
type SavedTimeline={id:string;projectId?:string|null;name:string;revision:number;document?:EditorialTimeline};
type CloudProject={id:string;name:string};
type CloudSavedTimeline={id:string;projectId?:string|null;name:string;revision:number;timeline:EditorialTimeline;updatedAt:string};
const state:{timeline:EditorialTimeline|null;serverRevision:number;timelines:SavedTimeline[];cloudTimelines:CloudSavedTimeline[];cloudProjects:CloudProject[];cloudProjectId:string;mode:"local"|"cloud";cloudRenderJobId:string;cloudRenderJobStatus:string;variantBase:EditorialTimeline|null;variantReport:TimelineVariantComparison|null;variantBaseName:string;assets:Asset[];status:"loading"|"ready"|"offline"|"auth";message:string;selectedTrack:string;selectedClipId:string;ffmpeg:boolean}={
 timeline:null,serverRevision:0,timelines:[],cloudTimelines:[],cloudProjects:[],cloudProjectId:"",mode:"local",cloudRenderJobId:"",cloudRenderJobStatus:"",variantBase:null,variantReport:null,variantBaseName:"",assets:[],status:"loading",message:"Loading editorial workspace…",selectedTrack:"",selectedClipId:"",ffmpeg:false
};
let sequencePlaying=false,sequenceFrame=0,sequenceStartFrame=0,sequenceStartAt=0,sequenceRaf:number|null=null;
type PreviewAudioNode={element:HTMLAudioElement;gain:GainNode;active:boolean;trackId:string;assetId:string};
const sequenceAudioNodes=new Map<string,PreviewAudioNode>();
const sequenceCaptionCache=new Map<string,Promise<CaptionCue[]>>();
const sequenceMediaUrlCache=new Map<string,{url?:string;expiresAt:number;pending?:Promise<string>}>();
let sequenceMediaProjectId="";
let sequenceMediaGeneration=0;
const sequenceMutedTrackIds=new Set<string>();
let sequenceSoloTrackId:string|null=null;
let sequenceAudioContext:AudioContext|null=null;
async function assetMediaUrl(asset:Asset):Promise<string>{
 if(state.mode!=="cloud")return "/api/assets/"+encodeURIComponent(asset.id)+"/file";
 const cached=sequenceMediaUrlCache.get(asset.id),now=Date.now();
 if(cached?.url&&cached.expiresAt>now)return cached.url;
 if(cached?.pending)return cached.pending;
 const entry=cached||{expiresAt:0},generation=sequenceMediaGeneration;
 const pending=apiRequest<{url:string;expiresIn:number}>("/api/cloud/assets/"+encodeURIComponent(asset.id)).then(result=>{
  if(generation!==sequenceMediaGeneration)throw new Error("Cloud media session changed; request a fresh preview URL.");
  const validated=validatePrivateMediaUrl(result.url,window.location.href,result.expiresIn);
  entry.url=validated.url;entry.expiresAt=validated.expiresAt;entry.pending=undefined;
  sequenceMediaUrlCache.set(asset.id,entry);return entry.url;
 }).catch(error=>{entry.pending=undefined;entry.url=undefined;if(sequenceMediaUrlCache.get(asset.id)===entry)sequenceMediaUrlCache.delete(asset.id);throw error;});
 entry.pending=pending;sequenceMediaUrlCache.set(asset.id,entry);return pending;
}
function clearSequenceAudio(){
 for(const node of sequenceAudioNodes.values()){node.element.pause();node.element.removeAttribute("src");node.element.load();node.gain.disconnect();}
 sequenceAudioNodes.clear();void sequenceAudioContext?.close();sequenceAudioContext=null;
}
function resetSequenceMediaCache(){
 sequenceMediaGeneration++;stopSequencePlayback();clearSequenceAudio();sequenceMediaUrlCache.clear();sequenceCaptionCache.clear();
}
function ensureSequenceAudioContext(){
 if(!sequenceAudioContext)sequenceAudioContext=new AudioContext();
 if(sequenceAudioContext.state==="suspended")void sequenceAudioContext.resume();
 return sequenceAudioContext;
}
function loadSequenceCaptionCues(asset:Asset):Promise<CaptionCue[]>{
 let pending=sequenceCaptionCache.get(asset.id);
 if(!pending){
  pending=(async()=>{
   const sourceUrl=await assetMediaUrl(asset);
   const response=await fetch(sourceUrl,{credentials:"same-origin"});
   if(!response.ok)throw new Error("Caption source could not be loaded ("+response.status+").");
   const declared=Number(response.headers.get("content-length")||0);
   if(declared>2*1024*1024)throw new Error("Caption source exceeds the 2 MB preview limit.");
   return parseCaptionCues(await response.text());
  })();
  sequenceCaptionCache.set(asset.id,pending);
  void pending.catch(()=>{if(sequenceCaptionCache.get(asset.id)===pending)sequenceCaptionCache.delete(asset.id);});
 }
 return pending;
}
function captionStyle(metadata:Record<string,unknown>,alignment:number){
 const fontName=String(metadata.fontName||"DejaVu Sans").replace(/[^A-Za-z0-9 _-]/g,"").slice(0,48)||"DejaVu Sans";
 const fontSize=Math.max(12,Math.min(96,Number(metadata.fontSize)||32));
 const primaryColor=/^#[0-9a-f]{6}$/i.test(String(metadata.primaryColor||""))?String(metadata.primaryColor):"#FFFFFF";
 const backgroundColor=/^#[0-9a-f]{6}$/i.test(String(metadata.backgroundColor||""))?String(metadata.backgroundColor):"#000000";
 const opacity=Math.max(0,Math.min(1,Number(metadata.backgroundOpacity??0.68)));
 const outline=Math.max(0,Math.min(8,Number(metadata.outline??2)));
 const shadow=Math.max(0,Math.min(8,Number(metadata.shadow??1)));
 const marginV=Math.max(0,Math.min(240,Number(metadata.marginV??42)));
 const row=3-Math.floor((alignment-1)/3),column=((alignment-1)%3)+1;
 return {fontName,fontSize,primaryColor,backgroundColor,opacity,outline,shadow,marginV,row,column,backgroundMode:metadata.backgroundMode==="none"?"none":"box"};
}
async function syncSequenceCaptions(frame:number){
 const layer=document.querySelector<HTMLElement>("#tl-sequence-caption-layer");
 if(!layer||!state.timeline)return;
 const timeline=state.timeline,active=resolveTimelineFrame(timeline,frame).filter(item=>item.track.kind==="caption");
 const rendered:Array<{id:string;text:string;style:ReturnType<typeof captionStyle>}>=[],errors:string[]=[];
 await Promise.all(active.map(async item=>{
  const asset=state.assets.find(value=>value.id===item.clip.assetId);
  if(!asset||!["text/plain","text/vtt","application/x-subrip"].includes(asset.mediaType)){return;}
  try{
   const cues=await loadSequenceCaptionCues(asset);
   for(const cue of activeCaptionCues(cues,item.sourceSeconds)){
    const metadata=item.clip.metadata||{},alignment=Math.max(1,Math.min(9,Math.round(Number(metadata.alignment)||2)));
    rendered.push({id:item.clip.id+":"+cue.startSeconds,text:cue.text,style:captionStyle(metadata,alignment)});
   }
  }catch(error){errors.push(error instanceof Error?error.message:"Caption preview could not be loaded.");}
 }));
 if(state.timeline!==timeline||sequenceFrame!==frame||!layer.isConnected)return;
 layer.replaceChildren();
 for(const item of rendered){
  const cue=document.createElement("div");cue.className="sequence-caption-cue";cue.textContent=item.text;
  const style=item.style;
  cue.style.gridColumn=String(style.column);cue.style.gridRow=String(style.row);
  cue.style.fontFamily=style.fontName+", sans-serif";cue.style.fontSize=style.fontSize+"px";cue.style.color=style.primaryColor;
  cue.style.margin=style.marginV+"px 16px";
  const rgb=style.backgroundColor.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  cue.style.background=style.backgroundMode==="none"||!rgb?"transparent":"rgba("+parseInt(rgb[1],16)+","+parseInt(rgb[2],16)+","+parseInt(rgb[3],16)+","+style.opacity+")";
  cue.style.textShadow=style.shadow>0?"0 2px "+style.shadow+"px #000, 0 0 "+(style.outline+1)+"px #000":"none";
  cue.style.setProperty("-webkit-text-stroke",style.outline>0?Math.min(2,style.outline/2)+"px #000":"0");
  layer.appendChild(cue);
 }
 if(errors.length&&!rendered.length){const message=document.createElement("div");message.className="sequence-caption-error";message.textContent=errors[0];layer.appendChild(message);}
}
function syncSequenceAudio(frame:number,forceSeek=false){
 if(!state.timeline)return;
 const active=resolveTimelineFrame(state.timeline,frame).filter(item=>item.track.kind==="audio");
 const activeIds=new Set<string>();
 for(const item of active){
  const asset=state.assets.find(value=>value.id===item.clip.assetId);
  if(!asset?.mediaType.startsWith("audio/"))continue;
  const id=item.clip.id;activeIds.add(id);
  let node=sequenceAudioNodes.get(id);
  if(!node){
   const context=ensureSequenceAudioContext(),element=document.createElement("audio");
   element.preload="auto";
   const source=context.createMediaElementSource(element),gain=context.createGain();source.connect(gain);gain.connect(context.destination);
   node={element,gain,active:false,trackId:item.track.id,assetId:asset.id};sequenceAudioNodes.set(id,node);
   element.onloadedmetadata=()=>{const expected=Number(element.dataset.previewExpected||0);try{element.currentTime=expected;}catch{}if(sequencePlaying&&node?.active)void element.play().catch(()=>{});};
  }
  const expected=Math.max(item.sourceInSeconds,Math.min(item.sourceOutSeconds,item.sourceSeconds));
  node.element.dataset.previewExpected=String(expected);
  void assetMediaUrl(asset).then(url=>{
   if(sequenceAudioNodes.get(id)!==node||node.element.dataset.mediaUrl===url)return;
   node.element.dataset.mediaUrl=url;node.element.src=url;node.element.load();
  }).catch(()=>{});
  if(forceSeek||!node.active||Math.abs(node.element.currentTime-expected)>0.22){
   try{node.element.currentTime=expected;}catch{}
  }
  const audible=isPreviewTrackAudible(item.track.id,sequenceMutedTrackIds,sequenceSoloTrackId);
  node.gain.gain.setTargetAtTime(audible?decibelsToLinearGain(item.clip.gainDb??0):0,sequenceAudioContext!.currentTime,0.015);
  node.element.playbackRate=Math.max(0.25,Math.min(4,item.clip.speed??1));
  node.active=true;
  if(sequencePlaying&&node.element.paused)void node.element.play().catch(()=>{});
 }
 for(const [id,node] of sequenceAudioNodes){if(!activeIds.has(id)){node.active=false;node.element.pause();}}
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
const assetOptions=()=>state.assets.map(a=>{const probe=a.metadata?.probe as {format?:{duration?:string}}|undefined;const duration=Number(probe?.format?.duration);return '<option value="'+esc(a.id)+'">'+esc(a.name)+' · '+esc(a.mediaType)+(Number.isFinite(duration)?' · '+duration.toFixed(1)+'s':' · inspect for duration')+'</option>';}).join("");
function timelineCanvas(){
 if(!state.timeline)return '<div class="empty">'+esc(state.message)+'</div>';
 const total=maxEnd();
 return '<div class="timeline-ruler"><span>00:00</span><span>'+Math.round(total/2/fps())+'s</span><span>'+Math.round(total/fps())+'s</span></div>'+
 state.timeline.tracks.map(track=>'<div class="editor-track"><div class="editor-track-label"><b>'+esc(track.name)+'</b><small>'+esc(track.kind)+(track.locked?' · locked':'')+'</small>'+(track.kind==="audio"?'<div class="track-audio-controls"><button class="secondary" data-tl-action="audio-mute" data-track="'+esc(track.id)+'">'+(sequenceMutedTrackIds.has(track.id)?'Unmute':'Mute')+'</button><button class="secondary" data-tl-action="audio-solo" data-track="'+esc(track.id)+'">'+(sequenceSoloTrackId===track.id?'Unsolo':'Solo')+'</button></div>':'')+'</div><div class="editor-track-lane">'+track.clips.map(clip=>'<article class="editor-clip '+(state.selectedClipId===clip.id?'selected':'')+'" data-tl-select="true" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'" style="left:'+Math.max(0,clip.timelineStart.value/total*100)+'%;width:'+Math.max(4,clip.duration.value/total*100)+'%"><b>'+esc(clip.name)+'</b><small>'+esc(clip.assetId.slice(0,8))+' · '+Math.round(clip.duration.value)+'f</small><div class="editor-clip-actions"><button data-tl-action="split" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Split</button><button data-tl-action="trim" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Trim 12f</button><button data-tl-action="move" data-track="'+esc(track.id)+'" data-clip="'+esc(clip.id)+'">Next track</button></div></article>').join("")+'</div></div>').join("");
}
function sequencePreviewPanel(){
 if(!state.timeline)return '<section class="timeline-preview panel"><div class="eyebrow">SEQUENCE PREVIEW</div><p class="muted">Load a saved sequence to preview its edited picture track.</p></section>';
 const duration=getTimelineDurationFrames(state.timeline),rate=state.timeline.frameRate;
 const hasPicture=state.timeline.tracks.some(track=>track.enabled&&track.kind==="video"&&track.clips.some(clip=>clip.enabled));
  return '<section class="timeline-preview panel"><div class="timeline-panel-heading"><div><div class="eyebrow">SEQUENCE PREVIEW · E1</div><h3>'+esc(state.timeline.name)+'</h3></div><small>'+duration+' frames · '+(rate.numerator/rate.denominator).toFixed(3)+' fps</small></div>'+
 '<div class="preview-stage sequence-preview-stage" style="aspect-ratio:'+Math.max(16,state.timeline.width||1920)+' / '+Math.max(16,state.timeline.height||1080)+'"><video id="tl-sequence-video" class="preview-media" playsinline preload="metadata" hidden></video><img id="tl-sequence-image" class="preview-still" alt="Sequence preview frame" hidden><div id="tl-sequence-overlay-layer" class="sequence-overlay-layer" aria-hidden="true"></div><div id="tl-sequence-caption-layer" class="sequence-caption-layer" aria-live="off"></div><div id="tl-sequence-empty" class="preview-empty">'+(hasPicture?'Press Play to preview the edited picture sequence.':'Add an enabled clip to a video track to preview the sequence.')+'</div></div>'+
 '<div class="preview-transport sequence-transport"><button class="secondary" data-tl-action="sequence-play" '+(!hasPicture||duration===0?'disabled':'')+'>▶ Play</button><button class="secondary" data-tl-action="sequence-pause">Ⅱ Pause</button><button class="secondary" data-tl-action="sequence-step-back">−1 frame</button><button class="secondary" data-tl-action="sequence-step-forward">+1 frame</button><input id="tl-sequence-scrub" aria-label="Seek sequence by frame" type="range" min="0" max="'+Math.max(0,duration-1)+'" value="'+Math.min(sequenceFrame,Math.max(0,duration-1))+'" step="1" '+(duration===0?'disabled':'')+'><output id="tl-sequence-time">'+frameToSeconds(Math.min(sequenceFrame,Math.max(0,duration-1)),rate).toFixed(3)+' s</output></div>'+
 '<small class="muted">'+(state.mode==="cloud"?"Cloud preview uses short-lived, project-authorized private-media URLs.":"Local preview uses the authenticated local asset route.")+' Sequence playback composes synchronized audio, timed still-image overlays and SRT/WebVTT captions. Use the FFmpeg master render for final delivery.</small></section>';
}
function stopSequencePlayback(){
 sequencePlaying=false;if(sequenceRaf!==null)cancelAnimationFrame(sequenceRaf);sequenceRaf=null;
 const video=document.querySelector<HTMLVideoElement>("#tl-sequence-video");video?.pause();
 for(const node of sequenceAudioNodes.values()){node.active=false;node.element.pause();}
}
function renderSequenceFrame(frame:number,forceSeek=false){
 if(!state.timeline)return;
 const duration=getTimelineDurationFrames(state.timeline);sequenceFrame=Math.max(0,Math.min(Math.max(0,duration-1),Math.round(frame)));
 const slider=document.querySelector<HTMLInputElement>("#tl-sequence-scrub");if(slider)slider.value=String(sequenceFrame);
 const output=document.querySelector<HTMLOutputElement>("#tl-sequence-time");if(output)output.value=frameToSeconds(sequenceFrame,state.timeline.frameRate).toFixed(3)+" s";
 syncSequenceAudio(sequenceFrame,forceSeek);
 void syncSequenceCaptions(sequenceFrame);
 const resolved=resolveTimelineFrame(state.timeline,sequenceFrame);
 const overlayLayer=document.querySelector<HTMLElement>("#tl-sequence-overlay-layer");
 if(overlayLayer){
  const overlays=resolveTimelineOverlays(state.timeline,sequenceFrame);
  const activeOverlayIds=new Set(overlays.map(item=>item.clip.id));
  for(const child of Array.from(overlayLayer.children)){
   if(!activeOverlayIds.has((child as HTMLElement).dataset.clipId||""))child.remove();
  }
  for(const item of overlays){
   const asset=state.assets.find(value=>value.id===item.clip.assetId);
   if(!asset?.mediaType.startsWith("image/"))continue;
   let overlay=Array.from(overlayLayer.children).find(child=>(child as HTMLElement).dataset.clipId===item.clip.id) as HTMLImageElement|undefined;
   if(!overlay){overlay=document.createElement("img");overlay.alt="";overlay.dataset.clipId=item.clip.id;overlay.dataset.assetId=asset.id;overlay.draggable=false;overlayLayer.appendChild(overlay);}
   else if(overlay.dataset.assetId!==asset.id){overlay.dataset.assetId=asset.id;}
   void assetMediaUrl(asset).then(url=>{if(overlay?.isConnected&&overlay.dataset.clipId===item.clip.id&&overlay.dataset.mediaUrl!==url){overlay.dataset.mediaUrl=url;overlay.src=url;}}).catch(()=>{});
   overlay.style.left=(item.x/Math.max(16,state.timeline.width)*100)+"%";
   overlay.style.top=(item.y/Math.max(16,state.timeline.height)*100)+"%";
   overlay.style.width=(item.width/Math.max(16,state.timeline.width)*100)+"%";
   overlay.style.height=(item.height/Math.max(16,state.timeline.height)*100)+"%";
   overlay.style.opacity=String(item.opacity);
   overlayLayer.appendChild(overlay);
  }
 }
 const active=resolved.filter(item=>item.track.kind==="video");
 const current=active[active.length-1],video=document.querySelector<HTMLVideoElement>("#tl-sequence-video"),image=document.querySelector<HTMLImageElement>("#tl-sequence-image"),empty=document.querySelector<HTMLElement>("#tl-sequence-empty");
 if(!video||!image||!empty)return;
 if(!current){video.pause();video.hidden=true;image.hidden=true;if(overlayLayer)overlayLayer.replaceChildren();empty.hidden=false;empty.textContent="No active picture clip at this timeline position.";return;}
 const asset=state.assets.find(item=>item.id===current.clip.assetId);
 if(!asset){video.pause();video.hidden=true;image.hidden=true;empty.hidden=false;empty.textContent="The active source asset is unavailable in this workspace.";return;}
 empty.hidden=true;
 if(asset.mediaType.startsWith("image/")){
  video.pause();video.hidden=true;image.hidden=false;image.dataset.activeClip=current.clip.id;
  void assetMediaUrl(asset).then(url=>{if(image.isConnected&&image.dataset.activeClip===current.clip.id&&image.dataset.mediaUrl!==url){image.dataset.mediaUrl=url;image.src=url;}}).catch(error=>{if(empty){empty.hidden=false;empty.textContent=error instanceof Error?error.message:"Image preview could not be loaded.";}});return;
 }
 if(!asset.mediaType.startsWith("video/")){video.pause();video.hidden=true;image.hidden=true;empty.hidden=false;empty.textContent="The active picture source is not a browser-playable video or image.";return;}
 image.hidden=true;video.hidden=false;
 const changed=video.dataset.activeClip!==current.clip.id;
 if(changed){video.dataset.activeClip=current.clip.id;video.dataset.sourceIn=String(current.sourceInSeconds);video.dataset.sourceOut=String(current.sourceOutSeconds);video.onloadedmetadata=()=>{if(video.dataset.activeClip!==current.clip.id)return;video.currentTime=Math.min(current.sourceSeconds,Number.isFinite(video.duration)?video.duration:current.sourceSeconds);if(sequencePlaying)void video.play().catch(()=>{if(empty){empty.hidden=false;empty.textContent="Playback was blocked by the browser. Press Play to resume.";}});};video.onerror=()=>{if(empty){empty.hidden=false;empty.textContent="This source could not be decoded by the browser. Try a compatible proxy or render a master.";}};}
 void assetMediaUrl(asset).then(url=>{if(!video.isConnected||video.dataset.activeClip!==current.clip.id||video.dataset.mediaUrl===url)return;video.dataset.mediaUrl=url;video.src=url;video.load();}).catch(error=>{if(empty){empty.hidden=false;empty.textContent=error instanceof Error?error.message:"Video preview could not be loaded.";}}); 
 if(!changed&&forceSeek&&video.readyState>=1){video.currentTime=Math.min(current.sourceSeconds,Number.isFinite(video.duration)?video.duration:current.sourceSeconds);}
 try{video.playbackRate=current.clip.speed??1;}catch{}
 if(sequencePlaying&&video.paused&&video.readyState>=2)void video.play().catch(()=>{});
 
}
function sequencePlaybackTick(){
 if(!sequencePlaying||!state.timeline)return;
 const elapsed=Math.max(0,(performance.now()-sequenceStartAt)/1000),frame=sequenceStartFrame+secondsToFrame(elapsed,state.timeline.frameRate),duration=getTimelineDurationFrames(state.timeline);
 if(frame>=duration){renderSequenceFrame(Math.max(0,duration-1),true);stopSequencePlayback();return;}
 renderSequenceFrame(frame);sequenceRaf=requestAnimationFrame(sequencePlaybackTick);
}
function startSequencePlayback(){
 if(!state.timeline)return;const duration=getTimelineDurationFrames(state.timeline);if(duration<=0)return;
 let start=sequenceFrame;if(start>=duration-1)start=0;stopSequencePlayback();sequencePlaying=true;sequenceStartFrame=start;sequenceStartAt=performance.now();ensureSequenceAudioContext();renderSequenceFrame(start,true);sequenceRaf=requestAnimationFrame(sequencePlaybackTick);
}
function timelinePreviewPanel(){
 if(!state.timeline)return '<section class="timeline-preview panel"><div class="eyebrow">SOURCE PREVIEW</div><p class="muted">Load a sequence to preview a source clip.</p></section>';
 const track=state.timeline.tracks.find(item=>item.clips.some(clip=>clip.id===state.selectedClipId));
 const clip=track?.clips.find(item=>item.id===state.selectedClipId);
 const asset=clip?state.assets.find(item=>item.id===clip.assetId):undefined;
 const heading='<div class="timeline-panel-heading"><div><div class="eyebrow">SOURCE PREVIEW MONITOR</div><h3>'+(clip?esc(clip.name):'Select a timeline clip')+'</h3></div><small>'+(clip?'Source-range preview':'No clip selected')+'</small></div>';
  if(!track||!clip||!asset)return '<section class="timeline-preview panel">'+heading+'<div class="preview-empty">Select a video, audio or image clip on the timeline.</div></section>';
 const start=clip.sourceRange.start.value/clip.sourceRange.start.rate,end=start+clip.sourceRange.duration.value/clip.sourceRange.duration.rate;
 const mediaUrl=state.mode==="cloud"?"":'/api/assets/'+encodeURIComponent(asset.id)+'/file',sourceAttr=mediaUrl?' src="'+mediaUrl+'"':'';
 const previewRate=track.kind==="audio"?100:sourceRate(asset,track.kind),isVideoPreview=asset.mediaType.startsWith("video/");
 const media=asset.mediaType.startsWith("video/")?'<video id="tl-preview-media" class="preview-media" controls playsinline preload="metadata"'+sourceAttr+' data-asset-id="'+esc(asset.id)+'" data-source-in="'+start+'" data-source-out="'+end+'" data-source-fps="'+previewRate+'"></video>':asset.mediaType.startsWith("audio/")?'<audio id="tl-preview-media" class="preview-audio" controls preload="metadata"'+sourceAttr+' data-asset-id="'+esc(asset.id)+'" data-source-in="'+start+'" data-source-out="'+end+'" data-source-fps="'+previewRate+'"></audio>':asset.mediaType.startsWith("image/")?'<img id="tl-preview-image" class="preview-still"'+sourceAttr+' data-asset-id="'+esc(asset.id)+'" alt="'+esc(asset.name)+'">':'<div class="preview-empty">This media type cannot be previewed.</div>';
 const frameButtons=isVideoPreview?'<button class="secondary" data-tl-action="preview-step-back">−1 frame</button><button class="secondary" data-tl-action="preview-step-forward">+1 frame</button>':'';
 const controls=asset.mediaType.startsWith("video/")||asset.mediaType.startsWith("audio/")?'<div class="preview-transport"><button class="secondary" data-tl-action="preview-in">Go to source in</button>'+frameButtons+'<button class="secondary" data-tl-action="preview-out">Go to source out</button><input id="tl-preview-scrub" aria-label="'+(isVideoPreview?"Seek by source frame":"Seek by 10 milliseconds")+'" type="range" min="0" max="' + Math.max(1,Math.ceil((end-start)*previewRate)) + '" value="0" step="1"><output id="tl-preview-time">Loading media…</output></div>':'';
 return '<section class="timeline-preview panel">'+heading+'<div class="preview-stage">'+media+'</div>'+controls+'<small class="muted">Preview is limited to this clip’s saved source range. Video frame stepping uses the probed source frame rate; audio scrubbing uses 10 ms increments. A verified master render is still required for delivery.</small></section>';
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
 let specific="";
 if(track.kind==="audio")specific='<div><label>Gain (dB)</label><input name="gainDb" type="number" min="-60" max="24" step="0.5" value="'+esc(clip.gainDb??0)+'"></div>';
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
export function renderTimelineWorkspace(){
 return '<div id="timeline-workspace"><div class="timeline-toolbar"><label>Workspace <select id="tl-mode"><option value="local" '+(state.mode==="local"?"selected":"")+' >Local</option><option value="cloud" '+(state.mode==="cloud"?"selected":"")+' >Cloud project</option></select></label><label>Cloud project <select id="tl-cloud-project"><option value="">Select project</option>'+state.cloudProjects.map(p=>'<option value="'+esc(p.id)+'" '+(p.id===state.cloudProjectId?'selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></label><label>Saved sequence <select id="tl-saved-sequence"><option value="">Current sequence</option>'+(state.mode==="cloud"?state.cloudTimelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""):state.timelines.map(t=>'<option value="'+esc(t.id)+'" '+(state.timeline?.id===t.id?'selected':'')+'>'+esc(t.name)+' · r'+t.revision+'</option>').join(""))+'</select></label><button class="secondary" data-tl-create-cloud>＋ New cloud timeline</button>'+(state.mode==="cloud"?'<button class="secondary" data-tl-action="import-generated-video">＋ Import latest generated video</button>':"")+'<button class="secondary" data-tl-action="duplicate-variant">Duplicate as variant</button><span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="ready"?"TIMELINE SAVED":state.status==="auth"?"SIGN IN REQUIRED":state.status==="offline"?"API OFFLINE":"LOADING")+'</span><button class="secondary" data-tl-action="refresh">↻ Refresh</button><button class="secondary" data-tl-action="export">Export OTIO JSON</button>'+(state.mode==="cloud"&&state.cloudRenderJobId?'<button class="secondary" data-tl-action="cloud-job">Check cloud render · '+esc(state.cloudRenderJobStatus||"queued")+'</button>':'')+''+(state.ffmpeg?'<button class="primary" data-tl-action="render">Render master MP4</button>':'<span class="muted">FFmpeg required for master render</span>')+'</div>'+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+
 '<div class="timeline-editor-grid"><section class="panel"><div class="eyebrow">SEQUENCE SETTINGS</div><h3>'+(state.timeline?esc(state.timeline.name):"No sequence loaded")+'</h3>'+
 '<form id="tl-add-track"><label>Track name</label><input name="name" required placeholder="Video 2 / Music / Captions"><label>Track type</label><select name="kind"><option value="video">Video</option><option value="audio">Audio</option><option value="overlay">Overlay</option><option value="caption">Captions</option></select><button class="secondary">＋ Add track</button></form>'+
 '<div class="eyebrow" style="margin-top:18px">ADD SOURCE CLIP</div><form id="tl-add-clip"><label>Source asset</label><select id="tl-asset-select" name="assetId" required>'+assetOptions()+'</select><label>Destination track</label><select name="trackId">'+(state.timeline?.tracks.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join("")||"")+'</select><div class="form-grid"><div><label>Timeline start (frames)</label><input name="start" type="number" min="0" value="'+maxEnd()+'"></div><div><label>Source in (source frames)</label><input name="sourceIn" type="number" min="0" value="0"></div><div><label>Duration (timeline frames)</label><input name="duration" type="number" min="1" value="'+(fps()*5)+'"></div></div><button class="primary wide">＋ Place clip on timeline</button></form>'+
 '<form id="tl-add-marker"><div class="eyebrow" style="margin-top:18px">REVIEW MARKER</div><label>Marker title</label><input name="name" required placeholder="Hook / transition / review note"><label>Position (frames)</label><input name="frame" type="number" min="0" value="0"><button class="secondary">＋ Add marker</button></form></section>'+
 '<section class="panel"><div class="timeline-panel-heading"><div><div class="eyebrow">MULTI-TRACK EDITOR</div><h3>Sequence timeline</h3></div><small>'+(state.timeline?.frameRate.numerator+"/"+state.timeline?.frameRate.denominator+" fps")+'</small></div>'+
 sequencePreviewPanel()+timelinePreviewPanel()+(state.timeline?timelineCanvas():'<div class="empty">Sign in and create a sequence to begin.</div>')+
 clipInspector()+variantComparisonPanel()+creativeTraceabilityPanel()+timelineQualityPanel()+
  '<div class="timeline-marker-list">'+(state.timeline?.markers.map(m=>'<span>◆ '+esc(m.name)+' · '+Math.round(m.start.value)+'f</span>').join("")||"No review markers yet.")+'</div></section></div>'+
 '<div class="notice">Master rendering supports synchronized audio, image overlays and captions. The preview monitor plays selected local source clips within saved source trims; cloud preview awaits authenticated private-media playback support. Transitions and effects remain future milestones.</div></div>';
}
async function refresh(){
 if(state.mode==="cloud"){
  const projects=await apiRequest<{projects:CloudProject[]}>("/api/cloud/projects");
  state.cloudProjects=projects.projects||[];
  if(!state.cloudProjectId||!state.cloudProjects.some(p=>p.id===state.cloudProjectId))state.cloudProjectId=state.cloudProjects[0]?.id||"";
  if(!state.cloudProjectId){if(sequenceMediaProjectId){resetSequenceMediaCache();sequenceMediaProjectId="";}state.assets=[];state.cloudTimelines=[];state.timeline=null;state.message="Create a cloud project first, then select it here.";state.status="ready";return;}
  if(sequenceMediaProjectId!==state.cloudProjectId){resetSequenceMediaCache();sequenceMediaProjectId=state.cloudProjectId;}
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
 if(sequenceMediaProjectId){resetSequenceMediaCache();sequenceMediaProjectId="";}
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
function paint(){
 stopSequencePlayback();clearSequenceAudio();
 const root=document.querySelector<HTMLElement>("#timeline-workspace");if(root)root.outerHTML=renderTimelineWorkspace();
 const media=document.querySelector<HTMLMediaElement>("#tl-preview-media");
 if(media){
  if(state.mode==="cloud"){
   const asset=state.assets.find(item=>item.id===media.dataset.assetId);
   if(asset)void assetMediaUrl(asset).then(url=>{if(media.isConnected&&media.dataset.mediaUrl!==url){media.dataset.mediaUrl=url;media.src=url;media.load();}}).catch(error=>{const root=media.parentElement;if(root){const notice=document.createElement("p");notice.className="preview-empty";notice.textContent=error instanceof Error?error.message:"Private cloud media could not be loaded.";root.appendChild(notice);}});
  }
  const setIn=()=>{const start=Number(media.dataset.sourceIn),duration=media.duration,end=Number(media.dataset.sourceOut);if(Number.isFinite(start)){const safeStart=Math.min(start,Number.isFinite(duration)?duration:start);media.currentTime=safeStart;}if(Number.isFinite(end)&&Number.isFinite(duration)&&end>duration)media.dataset.sourceOut=String(duration);};
  if(media.readyState>=1)setIn();else media.addEventListener("loadedmetadata",setIn,{once:true});
  media.addEventListener("timeupdate",()=>{const output=document.querySelector<HTMLOutputElement>("#tl-preview-time");if(output)output.value=media.currentTime.toFixed(3)+" s";const start=Number(media.dataset.sourceIn),end=Math.min(Number(media.dataset.sourceOut),Number.isFinite(media.duration)?media.duration:Number(media.dataset.sourceOut)),rate=Number(media.dataset.sourceFps),scrub=document.querySelector<HTMLInputElement>("#tl-preview-scrub");if(scrub&&Number.isFinite(rate)&&rate>0)scrub.value=String(Math.max(0,Math.round((media.currentTime-start)*rate)));if(Number.isFinite(end)&&media.currentTime>=end){media.pause();media.currentTime=end;}});
 }
 const image=document.querySelector<HTMLImageElement>("#tl-preview-image");
 if(image&&state.mode==="cloud"){
  const asset=state.assets.find(item=>item.id===image.dataset.assetId);
  if(asset)void assetMediaUrl(asset).then(url=>{if(image.isConnected&&image.dataset.mediaUrl!==url){image.dataset.mediaUrl=url;image.src=url;}}).catch(error=>{const root=image.parentElement;if(root){const notice=document.createElement("p");notice.className="preview-empty";notice.textContent=error instanceof Error?error.message:"Private cloud image could not be loaded.";root.appendChild(notice);}});
 }
}
async function runAction(action:HTMLElement){
 const type=action.dataset.tlAction||"";
 if(type==="refresh"){await refresh();paint();return;}
 if(type==="import-generated-video"){
  if(state.mode!=="cloud"||!state.cloudProjectId||!state.timeline){state.message="Select a cloud project and load a cloud timeline before importing generated video.";paint();return;}
  const generated=state.assets.filter(asset=>asset.mediaType.startsWith("video/")&&asset.metadata?.source==="video-generation")
   .sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  const asset=generated[0];
  if(!asset){state.message="No generated video assets were found in this cloud project. Complete an approved generation first.";paint();return;}
  if(state.timeline.tracks.some(item=>item.clips.some(clip=>clip.assetId===asset.id))){state.message="The latest generated video is already present on this timeline.";paint();return;}
  let track=state.timeline.tracks.find(item=>item.kind==="video"&&!item.locked);
  if(!track){state.timeline=addTrack(state.timeline,{id:crypto.randomUUID(),name:"Generated Video",kind:"video",enabled:true,locked:false,clips:[]});track=state.timeline.tracks[state.timeline.tracks.length-1];}
  const probe=asset.metadata?.probe as {format?:{duration?:string}}|undefined;
  const durationSeconds=Number(probe?.format?.duration);
  const clipFrames=Math.max(1,Math.round((Number.isFinite(durationSeconds)&&durationSeconds>0?durationSeconds:5)*fps()));
  try{
   const generatedClipId=crypto.randomUUID();
   state.timeline=addClip(state.timeline,track.id,{id:generatedClipId,assetId:asset.id,name:asset.name,sourceRange:{start:rational(0,sourceRate(asset,"video")),duration:rational(clipFrames/fps()*sourceRate(asset,"video"),sourceRate(asset,"video"))},timelineStart:rational(maxEnd(),fps()),duration:rational(clipFrames,fps()),enabled:true,metadata:{generatedVideo:true,provider:asset.metadata?.provider||"unknown",providerTaskId:asset.metadata?.providerTaskId||""}});
   state.selectedTrack=track.id;state.selectedClipId=generatedClipId;
   state.message="Imported "+asset.name+" from private generated assets. Saving timeline…";
   await persist();await refresh();
  }catch(error){state.message=error instanceof Error?error.message:"Generated video could not be added to the timeline.";}
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
 if(type.startsWith("preview-")){seekPreview(type);return;}
 if(type==="sequence-play"){startSequencePlayback();return;}
 if(type==="sequence-pause"){stopSequencePlayback();return;}
 if(type==="sequence-step-back"||type==="sequence-step-forward"){stopSequencePlayback();renderSequenceFrame(sequenceFrame+(type==="sequence-step-back"?-1:1),true);return;}
 if(type==="audio-mute"||type==="audio-solo"){
  const trackId=action.dataset.track||"";
  if(type==="audio-mute"){if(sequenceMutedTrackIds.has(trackId))sequenceMutedTrackIds.delete(trackId);else sequenceMutedTrackIds.add(trackId);}
  else sequenceSoloTrackId=sequenceSoloTrackId===trackId?null:trackId;
  syncSequenceAudio(sequenceFrame,true);
  document.querySelectorAll<HTMLElement>('[data-tl-action="audio-mute"]').forEach(button=>{const id=button.dataset.track||"";button.textContent=sequenceMutedTrackIds.has(id)?"Unmute":"Mute";});
  document.querySelectorAll<HTMLElement>('[data-tl-action="audio-solo"]').forEach(button=>{const id=button.dataset.track||"";button.textContent=sequenceSoloTrackId===id?"Unsolo":"Solo";});
  state.message=type==="audio-mute"?"Audio track preview mute updated.":"Audio track preview solo updated.";
  return;
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
document.addEventListener("input",event=>{const target=event.target as HTMLInputElement;if(target.id==="tl-sequence-scrub"){stopSequencePlayback();renderSequenceFrame(Number(target.value),true);return;}if(target.id!=="tl-preview-scrub")return;const media=document.querySelector<HTMLMediaElement>("#tl-preview-media");if(!media)return;const start=Number(media.dataset.sourceIn),end=Number(media.dataset.sourceOut),rate=Number(media.dataset.sourceFps);if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(rate)||rate<=0)return;media.currentTime=clampPreviewSeconds(start+Number(target.value)/rate,start,end);});
document.addEventListener("click",event=>{
 const create=(event.target as HTMLElement).closest<HTMLElement>("[data-tl-create-cloud]");if(create){void createCloudTimeline().catch(error=>{state.message=error instanceof Error?error.message:"Cloud timeline creation failed.";paint();});return;}
 const target=event.target as HTMLElement,select=target.closest<HTMLElement>("[data-tl-select]");
 if(select&&state.timeline){state.selectedTrack=select.dataset.track||"";state.selectedClipId=select.dataset.clip||"";paint();}
 const action=target.closest<HTMLElement>("[data-tl-action]");
 if(action)void runAction(action);
});
window.addEventListener("ev:authenticated",()=>{resetSequenceMediaCache();sequenceMediaProjectId="";void initTimelineWorkspace();});
window.addEventListener("ev:unauthenticated",()=>{resetSequenceMediaCache();sequenceMediaProjectId="";});
window.addEventListener("ev:assets-updated",()=>void refresh().then(paint).catch(error=>{state.message=error.message;paint();}));
