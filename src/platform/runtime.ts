import { apiRequest, ApiError, setApiAccessToken, clearApiAccessToken } from "../core/api";

type RuntimeUser={id:string;email:string};
type RuntimeProject={id:string;name:string;description?:string;revision?:number;access_role?:"owner"|"editor"|"reviewer"|"viewer"};
type RuntimeAsset={id:string;projectId?:string|null;name:string;mediaType:string;size:number;sha256:string;derivativeOf?:string|null;metadata?:Record<string,unknown>;createdAt:string};
type AssetLineageNode={id:string;name?:string;mediaType?:string;sha256?:string;derivativeOf?:string|null;missing?:boolean;cycle?:boolean};
type AssetLineage={asset:AssetLineageNode;ancestors:AssetLineageNode[];descendants:AssetLineageNode[];truncated:boolean;nodeCount:number;collectionTruncated?:boolean};
type RuntimeJob={id:string;projectId?:string|null;jobType:string;status:string;progress:number;input:Record<string,unknown>;output?:Record<string,unknown>|null;error?:{code?:string;message?:string}|null;createdAt:string;updatedAt:string};
type RuntimeReview={id:string;project_id:string;asset_id?:string|null;timecode_seconds?:number|null;decision:string;body:string;status:string;created_at:string};
type ProviderStatus={id:string;provider:string;enabled:boolean;configured:boolean;remote:boolean;model:string|null;status:"ready"|"disabled"|"needs_configuration"|"remote_opt_in_required"|"unavailable";reason:string;capabilities:string[]};
type RemoteUsage={window:string;configurationValid:boolean;limit:number|null;used:number;remaining:number|null;projectUsed:number|null;remoteDisabled:boolean};
let workspaceRevisions=new Map<string,number>();
let workspaceSaveTimers=new Map<string,ReturnType<typeof setTimeout>>();
let workspaceSaveChain:Promise<void>=Promise.resolve();
const state:{status:"checking"|"offline"|"auth-required"|"online";authMode:"local"|"supabase";user:RuntimeUser|null;projects:RuntimeProject[];assets:RuntimeAsset[];jobs:RuntimeJob[];audit:Array<Record<string,unknown>>;members:Array<{id:string;email:string;role:string;createdAt:string}>;reviews:RuntimeReview[];projectId:string;message:string;ffmpeg:boolean;ffprobe:boolean;textGatewayEnabled:boolean;textGatewayConfigured:boolean;imageGatewayEnabled:boolean;imageGatewayConfigured:boolean;providers:ProviderStatus[];remoteUsage:RemoteUsage|null;lineage:Map<string,AssetLineage>;lineageLoading:Set<string>;lineageExpanded:Set<string>;lineageErrors:Map<string,string>}={
 status:"checking",authMode:"local",user:null,projects:[],assets:[],jobs:[],audit:[],members:[],reviews:[],projectId:"",message:"",ffmpeg:false,ffprobe:false,textGatewayEnabled:false,textGatewayConfigured:false,imageGatewayEnabled:false,imageGatewayConfigured:false,providers:[],remoteUsage:null,lineage:new Map(),lineageLoading:new Set(),lineageExpanded:new Set(),lineageErrors:new Map()
};
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const fmt=(value:string)=>new Date(value).toLocaleString();
function statusMarkup(){return '<span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="online"?"API CONNECTED":state.status==="auth-required"?"SIGN IN REQUIRED":state.status==="offline"?"OFFLINE":"CONNECTING")+'</span>';}
function updateShell(){
 const projectLabel=document.querySelector<HTMLElement>("#project-name");
 if(projectLabel)projectLabel.textContent=state.projects.find(project=>project.id===state.projectId)?.name||"No project selected";
 const foot=document.querySelector<HTMLElement>(".sidebar-foot small");
 if(foot)foot.textContent=state.status==="online"?"Persistent API · "+(state.user?.email||"authenticated"):state.status==="auth-required"?"Sign in to enable persistent projects":state.status==="offline"?"API offline · local planning only":"Connecting to local API";
 const badge=document.querySelector<HTMLElement>(".local-badge");
 if(badge)badge.textContent=state.status==="online"?"API CONNECTED":state.status==="auth-required"?"SIGN IN REQUIRED":state.status==="offline"?"OFFLINE MODE":"CONNECTING";
 const dot=document.querySelector<HTMLElement>(".local-dot");
 if(dot)dot.style.background=state.status==="online"?"#68c9a2":state.status==="offline"?"#d8a65b":"#8791a1";
}
function renderGate(){
 document.querySelector("#ev-auth-gate")?.remove();
 if(state.status!=="auth-required")return;
 const external=state.authMode==="supabase";
 document.body.insertAdjacentHTML("beforeend",'<main id="ev-auth-gate" class="auth-landing"><section class="auth-story"><a class="auth-brand" href="#" aria-label="Executive Visuals home"><span class="brand-mark">CEV</span><span><b>CHRISHEM</b><small>EXCLUSIVE VISUALS</small></span></a><div class="auth-story-copy"><div class="eyebrow">THE CREATIVE PRODUCTION WORKSPACE</div><h1>From first idea<br>to <em>final frame.</em></h1><p>Plan, direct, edit, enhance and prepare your visual productions in one connected studio.</p><div class="auth-feature-list"><div><i>✳</i><span><b>Direct with intention</b><small>Creative briefs, series plans and storyboards.</small></span></div><div><i>▤</i><span><b>Keep every asset connected</b><small>Projects, source media, timelines and versions.</small></span></div><div><i>◈</i><span><b>Deliver with confidence</b><small>Caption, rights, quality and master checks.</small></span></div></div></div><div class="auth-story-footer">A focused workspace for serious visual storytelling.</div></section><section class="auth-panel-wrap"><div class="auth-card auth-card-modern"><div class="eyebrow">YOUR PRIVATE STUDIO</div><h2>'+(external?"Verify your workspace":"Welcome back")+'</h2><p>'+(external?"Connect your authenticated session to access private projects and media.":"Sign in to continue, or create a local development account to explore the workspace.")+'</p>'+
 (external?'<form id="ev-auth-token"><label>Access token</label><textarea name="token" rows="3" required autocomplete="off" placeholder="Paste a short-lived access token"></textarea><button class="primary wide">Verify secure session</button></form>':
 '<div class="auth-switch" role="group" aria-label="Account action"><button type="button" class="active" data-auth-mode="login">Sign in</button><button type="button" data-auth-mode="register">Create account</button></div><form id="ev-auth"><input type="hidden" name="mode" value="login"><label>Email address</label><input name="email" type="email" required autocomplete="username" placeholder="you@example.com"><label>Password</label><input name="password" type="password" minlength="12" required autocomplete="current-password" placeholder="At least 12 characters"><button class="primary wide">Continue securely</button></form>')+
 '<div class="auth-security"><span>⌑</span><div><b>Private by design</b><small>Your projects and media remain account-scoped. Authentication is handled by the configured service.</small></div></div><p class="auth-error">'+esc(state.message)+'</p><small class="auth-footnote">'+(external?"This environment uses its configured external identity provider.":"Local password accounts are for development only. Production sign-in requires the configured external identity service.")+'</small></div></section></main>');
}
function projectOptions(){return '<option value="">Personal library</option>'+state.projects.map(p=>'<option value="'+esc(p.id)+'" '+(state.projectId===p.id?"selected":"")+'>'+esc(p.name)+'</option>').join("");}
function lineageNodeMarkup(node:AssetLineageNode){
 if(node.missing)return '<li class="lineage-missing"><b>Missing parent</b><small>'+esc(node.id)+'</small><span>Not present in this account/project scope.</span></li>';
 if(node.cycle)return '<li class="lineage-cycle"><b>Cycle detected</b><small>'+esc(node.id)+'</small><span>Traversal stopped safely.</span></li>';
 return '<li><b>'+esc(node.name||node.id)+'</b><small>'+esc(node.mediaType||'Media asset')+' · '+esc(node.id)+'</small><code>SHA-256 '+esc((node.sha256||'not recorded').slice(0,20))+(node.sha256?'…':'')+'</code></li>';
}
function renderAssetLineage(assetId:string){
 const lineage=state.lineage.get(assetId),loading=state.lineageLoading.has(assetId),error=state.lineageErrors.get(assetId);
 if(!state.lineageExpanded.has(assetId))return '';
 if(loading)return '<div class="asset-lineage"><small>Loading authorized lineage…</small></div>';
 if(error)return '<div class="asset-lineage"><p class="lineage-error">'+esc(error)+'</p><button data-ev-lineage="'+esc(assetId)+'">Retry lineage</button></div>';
 if(!lineage)return '';
 return '<section class="asset-lineage"><div class="eyebrow">SOURCE & DERIVATIVE HISTORY</div><div class="lineage-columns"><div><b>Ancestors · '+lineage.ancestors.length+'</b><ol>'+(lineage.ancestors.length?lineage.ancestors.map(lineageNodeMarkup).join(''):'<li class="lineage-empty">This asset has no recorded parent.</li>')+'</ol></div><div><b>Derived assets · '+lineage.descendants.length+'</b><ol>'+(lineage.descendants.length?lineage.descendants.map(lineageNodeMarkup).join(''):'<li class="lineage-empty">No derivatives found in this scope.</li>')+'</ol></div></div><small>'+lineage.nodeCount+' graph node(s) inspected'+(lineage.truncated||lineage.collectionTruncated?' · results bounded; additional lineage may exist':'')+'. Only assets in the same authorized project/personal scope are included.</small></section>';
}
function renderAssets(){
 if(!state.assets.length)return '<div class="empty">No stored media yet. Upload a source file to begin.</div>';
 return '<div class="runtime-assets">'+state.assets.map(a=>{
  const isVideo=a.mediaType.startsWith("video/"),isAudio=a.mediaType.startsWith("audio/"),isImage=a.mediaType.startsWith("image/");
  const file="/api/assets/"+esc(a.id)+"/file";
  const preview=isImage?'<img loading="lazy" src="'+file+'" alt="">':isVideo?'<video controls preload="metadata" src="'+file+'"></video>':isAudio?'<audio controls preload="metadata" src="'+file+'"></audio>':'<a href="'+file+'" target="_blank" rel="noopener">Open file</a>';
  const sourceAsset=a.derivativeOf?state.assets.find(item=>item.id===a.derivativeOf):undefined;
  const processing=a.metadata&&typeof a.metadata==="object"&&a.metadata.processing&&typeof a.metadata.processing==="object"?a.metadata.processing as Record<string,unknown>:{};
  const lineage=sourceAsset&&isImage?'<section class="asset-comparison"><div class="eyebrow">SOURCE / ENHANCED REVIEW</div><div class="asset-comparison-grid"><div><small>Original · '+esc(sourceAsset.name)+'</small><a href="/api/assets/'+esc(sourceAsset.id)+'/file" target="_blank" rel="noopener"><img loading="lazy" src="/api/assets/'+esc(sourceAsset.id)+'/file" alt="Original source image"></a></div><div><small>Derivative · '+esc(a.name)+'</small><a href="'+file+'" target="_blank" rel="noopener"><img loading="lazy" src="'+file+'" alt="Enhanced derivative image"></a></div></div><p>'+esc(processing.method||"Processed derivative")+' · '+esc(processing.model||"model not recorded")+' · '+esc(processing.scale?String(processing.scale)+"×":"scale not recorded")+(processing.dimensionsVerified?" · dimensions verified":"")+'</p><small>Original SHA-256: '+esc(sourceAsset.sha256.slice(0,16))+'… · Enhanced SHA-256: '+esc(a.sha256.slice(0,16))+'…</small></section>':'';
  const lineageAction='<button data-ev-lineage="'+esc(a.id)+'">'+(state.lineageExpanded.has(a.id)?'Hide lineage':'View lineage')+'</button>';
  const actions='<a class="download-output" href="'+file+'" target="_blank" rel="noopener">Open original</a>'+(state.projectId&&["owner","editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<button data-ev-review-asset="'+esc(a.id)+'">Review asset</button>':'')+'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect</button>'+(isVideo?'<button data-ev-job="media.thumbnail" data-ev-asset="'+esc(a.id)+'">Extract frame</button><button data-ev-job="media.proxy" data-ev-asset="'+esc(a.id)+'">Create proxy</button><button data-ev-job="media.audio_extract" data-ev-asset="'+esc(a.id)+'">Extract audio</button><button data-ev-job="media.denoise" data-ev-asset="'+esc(a.id)+'" data-ev-luma="4" data-ev-chroma="3">Denoise</button><button data-ev-job="media.color" data-ev-asset="'+esc(a.id)+'" data-ev-brightness="0" data-ev-contrast="1" data-ev-saturation="1">Color correction</button><button data-ev-job="media.resize" data-ev-asset="'+esc(a.id)+'" data-ev-width="1920" data-ev-height="1080" data-ev-fit="contain">Reframe 16:9</button><button data-ev-job="media.interpolate" data-ev-asset="'+esc(a.id)+'" data-ev-fps="30">Interpolate 30 fps</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="2560" data-ev-height="1440" data-ev-algorithm="lanczos">Scale to QHD · Lanczos</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="2560" data-ev-height="1440" data-ev-algorithm="spline36" data-ev-sharpness="0.5">Scale to QHD · Spline + sharpen</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="3840" data-ev-height="2160" data-ev-algorithm="lanczos">Scale to 4K · Lanczos</button>':isAudio?'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect audio</button><button data-ev-job="media.audio-clean" data-ev-asset="'+esc(a.id)+'" data-ev-noise-floor="-25" data-ev-target-lufs="-16">Clean speech & normalize</button>':isImage?(state.providers.some(provider=>provider.id==="ai-upscale"&&provider.status==="ready")?'<button data-ev-job="media.ai-upscale" data-ev-asset="'+esc(a.id)+'" data-ev-model="realesrgan-x4plus" data-ev-scale="4" data-ev-tile="128" data-ev-format="png">AI super-resolution · 4×</button>':'<span class="muted">AI super-resolution unavailable · configure and enable a compatible worker</span>'):'');
  return '<article class="runtime-asset"><div class="runtime-asset-preview">'+preview+'</div><div class="runtime-asset-info"><b>'+esc(a.name)+'</b><small>'+Math.max(1,Math.round(a.size/1024))+' KB · '+esc(a.mediaType)+'</small><code>'+esc(a.sha256.slice(0,20))+'…</code>'+(a.derivativeOf?'<small>Derivative of '+esc(sourceAsset?.name||a.derivativeOf)+'</small>':'')+'</div>'+lineage+'<div class="runtime-asset-actions">'+lineageAction+actions+'</div>'+renderAssetLineage(a.id)+'</article>';
 }).join("")+'</div>';
}
function renderJobs(){
 if(!state.jobs.length)return '<div class="empty">No jobs submitted. Media processing jobs will appear here with progress, events and output assets.</div>';
 return '<div class="runtime-jobs">'+state.jobs.map(j=>'<article class="runtime-job"><div class="runtime-job-heading"><b>'+esc(j.jobType)+'</b><span class="job-status '+esc(j.status)+'">'+esc(j.status)+'</span></div><code>'+esc(j.id)+'</code><div class="progress"><i style="width:'+Math.max(0,Math.min(100,j.progress))+'%"></i></div><small>'+Math.round(j.progress)+'% · '+fmt(j.createdAt)+'</small>'+(j.error?'<p class="job-error">'+esc(j.error.code||"ERROR")+' · '+esc(j.error.message||"")+'</p>':'')+(j.status==="queued"||j.status==="running"?'<button data-ev-cancel="'+esc(j.id)+'">Cancel</button>':'')+((j.output&&typeof j.output==="object"&&"outputAsset" in j.output&&j.output.outputAsset&&typeof j.output.outputAsset==="object"&&"id" in j.output.outputAsset)?'<a class="download-output" href="/api/assets/'+esc((j.output.outputAsset as {id:string}).id)+'/file">Download output · '+esc((j.output.outputAsset as {name?:string}).name||"media file")+'</a>':'')+'</article>').join("")+'</div>';
}
export function renderRuntimeWorkspace(){
 return '<div id="runtime-workspace" data-runtime-view="runtime"><div class="runtime-toolbar">'+statusMarkup()+'<button class="secondary" data-ev-action="refresh">↻ Refresh</button>'+(state.user?'<button class="secondary" data-ev-action="logout">Sign out · '+esc(state.user.email)+'</button>':'')+'</div>'+
 (state.status==="offline"?'<div class="notice">The local API is not reachable. Start the complete stack with <code>npm run dev</code>. Planning workspaces remain available; uploads and processing require the API.</div>':'')+
 (state.status==="auth-required"?'<div class="notice">Sign in to activate persistent project and media storage. Other planning workspaces remain available.</div>':'')+
 '<div class="runtime-summary"><div><small>Projects</small><b>'+state.projects.length+'</b></div><div><small>Stored assets</small><b>'+state.assets.length+'</b></div><div><small>Jobs</small><b>'+state.jobs.length+'</b></div><div><small>Local media tools</small><b>'+(state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Not detected")+'</b></div></div>'+
 '<div class="runtime-two-col"><section class="panel"><div class="eyebrow">PROJECT REGISTRY</div><h3>Persistent projects</h3><form id="ev-project-form"><label>New project name</label><input name="name" required maxlength="160" placeholder="Campaign, film, episode or client project"><button class="primary">Create project</button></form><label>Current project</label><select id="ev-project-select">'+projectOptions()+'</select><div class="runtime-project-list">'+state.projects.map(p=>'<div><b>'+esc(p.name)+'</b><small>'+esc(p.id)+'</small></div>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">MEDIA INGEST</div><h3>Upload original media</h3><p>Originals are stored unchanged. Uploads receive a SHA-256 checksum and remain private to this account.</p><label class="upload primary">＋ Select media<input id="ev-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label><small>250 MiB maximum per file · supported image, video, audio and document types</small><p class="runtime-engine-note">FFmpeg: '+(state.ffmpeg?"available":"not detected")+' · FFprobe: '+(state.ffprobe?"available":"not detected")+'</p></section></div>'+
 '<section class="panel"><div class="eyebrow">REMOTE AI USAGE GUARDRAIL</div><h3>Request allowance</h3>'+(state.remoteUsage?('<div class="runtime-summary"><div><small>Used · rolling 24h</small><b>'+state.remoteUsage.used+'</b></div><div><small>Daily limit</small><b>'+(state.remoteUsage.limit===null?"Config error":state.remoteUsage.limit)+'</b></div><div><small>Remaining</small><b>'+(state.remoteUsage.remaining===null?"—":state.remoteUsage.remaining)+'</b></div><div><small>Remote execution</small><b>'+(state.remoteUsage.configurationValid?(state.remoteUsage.remoteDisabled?"Disabled by limit":"Guarded"):"Blocked · invalid config")+'</b></div></div><p class="runtime-engine-note">'+(state.remoteUsage.configurationValid?"Account-wide remote requests are counted before dispatch. Failed requests remain counted until they age out of the 24-hour window.":"Remote requests fail closed until REMOTE_AI_DAILY_REQUEST_LIMIT is corrected.")+' Cost is not estimated; check provider pricing before enabling remote services.</p>'):'<div class="empty">Usage allowance is unavailable until the API is connected.</div>')+'</section>'+'<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">SOURCE & DERIVATIVE LIBRARY</div><h3>Media assets</h3></div><span>'+state.assets.length+' items</span></div>'+renderAssets()+'</section>'+
 '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">ASYNC PROCESSING</div><h3>Job queue</h3></div><span>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+' active</span></div>'+renderJobs()+'</section>'+
 '<section class="panel"><div class="eyebrow">COLLABORATIVE REVIEW</div><h3>Comments and decisions</h3>'+(state.projectId&&["owner","editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<form id="ev-review-form"><input type="hidden" name="assetId" value=""><p class="review-target" id="ev-review-target">Project-level review · choose “Review asset” on a media item to attach feedback to that asset.</p><label>Decision</label><select name="decision"><option value="comment">Comment</option><option value="request_changes">Request changes</option><option value="approve">Approve</option></select><label>Timecode (seconds, optional)</label><input name="timecode" type="number" min="0" step="0.001" placeholder="12.500"><label>Review note</label><textarea name="body" rows="3" required maxlength="10000" placeholder="Describe the issue, requested change or approval."></textarea><button class="primary">Submit review</button></form>':'<small>Select a project and use an owner, editor or reviewer account to comment or approve.</small>')+
 '<div class="review-list">'+state.reviews.map(r=>'<article><div><b>'+esc(r.decision.replace("_"," "))+(r.asset_id?' · '+esc(state.assets.find(a=>a.id===r.asset_id)?.name||"media asset"):' · project')+'</b><span class="job-status">'+esc(r.status)+'</span></div><p>'+esc(r.body)+'</p><small>'+(r.timecode_seconds===null||r.timecode_seconds===undefined?"No timecode":r.timecode_seconds.toFixed(3)+"s")+' · '+esc(r.created_at)+'</small>'+(state.projects.find(p=>p.id===state.projectId)?.access_role==="owner"||["editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<div><button data-ev-review-status="resolved" data-ev-review-id="'+esc(r.id)+'">Resolve</button><button data-ev-review-status="open" data-ev-review-id="'+esc(r.id)+'">Reopen</button></div>':'')+'</article>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">AUDIT TRAIL</div><h3>Recent workspace events</h3>'+(state.audit.length?'<div class="audit-list">'+state.audit.slice(0,25).map(e=>'<div><b>'+esc(e.type)+'</b><small>'+esc(e.subjectType)+' · '+esc(e.subjectId)+' · '+esc(e.createdAt)+'</small></div>').join("")+'</div>':'<div class="empty">No events recorded yet.</div>')+'</section></div>';
}

export function renderAssetLibrary(){
 return '<div id="runtime-workspace" data-runtime-view="library"><div class="runtime-toolbar">'+statusMarkup()+'<button class="secondary" data-ev-action="refresh">↻ Refresh</button>'+(state.user?'<button class="secondary" data-ev-action="logout">Sign out</button>':'')+'</div>'+
 (state.status==="offline"||state.status==="auth-required"?'<div class="notice">Sign in to use the persistent asset library. Browser planning drafts remain available offline.</div>':'')+
 '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">PRIVATE MEDIA LIBRARY</div><h3>Originals and derivatives</h3></div><span>'+state.assets.length+' stored assets</span></div><label>Project scope</label><select id="ev-project-select">'+projectOptions()+'</select><p>Upload originals, inspect media metadata, create thumbnails, proxies and audio extracts. Source files remain unchanged.</p><label class="upload primary">＋ Import media<input id="ev-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label>'+renderAssets()+'</section>'+
 '<section class="panel"><div class="eyebrow">PROCESSING HISTORY</div><h3>Recent media jobs</h3>'+renderJobs()+'</section></div>';
}
export function renderEngineStatus(){
 const local=state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Unavailable";
 const text=state.textGatewayEnabled&&state.textGatewayConfigured?"Enabled · approval-gated":state.textGatewayEnabled?"Enabled but incomplete":"Disabled by default";
 const image=state.imageGatewayEnabled&&state.imageGatewayConfigured?"Enabled · approval-gated":state.imageGatewayEnabled?"Enabled but incomplete":"Disabled by default";
 return '<div id="runtime-workspace" data-runtime-view="engines"><div class="runtime-toolbar">'+statusMarkup()+'<button class="secondary" data-ev-action="refresh">↻ Refresh status</button></div>'+
 '<div class="runtime-summary"><div><small>Local media engine</small><b>'+local+'</b></div><div><small>Text gateway</small><b>'+text+'</b></div><div><small>Image gateway</small><b>'+image+'</b></div><div><small>Stored assets</small><b>'+state.assets.length+'</b></div><div><small>Active jobs</small><b>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+'</b></div></div>'+
 '<section class="panel"><div class="eyebrow">UNIFIED PROVIDER CONTROL</div><h3>Capability routing & readiness</h3><p>One shared registry for all production workspaces. Status checks do not submit generation requests. Remote execution remains blocked until server-side opt-in is configured.</p><div class="engine-grid">'+state.providers.map(provider=>'<div class="engine"><i></i><b>'+esc(provider.id.replace(/-/g," "))+' · '+esc(provider.status.replace(/_/g," "))+'</b><small>'+esc(provider.model||"No model selected")+' · '+esc(provider.reason)+'</small><small>Capabilities: '+esc(provider.capabilities.join(", "))+'</small></div>').join("")+'</div></section>'+'<section class="panel"><div class="eyebrow">CONNECTED LOCAL ADAPTERS</div><h3>Media processing</h3><div class="engine-grid">'+["Media probe · FFprobe","Thumbnails · FFmpeg","Transcode · FFmpeg","Audio extraction · FFmpeg","Proxy generation · FFmpeg","Denoise · hqdn3d","Color correction · eq","Resize / reframe · scale + pad","Frame interpolation · minterpolate","Upscale / scaling · Lanczos, bicubic, spline36 + sharpening","Speech cleanup · afftdn + loudnorm","Timeline master render · FFmpeg"].map(label=>'<div class="engine"><i></i><b>'+label+'</b><small>'+(state.ffmpeg||label.startsWith("Media probe")&&state.ffprobe?"Local adapter connected":"Engine unavailable")+'</small></div>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">APPROVAL-GATED TEXT ADAPTER</div><h3>Text-model gateway</h3><p>'+text+'. Configure <code>AI_GATEWAY_ENABLED</code>, <code>AI_GATEWAY_URL</code> and <code>AI_GATEWAY_MODEL</code> on the server. The API key remains server-side. A completed upstream human-approval node is required before any text request is sent.</p></section>'+
 '<section class="panel"><div class="eyebrow">APPROVAL-GATED IMAGE ADAPTER</div><h3>Image generation</h3><p>'+image+'. Configure <code>IMAGE_GATEWAY_ENABLED</code>, <code>IMAGE_GATEWAY_URL</code> and <code>IMAGE_GATEWAY_MODEL</code> on the server. Outputs are validated and stored as private assets. A completed upstream human-approval node is required before a request is sent.</p></section><section class="panel"><div class="eyebrow">NOT CONNECTED</div><h3>Other external media generation</h3><p>Remote video generation, voice generation, dubbing, lip-sync, neural restoration models and publishing adapters are not connected. Local video denoise, color correction, resize/reframe, interpolation and scaling are available from video asset actions. Their nodes fail closed; the application does not pretend a missing provider has completed a job.</p></section></div>';
}
export function renderRuntimeOverview(){
 return '<div id="runtime-workspace" data-runtime-view="overview" class="stats"><div><small>Persistent projects</small><b>'+state.projects.length+'</b><span>API-backed</span></div><div><small>Stored assets</small><b>'+state.assets.length+'</b><span>Private media storage</span></div><div><small>Active jobs</small><b>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+'</b><span>Leased worker queue</span></div><div><small>Local media tools</small><b>'+(state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Unavailable")+'</b><span>FFmpeg / FFprobe</span></div></div>';
}

export function getCurrentProjectId(){return state.projectId;}
export function canEditCurrentProject(){const project=state.projects.find(item=>item.id===state.projectId);return Boolean(project&&["owner","editor"].includes(project.access_role||""));}
export async function importResearchIntoProject(projectId:string,url:string){
 const project=state.projects.find(item=>item.id===projectId);
 if(!project||!["owner","editor"].includes(project.access_role||""))throw new Error("Owner or editor access is required to import research.");
 const workspace=await loadCreativeDraft(projectId);
 if(!workspace)throw new Error("Project workspace is not available.");
 const result=await apiRequest<{ok:boolean;revision:number;source:Record<string,unknown>;record:Record<string,unknown>;extracted:{contentType:string;characterCount:number}}>("/api/projects/"+projectId+"/research/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({revision:workspace.revision,url})});
 workspaceRevisions.set(projectId,result.revision);
 return result;
}
export async function loadCreativeDraft(projectId=state.projectId){
 if(!projectId||state.status!=="online")return null;
 const result=await apiRequest<{document:Record<string,unknown>;revision:number}>("/api/projects/"+projectId+"/workspace");
 workspaceRevisions.set(projectId,result.revision);
 return result;
}
function queueCreativeDraft(document:Record<string,unknown>){
 const projectId=state.projectId;
 const project=state.projects.find(item=>item.id===projectId);
 if(!projectId||state.status!=="online"||!project||!["owner","editor"].includes(project.access_role||""))return;
 const old=workspaceSaveTimers.get(projectId);if(old)clearTimeout(old);
 const timer=setTimeout(()=>{
  workspaceSaveTimers.delete(projectId);
  workspaceSaveChain=workspaceSaveChain.then(async()=>{
   const current=state.projects.find(item=>item.id===projectId);
   if(state.status!=="online"||!current||!["owner","editor"].includes(current.access_role||""))return;
   const revision=workspaceRevisions.get(projectId)||0;
   const result=await apiRequest<{revision:number}>("/api/projects/"+projectId+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision,document})});
   workspaceRevisions.set(projectId,result.revision);
  }).catch(error=>{state.message=error instanceof Error?"Creative draft save failed: "+error.message:"Creative draft save failed.";paint();});
 },600);
 workspaceSaveTimers.set(projectId,timer);
}
window.addEventListener("ev:save-creative-draft",event=>{
 const detail=(event as CustomEvent<Record<string,unknown>>).detail;
 if(detail&&typeof detail==="object")queueCreativeDraft(detail);
});

async function refresh(){
 const previousProjectId=state.projectId;
 const [projects,assets,jobs,audit,providerCatalog,usageResponse]=await Promise.all([
  apiRequest<{projects:RuntimeProject[]}>("/api/projects"),
  apiRequest<{assets:RuntimeAsset[]}>("/api/assets"),
  apiRequest<{jobs:RuntimeJob[]}>("/api/jobs"),
  apiRequest<{events:Array<Record<string,unknown>>}>("/api/audit"),
  apiRequest<{providers:ProviderStatus[]}>("/api/providers"),
  apiRequest<{remoteUsage:RemoteUsage}>("/api/usage")
 ]);
 state.projects=projects.projects;state.assets=assets.assets;state.jobs=jobs.jobs;state.audit=audit.events;state.providers=providerCatalog.providers;state.remoteUsage=usageResponse.remoteUsage;window.dispatchEvent(new Event("ev:assets-updated"));
 if(state.projectId&&!state.projects.some(p=>p.id===state.projectId))state.projectId="";
 if(!state.projectId&&state.projects.length)state.projectId=state.projects[0].id;
 if(previousProjectId!==state.projectId)window.dispatchEvent(new CustomEvent("ev:project-changed",{detail:{projectId:state.projectId}}));
 if(state.projectId){try{const response=await apiRequest<{members:Array<{id:string;email:string;role:string;createdAt:string}>}>("/api/projects/"+state.projectId+"/members");state.members=response.members;}catch{state.members=[];}
  try{const response=await apiRequest<{reviews:RuntimeReview[]}>("/api/reviews?projectId="+encodeURIComponent(state.projectId));state.reviews=response.reviews;}catch{state.reviews=[];}
 }
 else {state.members=[];state.reviews=[];}
}
function paint(){updateShell();renderGate();const root=document.querySelector<HTMLElement>("#runtime-workspace");if(root){const view=root.dataset.runtimeView;root.outerHTML=view==="library"?renderAssetLibrary():view==="engines"?renderEngineStatus():view==="overview"?renderRuntimeOverview():renderRuntimeWorkspace();}}
export async function initRuntime(){
 try{
  const health=await apiRequest<{authMode:"local"|"supabase";media:{ffmpeg:boolean;ffprobe:boolean};textGateway:{enabled:boolean;configured:boolean};imageGateway:{enabled:boolean;configured:boolean}}>("/api/health");
  state.authMode=health.authMode;state.ffmpeg=health.media.ffmpeg;state.ffprobe=health.media.ffprobe;state.textGatewayEnabled=health.textGateway.enabled;state.textGatewayConfigured=health.textGateway.configured;state.imageGatewayEnabled=health.imageGateway.enabled;state.imageGatewayConfigured=health.imageGateway.configured;
  try{const me=await apiRequest<{user:RuntimeUser}>("/api/me");state.user=me.user;state.status="online";await refresh();window.dispatchEvent(new Event("ev:authenticated"));}
  catch(error){if(error instanceof ApiError&&error.status===401)state.status="auth-required";else throw error;}
 }catch(error){state.status="offline";state.message=error instanceof Error?error.message:"API unavailable";}
 paint();
}
async function authenticate(form:HTMLFormElement){
 const data=new FormData(form);
 try{
  if(form.id==="ev-auth-token"){setApiAccessToken(String(data.get("token")||""));}
  else{
   const mode=String(data.get("mode")||"login");
   const response=await apiRequest<{user:RuntimeUser}>("/api/auth/"+(mode==="register"?"register":"login"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),password:String(data.get("password"))})});
   state.user=response.user;
  }
  const me=await apiRequest<{user:RuntimeUser}>("/api/me");state.user=me.user;state.status="online";state.message="";await refresh();window.dispatchEvent(new Event("ev:authenticated"));paint();
 }catch(error){clearApiAccessToken();state.status="auth-required";state.message=error instanceof Error?error.message:"Authentication failed.";paint();}
}
document.addEventListener("submit",event=>{
 const form=event.target as HTMLFormElement;
 if(form.id==="ev-auth"||form.id==="ev-auth-token"){event.preventDefault();void authenticate(form);}
 if(form.id==="ev-project-form"){event.preventDefault();const name=String(new FormData(form).get("name")||"").trim();if(!name)return;void apiRequest<{project:RuntimeProject}>("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})}).then(async result=>{state.projectId=result.project.id;await refresh();window.dispatchEvent(new CustomEvent("ev:project-changed",{detail:{projectId:state.projectId}}));paint();}).catch(error=>alert(error.message||error));}
 if(form.id==="ev-member-form"){event.preventDefault();const data=new FormData(form);void apiRequest("/api/projects/"+state.projectId+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),role:String(data.get("role"))})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
 if(form.id==="ev-review-form"){event.preventDefault();const data=new FormData(form),timecode=String(data.get("timecode")||"");void apiRequest("/api/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:state.projectId,decision:String(data.get("decision")),body:String(data.get("body")),assetId:String(data.get("assetId")||"")||null,timecodeSeconds:timecode?Number(timecode):null})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLInputElement;
 if(target.id==="ev-project-select"){state.projectId=target.value;void refresh().then(()=>{window.dispatchEvent(new CustomEvent("ev:project-changed",{detail:{projectId:state.projectId}}));paint();}).catch(error=>alert(error.message||error));return;}
 if(target.id==="ev-upload"&&target.files){const files=Array.from(target.files);void (async()=>{for(const file of files){try{await apiRequest("/api/assets",{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-file-name":encodeURIComponent(file.name),"x-project-id":state.projectId},body:file});}catch(error){alert(file.name+": "+(error instanceof Error?error.message:"Upload failed"));}}await refresh();paint();})();}
});
document.addEventListener("click",event=>{
 const target=event.target as HTMLElement;
 const authMode=target.closest<HTMLElement>("[data-auth-mode]");if(authMode){const form=document.querySelector<HTMLFormElement>("#ev-auth");const mode=form?.elements.namedItem("mode") as HTMLInputElement|null;if(mode)mode.value=authMode.dataset.authMode||"login";document.querySelectorAll("[data-auth-mode]").forEach(button=>button.classList.toggle("active",button===authMode));return;}
 const action=target.closest<HTMLElement>("[data-ev-action]");
 if(action?.dataset.evAction==="refresh"){void refresh().then(paint).catch(error=>alert(error.message||error));return;}
 if(action?.dataset.evAction==="logout"){void apiRequest("/api/auth/logout",{method:"POST"}).catch(()=>{});clearApiAccessToken();state.user=null;state.status="auth-required";state.jobs=[];state.assets=[];state.projects=[];paint();return;}
 const job=target.closest<HTMLElement>("[data-ev-job]");
 if(job){const assetId=job.dataset.evAsset||"",jobType=job.dataset.evJob||"",input:Record<string,unknown>={};for(const [key,value] of Object.entries(job.dataset))if(key.startsWith("ev")&&!["evAsset","evJob"].includes(key)){const name=key.slice(2).replace(/^[A-Z]/,letter=>letter.toLowerCase());input[name]=value!==""&&Number.isFinite(Number(value))?Number(value):value;}void apiRequest("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType,sourceAssetId:assetId,projectId:state.projectId||undefined,...input})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const remove=target.closest<HTMLElement>("[data-ev-remove-member]");
 if(remove){void apiRequest("/api/projects/"+state.projectId+"/members/"+remove.dataset.evRemoveMember,{method:"DELETE"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const reviewAsset=target.closest<HTMLElement>("[data-ev-review-asset]");
 if(reviewAsset){const form=document.querySelector<HTMLFormElement>("#ev-review-form");if(form){const field=form.elements.namedItem("assetId") as HTMLInputElement|null;if(field)field.value=reviewAsset.dataset.evReviewAsset||"";const asset=state.assets.find(item=>item.id===field?.value);const label=document.querySelector<HTMLElement>("#ev-review-target");if(label)label.textContent="Review attached to: "+(asset?.name||"selected media");form.scrollIntoView({behavior:"smooth",block:"center"});(form.elements.namedItem("body") as HTMLTextAreaElement|null)?.focus();}return;}
 const lineageButton=target.closest<HTMLElement>("[data-ev-lineage]");
 if(lineageButton){const assetId=lineageButton.dataset.evLineage||'';if(state.lineageExpanded.has(assetId)){state.lineageExpanded.delete(assetId);paint();return;}state.lineageExpanded.add(assetId);if(state.lineage.has(assetId)){paint();return;}state.lineageLoading.add(assetId);state.lineageErrors.delete(assetId);paint();void apiRequest<{lineage:AssetLineage}>("/api/cloud/assets/"+encodeURIComponent(assetId)+"/lineage").then(result=>{state.lineage.set(assetId,result.lineage);state.lineageLoading.delete(assetId);paint();}).catch(error=>{state.lineageLoading.delete(assetId);state.lineageErrors.set(assetId,error instanceof Error?error.message:'Unable to load asset lineage.');paint();});return;}
 const review=target.closest<HTMLElement>("[data-ev-review-status]");
 if(review){void apiRequest("/api/reviews/"+review.dataset.evReviewId,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({status:review.dataset.evReviewStatus})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const cancel=target.closest<HTMLElement>("[data-ev-cancel]");
 if(cancel){void apiRequest("/api/jobs/"+cancel.dataset.evCancel+"/cancel",{method:"POST"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
});
