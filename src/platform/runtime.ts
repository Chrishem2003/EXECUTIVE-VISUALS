import { apiRequest, apiRequestWithBearer, ApiError } from "../core/api";

type RuntimeUser={id:string;email:string};
type RuntimeProject={id:string;name:string;description?:string;revision?:number;access_role?:"owner"|"editor"|"reviewer"|"viewer"};
type RuntimeAsset={id:string;projectId?:string|null;name:string;mediaType:string;size:number;sha256:string;derivativeOf?:string|null;metadata?:Record<string,unknown>;createdAt:string};
type RuntimeJob={id:string;projectId?:string|null;jobType:string;status:string;progress:number;input:Record<string,unknown>;output?:Record<string,unknown>|null;error?:{code?:string;message?:string}|null;createdAt:string;updatedAt:string};
type RuntimeReview={id:string;project_id:string;asset_id?:string|null;timecode_seconds?:number|null;decision:string;body:string;status:string;created_at:string};
type C2paVerification={status:"trusted"|"valid_untrusted"|"invalid"|"not_present"|"validation_unavailable";present:boolean;valid:boolean;trusted:boolean;assetSha256:string;validationState:string|null;findings:string[];manifest:null|{title:string|null;format:string|null;claimGenerator:string|null;ingredientCount:number;ingredients:Array<{title:string|null;format:string|null;relationship:string|null;hasManifestData:boolean}>};validationStatuses:Array<{code:string;success:boolean|null;explanation:string|null}>};
type C2paInspectionState={loading:boolean;verification?:C2paVerification;notice?:string;error?:string};
type ProviderStatus={id:string;provider:string;enabled:boolean;configured:boolean;remote:boolean;model:string|null;availableModels?:Array<{id:string;label:string;minDurationSeconds?:number;maxDurationSeconds?:number;aspectRatios?:string[];resolutions?:string[];inputModes?:string[];readiness?:string;available?:boolean;executionVerified?:boolean;qualityVerified?:boolean;reason?:string}>;status:"ready"|"disabled"|"needs_configuration"|"remote_opt_in_required"|"unavailable"|"unverified";reason:string;capabilities:string[]};
type RemoteUsage={window:string;configurationValid:boolean;limit:number|null;used:number;remaining:number|null;projectUsed:number|null;remoteDisabled:boolean};
let workspaceRevisions=new Map<string,number>();
let workspaceSaveTimers=new Map<string,ReturnType<typeof setTimeout>>();
let workspaceSaveChain:Promise<void>=Promise.resolve();
const state:{status:"checking"|"offline"|"auth-required"|"online";authMode:"local"|"supabase";authView:"login"|"recover"|"reset";recoveryToken:string;dataDirectoryPersistence:"unknown"|"ephemeral"|"unverified"|"operator-confirmed-volume";persistentVolumeRequired:boolean;user:RuntimeUser|null;projects:RuntimeProject[];assets:RuntimeAsset[];jobs:RuntimeJob[];audit:Array<Record<string,unknown>>;members:Array<{id:string;email:string;role:string;createdAt:string}>;reviews:RuntimeReview[];projectId:string;message:string;ffmpeg:boolean;ffprobe:boolean;textGatewayEnabled:boolean;textGatewayConfigured:boolean;imageGatewayEnabled:boolean;imageGatewayConfigured:boolean;providers:ProviderStatus[];remoteUsage:RemoteUsage|null;c2paInspections:Record<string,C2paInspectionState>}={
 status:"checking",authMode:"local",authView:"login",recoveryToken:"",dataDirectoryPersistence:"unknown",persistentVolumeRequired:false,user:null,projects:[],assets:[],jobs:[],audit:[],members:[],reviews:[],projectId:"",message:"",ffmpeg:false,ffprobe:false,textGatewayEnabled:false,textGatewayConfigured:false,imageGatewayEnabled:false,imageGatewayConfigured:false,providers:[],remoteUsage:null,c2paInspections:{}
};
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const fmt=(value:string)=>new Date(value).toLocaleString();
const C2PA_SUPPORTED_MEDIA_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif","audio/mpeg","audio/wav","audio/x-wav","audio/mp4","video/mp4","video/quicktime"]);
function statusMarkup(){return '<span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="online"?"API CONNECTED":state.status==="auth-required"?"SIGN IN REQUIRED":state.status==="offline"?"OFFLINE":"CONNECTING")+'</span>';}
function updateShell(){
 const project=state.projects.find(item=>item.id===state.projectId);
 const projectLabel=document.querySelector<HTMLElement>("#project-name");
 if(projectLabel)projectLabel.textContent=project?.name||"No project selected";
 const foot=document.querySelector<HTMLElement>(".sidebar-foot small");
 if(foot)foot.textContent=state.status==="online"?(state.dataDirectoryPersistence==="ephemeral"?"Preview storage · temporary":state.dataDirectoryPersistence==="operator-confirmed-volume"?"Persistent volume · operator configured":"Storage persistence unverified"):state.status==="auth-required"?"Sign in to access account-backed projects":state.status==="offline"?"API offline · local planning only":"Connecting to API";
 const footTitle=document.querySelector<HTMLElement>(".sidebar-foot b");
 if(footTitle)footTitle.textContent=state.user?state.user.email:"Executive Visuals";
 const footIcon=document.querySelector<HTMLElement>(".sidebar-foot .local-dot");
 if(footIcon){footIcon.textContent=state.user?state.user.email.trim().slice(0,1).toUpperCase():"";footIcon.classList.toggle("account-avatar",Boolean(state.user));footIcon.style.background=state.user?"#252039":state.status==="online"?"#68c9a2":state.status==="offline"?"#d8a65b":"#8791a1";}
 const badge=document.querySelector<HTMLElement>(".local-badge");
 if(badge)badge.textContent=state.status==="online"?"API CONNECTED":state.status==="auth-required"?"SIGN IN REQUIRED":state.status==="offline"?"OFFLINE MODE":"CONNECTING";
 const dot=document.querySelector<HTMLElement>(".local-dot");
 if(dot&&!state.user)dot.style.background=state.status==="online"?"#68c9a2":state.status==="offline"?"#d8a65b":"#8791a1";
 const actions=document.querySelector<HTMLElement>(".topbar > div:last-child");
 if(actions){
  let chip=actions.querySelector<HTMLButtonElement>(".ev-account-chip");
  if(state.user){
   if(!chip){chip=document.createElement("button");chip.type="button";chip.className="ev-account-chip";chip.dataset.tab="runtime";chip.setAttribute("aria-label","Open account and workspace console");actions.insertBefore(chip,actions.firstChild);}
   const initials=state.user.email.trim().slice(0,1).toUpperCase();
   chip.innerHTML='<span class="ev-account-avatar">'+esc(initials)+'</span><span class="ev-account-copy"><b>'+esc(state.user.email)+'</b><small>'+esc(project?.access_role||"Personal account")+' · '+esc(project?.name||"Personal workspace")+'</small></span><span class="ev-account-chevron">⌄</span>';
   chip.title="Signed in as "+state.user.email+" · Open account and workspace console";
  }else chip?.remove();
 }
}
function renderGate(){
 document.querySelector("#ev-auth-gate")?.remove();
 if(state.status!=="auth-required")return;
 const external=state.authMode==="supabase";
 if(external&&(state.authView==="recover"||state.authView==="reset")){const reset=state.authView==="reset";const title=reset?"Choose a new password":"Reset your password";const description=reset?"Set a new password for your Executive Visuals account.":"Enter your account email. If an account exists, Supabase will send a secure recovery link.";const form=reset?'<form id="ev-auth-reset"><label>New password</label><input name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"><label>Confirm new password</label><input name="confirmPassword" type="password" minlength="12" maxlength="256" required autocomplete="new-password"><button class="primary wide" type="submit">Update password</button></form>':'<form id="ev-auth-recover"><label>Email address</label><input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"><button class="primary wide" type="submit">Send recovery email</button></form>';document.body.insertAdjacentHTML("beforeend",'<main id="ev-auth-gate" class="auth-landing"><section class="auth-story"><a class="auth-brand" href="#" aria-label="Executive Visuals home"><span class="brand-mark">EV</span><span><b>EXECUTIVE</b><small>VISUALS STUDIO</small></span></a><div class="auth-story-copy"><div class="eyebrow">ACCOUNT SECURITY</div><h1>Get back to<br>your <em>studio.</em></h1><p>Secure account recovery for your private production workspace.</p></div><div class="auth-story-footer">EXECUTIVE VISUALS · ACCOUNT SECURITY</div></section><section class="auth-panel-wrap"><div class="auth-card auth-card-modern"><div class="eyebrow">YOUR PRIVATE STUDIO</div><h2>'+title+'</h2><p>'+description+'</p>'+form+'<button class="secondary auth-back" type="button" data-auth-view="login">Back to sign in</button><p class="auth-error">'+esc(state.message)+'</p><small class="auth-footnote">Recovery links are short-lived. Never share them with anyone. If your link has expired, request a new one.</small></div></section></main>');return;}
 document.body.insertAdjacentHTML("beforeend",'<main id="ev-auth-gate" class="auth-landing"><section class="auth-story"><a class="auth-brand" href="#" aria-label="Executive Visuals home"><span class="brand-mark">EV</span><span><b>EXECUTIVE</b><small>VISUALS STUDIO</small></span></a><div class="auth-story-copy"><div class="eyebrow">YOUR PRODUCTION WORKSPACE</div><h1>Plan the work.<br>Make it <em>real.</em></h1><p>A focused place to develop briefs, manage source media, edit timelines and prepare finished work.</p><div class="auth-feature-list"><div><i>✳</i><span><b>Develop the direction</b><small>Creative briefs, series plans and storyboards.</small></span></div><div><i>▤</i><span><b>Keep production organised</b><small>Projects, source media, timelines and versions.</small></span></div><div><i>◈</i><span><b>Review before delivery</b><small>Caption, rights, quality and master checks.</small></span></div></div></div><div class="auth-story-footer">EXECUTIVE VISUALS · CREATIVE PRODUCTION</div></section><section class="auth-panel-wrap"><div class="auth-card auth-card-modern"><div class="eyebrow">YOUR PRIVATE STUDIO</div><h2>'+(external?"Sign in to your studio":"Welcome back")+'</h2><p>'+(external?"Use your workspace email and password. New accounts may need email confirmation.":"Sign in to continue, or create a local development account to explore the workspace.")+'</p><div class="auth-switch" role="group" aria-label="Account action"><button type="button" class="active" data-auth-mode="login">Sign in</button><button type="button" data-auth-mode="register">Create account</button></div><form id="ev-auth"><input type="hidden" name="mode" value="login"><label>Email address</label><input name="email" type="email" required autocomplete="username" placeholder="you@example.com"><label>Password</label><input name="password" type="password" minlength="12" required autocomplete="current-password" placeholder="At least 12 characters"><button class="primary wide" type="submit">Continue securely</button></form><div class="auth-security"><span>⌑</span><div><b>Private by design</b><small>Your projects and media remain account-scoped. Authentication is handled by the configured service.</small></div></div><p class="auth-error">'+esc(state.message)+'</p><small class="auth-footnote">'+(external?"Supabase handles your password and email verification. Session cookies are HttpOnly.":"Local password accounts are for development only. Production sign-in requires the configured external identity service.")+'</small></div></section></main>');
 if(external){document.querySelector("#ev-auth")?.insertAdjacentHTML("afterend",'<button class="auth-forgot" type="button" data-auth-view="recover">Forgot your password?</button>');}
}
function renderProjectMembers(){
 const project=state.projects.find(item=>item.id===state.projectId);
 if(!project)return '<section class="panel"><div class="eyebrow">PROJECT COLLABORATION</div><h3>Project members & access</h3><div class="empty">Select a project to view its collaborators and access roles.</div></section>';
 const owner=project.access_role==="owner";
 const rows=state.members.length?state.members.map(member=>'<article class="ev-member-row"><span class="ev-member-avatar">'+esc(member.email.trim().slice(0,1).toUpperCase())+'</span><span class="ev-member-identity"><b>'+esc(member.email)+'</b><small>Added '+esc(fmt(member.createdAt))+'</small></span><span class="ev-member-role">'+esc(member.role)+'</span>'+(owner?'<button class="quiet" type="button" data-ev-remove-member="'+esc(member.id)+'" aria-label="Remove '+esc(member.email)+' from project">Remove</button>':'')+'</article>').join(""):'<div class="empty">No additional members have access to this project yet.</div>';
 return '<section class="panel ev-members-panel"><div class="runtime-section-heading"><div><div class="eyebrow">PROJECT COLLABORATION</div><h3>Members & access</h3></div><span>'+state.members.length+' collaborator(s)</span></div><div class="ev-current-access"><b>You · '+esc(project.access_role||"member")+'</b><small>Current project: '+esc(project.name)+'</small></div><div class="ev-member-list">'+rows+'</div>'+(owner?'<form id="ev-member-form" class="ev-member-form"><div><label for="ev-member-email">Add an existing account by email</label><input id="ev-member-email" name="email" type="email" required maxlength="254" placeholder="teammate@example.com"><small>They must already have an account in this workspace. Access is granted immediately; this does not send an email invitation.</small></div><div><label for="ev-member-role">Project role</label><select id="ev-member-role" name="role"><option value="editor">Editor · edit project work</option><option value="reviewer">Reviewer · comment and approve</option><option value="viewer">Viewer · read-only access</option></select></div><button class="primary" type="submit">Add project member</button></form>':'<p class="muted">Only the project owner can add or remove members. Your '+esc(project.access_role||"member")+' access is read-only for membership settings.</p>')+'</section>';
}
function projectOptions(){return '<option value="">Personal library</option>'+state.projects.map(p=>'<option value="'+esc(p.id)+'" '+(state.projectId===p.id?"selected":"")+'>'+esc(p.name)+'</option>').join("");}

function renderC2paInspection(assetId:string){
 const inspection=state.c2paInspections[assetId];
 if(!inspection)return "";
 if(inspection.loading)return '<section class="c2pa-inspection"><b>Content Credentials</b><span class="job-status">Inspecting…</span><p>Checking the stored-file checksum and validating any embedded C2PA manifest.</p></section>';
 if(inspection.error)return '<section class="c2pa-inspection"><b>Content Credentials inspection unavailable</b><p class="job-error">'+esc(inspection.error)+'</p></section>';
 const result=inspection.verification;if(!result)return "";
 const labels:Record<string,string>={trusted:"Trusted certificate chain",valid_untrusted:"Valid signature · signer not trusted",invalid:"Invalid Content Credentials",not_present:"No embedded Content Credentials",validation_unavailable:"Validation unavailable"};
 const ingredients=result.manifest?.ingredients||[];
 const validation=result.validationStatuses||[];
 return '<section class="c2pa-inspection"><div class="c2pa-inspection-heading"><b>Content Credentials</b><span class="job-status '+(result.trusted?"succeeded":result.status==="invalid"?"failed":"")+'">'+esc(labels[result.status]||result.status)+'</span></div>'+
  (result.manifest?'<div class="c2pa-manifest-summary"><b>'+esc(result.manifest.title||"Untitled manifest")+'</b><small>'+esc(result.manifest.format||"Unknown format")+' · Generator: '+esc(result.manifest.claimGenerator||"Not recorded")+'</small><small>'+result.manifest.ingredientCount+' declared ingredient(s)</small></div>':'')+
  (ingredients.length?'<div class="c2pa-ingredients"><b>Source ingredients</b>'+ingredients.map(item=>'<div><span>'+esc(item.title||"Untitled source")+'</span><small>'+esc(item.relationship||"relationship unavailable")+' · '+esc(item.format||"unknown format")+' · '+(item.hasManifestData?"embedded source manifest":"no embedded source manifest")+'</small></div>').join("")+'</div>':'')+
  (result.findings.length?'<div class="c2pa-findings"><b>Findings</b><ul>'+result.findings.map(item=>'<li>'+esc(item)+'</li>').join("")+'</ul></div>':'')+
  (validation.length?'<details class="c2pa-validation"><summary>Validation details · '+validation.length+'</summary>'+validation.map(item=>'<div><b>'+esc(item.code)+'</b><small>'+(item.success===true?"Passed":item.success===false?"Failed":"Informational")+(item.explanation?" · "+esc(item.explanation):"")+'</small></div>').join("")+'</details>':'')+
  '<small class="c2pa-trust-note">Asset SHA-256 verified · '+esc(result.assetSha256.slice(0,20))+'…</small>'+
  '<p class="c2pa-trust-note">'+esc(inspection.notice||"Signature validity, signer trust, identity, rights clearance and factual accuracy are separate checks.")+'</p></section>';
}
export function renderAiUpscaleReadiness():string{
 const provider=state.providers.find(item=>item.id==="ai-upscale");
 const models=provider?.availableModels||[];
 const modelCards=models.map(model=>{
  const readiness=model.readiness||"unverified";
  const label=readiness==="ready"?"QUALITY VERIFIED":readiness==="quality_review_required"?"QUALITY REVIEW REQUIRED":readiness==="unavailable"?"NOT INSTALLED":readiness==="disabled"?"DISABLED":"EXECUTION UNVERIFIED";
  const stateClass=readiness==="ready"?"is-ready":"is-locked";
  const execution=model.executionVerified?"Execution self-test passed":"Execution self-test not verified";
  const quality=model.qualityVerified?"Five-category visual review verified":"Independent five-category human review required";
  return '<article class="ai-upscale-model"><div class="ai-upscale-model-head"><strong>'+esc(model.label||model.id)+'</strong><span class="ai-upscale-state '+stateClass+'" role="status">'+label+'</span></div><p>'+esc(model.reason||"No model-specific readiness explanation was returned.")+'</p><div class="ai-upscale-footnote">'+esc(execution)+' · '+esc(quality)+'</div></article>';
 }).join("");
 const explanation=provider?.reason||"The worker has not reported AI super-resolution readiness yet. Refresh runtime status after the worker is connected.";
 return '<section class="ai-upscale-controls" aria-label="AI super-resolution model readiness"><div class="ai-upscale-heading"><div><small class="ai-upscale-label">NEURAL IMAGE RESTORATION</small><strong>Real-ESRGAN model readiness</strong></div><span class="ai-upscale-original">SOURCE PRESERVED</span></div>'+(models.length?'<div class="ai-upscale-model-grid">'+modelCards+'</div>':'<p class="ai-upscale-footnote">No model readiness records are available. '+esc(explanation)+'</p>')+'<p class="ai-upscale-footnote">A model is unlocked only after its own installation, execution self-test and complete five-category human-reviewed quality evidence pass. This panel reports readiness; it does not submit inference or incur provider charges.</p></section>';
}
function renderAiUpscaleControls(assetId:string):string{
 const provider=state.providers.find(item=>item.id==="ai-upscale");
 const models=provider?.availableModels||[];
 const general=models.find(item=>item.id==="realesrgan-x4plus");
 const anime=models.find(item=>item.id==="realesrgan-x4plus-anime");
 const button=(model:string,scale:number,label:string,readiness:{id:string;readiness?:string;reason?:string}|undefined)=>{
  const ready=readiness?.readiness==="ready";
  const title=readiness?.reason||provider?.reason||"Model-specific readiness has not been reported.";
  return '<button type="button" '+(ready?'':'disabled aria-disabled="true"')+' aria-label="'+label+'" title="'+esc(title)+'" data-ev-job="media.ai-upscale" data-ev-asset="'+esc(assetId)+'" data-ev-model="'+model+'" data-ev-scale="'+scale+'" data-ev-tile="0" data-ev-format="png">'+label+'</button>';
 };
 const modelCard=(label:string,readiness:{id:string;readiness?:string;reason?:string}|undefined,presets:string)=>{
  const ready=readiness?.readiness==="ready";
  const stateLabel=ready?"READY":readiness?.readiness==="unavailable"?"NOT INSTALLED":readiness?.readiness==="disabled"?"DISABLED":"LOCKED";
  const reason=readiness?.reason||"The worker has not reported readiness for this model.";
  return '<section class="ai-upscale-model" aria-label="'+label+' model presets"><div class="ai-upscale-model-head"><strong>'+label+'</strong><span class="ai-upscale-state '+(ready?'is-ready':'is-locked')+'" role="status">'+stateLabel+'</span></div><div class="ai-upscale-presets">'+presets+'</div><p>'+esc(reason)+'</p></section>';
 };
 const stateText=provider?.reason||"The worker has not reported AI upscaling readiness.";
 return '<section class="ai-upscale-controls" aria-label="AI image super-resolution"><div class="ai-upscale-heading"><div><small class="ai-upscale-label">IMAGE FINISHING</small><strong>AI super-resolution</strong></div><span class="ai-upscale-original">ORIGINAL PRESERVED</span></div><div class="ai-upscale-model-grid">'+
  modelCard("General-purpose",general,button("realesrgan-x4plus",2,"2×",general)+button("realesrgan-x4plus",3,"3×",general)+button("realesrgan-x4plus",4,"4×",general))+
  modelCard("Anime & illustration",anime,button("realesrgan-x4plus-anime",4,"4×",anime))+
  '</div><p class="ai-upscale-footnote">'+esc(stateText)+' Each model must pass its own installation, execution and reviewed-quality checks. Results are saved as separate derivatives; the source asset is not overwritten.</p></section>';
}

function renderAssets(){
 if(!state.assets.length)return '<div class="empty">No stored media yet. Upload a source file to begin.</div>';
 return '<div class="runtime-assets">'+state.assets.map(a=>{
  const isVideo=a.mediaType.startsWith("video/"),isAudio=a.mediaType.startsWith("audio/"),isImage=a.mediaType.startsWith("image/");
  const file="/api/assets/"+esc(a.id)+"/file";
  const preview=isImage?'<img loading="lazy" src="'+file+'" alt="">':isVideo?'<video controls preload="metadata" src="'+file+'"></video>':isAudio?'<audio controls preload="metadata" src="'+file+'"></audio>':'<a href="'+file+'" target="_blank" rel="noopener">Open file</a>';
  const sourceAsset=a.derivativeOf?state.assets.find(item=>item.id===a.derivativeOf):undefined;
  const processing=a.metadata&&typeof a.metadata==="object"&&a.metadata.processing&&typeof a.metadata.processing==="object"?a.metadata.processing as Record<string,unknown>:{};
  const tileSummary=Number.isInteger(processing.tile)?" · tile "+(processing.tile===0?"auto":String(processing.tile))+(Number.isInteger(processing.requestedTile)&&processing.requestedTile!==processing.tile?" (requested "+(processing.requestedTile===0?"auto":String(processing.requestedTile))+")":""):"";
  const tileFallbackSummary=processing.tileFallbackUsed===true?" · VRAM fallback "+(Array.isArray(processing.tileAttempts)?processing.tileAttempts.map(String).join(" → "):"applied"):"";
  const lineage=sourceAsset&&isImage?'<section class="asset-comparison"><div class="eyebrow">SOURCE / ENHANCED REVIEW</div><div class="asset-compare-wipe" data-ev-compare style="--ev-compare:50%"><div class="asset-compare-stage"><img class="asset-compare-source" loading="lazy" src="/api/assets/'+esc(sourceAsset.id)+'/file" alt="Original source image"><div class="asset-compare-enhanced"><img loading="lazy" src="'+file+'" alt="Enhanced derivative image"></div><span class="asset-compare-divider" aria-hidden="true"></span><span class="asset-compare-tag asset-compare-tag-source">ORIGINAL</span><span class="asset-compare-tag asset-compare-tag-enhanced">ENHANCED</span></div><label class="asset-compare-control"><span>Drag to compare original and enhanced</span><input type="range" min="0" max="100" value="50" data-ev-compare-slider aria-label="Reveal enhanced image over original" aria-valuetext="50% enhanced revealed"></label><div class="asset-compare-links"><a href="/api/assets/'+esc(sourceAsset.id)+'/file" target="_blank" rel="noopener">Open original</a><a href="'+file+'" target="_blank" rel="noopener">Open enhanced</a></div></div><p>'+esc(processing.method||"Processed derivative")+' · '+esc(processing.model||"model not recorded")+' · '+esc(processing.scale?String(processing.scale)+"×":"scale not recorded")+(processing.dimensionsVerified?" · dimensions verified":"")+tileSummary+tileFallbackSummary+'</p><small>Original SHA-256: '+esc(sourceAsset.sha256.slice(0,16))+'… · Enhanced SHA-256: '+esc(a.sha256.slice(0,16))+'…</small></section>':'';
  const c2paAction=(isImage||isVideo||isAudio)?(C2PA_SUPPORTED_MEDIA_TYPES.has(a.mediaType)?'<button data-ev-c2pa="'+esc(a.id)+'">Inspect Content Credentials</button>':'<small class="c2pa-unsupported-note">C2PA inspection is not supported for this media format.</small>'):"";
  const actions='<a class="download-output" href="'+file+'" target="_blank" rel="noopener">Open original</a>'+c2paAction+(state.projectId&&["owner","editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<button data-ev-review-asset="'+esc(a.id)+'">Review asset</button>':'')+'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect</button>'+(isVideo?'<button data-ev-job="media.thumbnail" data-ev-asset="'+esc(a.id)+'">Extract frame</button><button data-ev-job="media.proxy" data-ev-asset="'+esc(a.id)+'">Create proxy</button><button data-ev-job="media.audio_extract" data-ev-asset="'+esc(a.id)+'">Extract audio</button><button data-ev-job="media.denoise" data-ev-asset="'+esc(a.id)+'" data-ev-luma="4" data-ev-chroma="3">Denoise</button><button data-ev-job="media.color" data-ev-asset="'+esc(a.id)+'" data-ev-brightness="0" data-ev-contrast="1" data-ev-saturation="1">Color correction</button><button data-ev-job="media.resize" data-ev-asset="'+esc(a.id)+'" data-ev-width="1920" data-ev-height="1080" data-ev-fit="contain">Reframe 16:9</button><button data-ev-job="media.interpolate" data-ev-asset="'+esc(a.id)+'" data-ev-fps="30">Interpolate 30 fps</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="2560" data-ev-height="1440" data-ev-algorithm="lanczos">Scale to QHD · Lanczos</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="2560" data-ev-height="1440" data-ev-algorithm="spline36" data-ev-sharpness="0.5">Scale to QHD · Spline + sharpen</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="3840" data-ev-height="2160" data-ev-algorithm="lanczos">Scale to 4K · Lanczos</button>':isAudio?'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect audio</button><button data-ev-job="media.audio-clean" data-ev-asset="'+esc(a.id)+'" data-ev-noise-floor="-25" data-ev-target-lufs="-16">Clean speech & normalize</button>':isImage?renderAiUpscaleControls(a.id):'');
  return '<article class="runtime-asset"><div class="runtime-asset-preview">'+preview+'</div><div class="runtime-asset-info"><b>'+esc(a.name)+'</b><small>'+Math.max(1,Math.round(a.size/1024))+' KB · '+esc(a.mediaType)+'</small><code>'+esc(a.sha256.slice(0,20))+'…</code>'+(a.derivativeOf?'<small>Derivative of '+esc(sourceAsset?.name||a.derivativeOf)+'</small>':'')+'</div>'+lineage+renderC2paInspection(a.id)+'<div class="runtime-asset-actions">'+actions+'</div></article>';
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
 '<section class="panel"><div class="eyebrow">MEDIA INGEST</div><h3>Upload original media</h3><p>Originals are stored unchanged. Uploads receive a SHA-256 checksum and remain private to this account.</p><label class="upload primary">＋ Select media<input id="ev-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label><small>250 MiB maximum per file · supported image, video, audio and document types</small><p class="runtime-engine-note">FFmpeg: '+(state.ffmpeg?"available":"not detected")+' · FFprobe: '+(state.ffprobe?"available":"not detected")+'</p></section></div>'+renderProjectMembers()+
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
export function renderReferenceImageOptions(){
 const images=state.assets.filter(asset=>String(asset.mediaType||"").startsWith("image/"));
 return '<option value="">No reference image · text-to-image/video</option>'+images.map(asset=>'<option value="'+esc(asset.id)+'">'+esc(asset.name)+'</option>').join("");
}
export function renderImageModelOptions(){
 const provider=state.providers.find(item=>item.id==="image"&&item.provider==="gemini");
 if(!provider)return '<option value="">Server-configured model</option>';
 return (provider.availableModels||[]).map(model=>'<option value="'+esc(model.id)+'" '+(provider.model===model.id?"selected":"")+'>'+esc(model.label)+'</option>').join("")||'<option value="">No verified Gemini image models available</option>';
}
export function renderImageModelNote(){
 const provider=state.providers.find(item=>item.id==="image"&&item.provider==="gemini");
 if(!provider)return "The image model is configured server-side. Nano Banana Pro appears when the Gemini image adapter is selected by the administrator.";
 return esc(provider.status==="ready"?"Selected Gemini image model "+provider.model+" is configured. Google API charges apply to approved generations.":provider.reason)+" The image workspace now accepts one validated reference asset for image editing.";
}
export function renderVideoModelOptions(){
 const provider=state.providers.find(item=>item.provider==="runway");
 if(!provider)return '<option value="">Server-configured model</option>';
 return (provider.availableModels||[]).map(model=>'<option value="'+esc(model.id)+'" '+(provider.model===model.id?"selected":"")+'>'+esc(model.label)+' · '+model.minDurationSeconds+'–'+model.maxDurationSeconds+'s</option>').join("")||'<option value="">No verified Runway models available</option>';
}
export function renderVideoModelNote(){
 const provider=state.providers.find(item=>item.provider==="runway");
 if(!provider)return "The active provider is configured server-side. Runway model selection appears when the Runway adapter is selected by the administrator.";
 return esc(provider.status==="ready"?"Runway is configured. Provider billing applies to each approved generation.":provider.reason)+" The adapter supports text-to-video and one first-frame image-to-video reference. Multi-frame references, video-to-video and native audio controls are not yet enabled.";
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
 const project=state.projects.find(item=>item.id===state.projectId);
 const role=project?.access_role||"Personal account";
 const account=state.user?'<section class="ev-account-panel"><div class="ev-account-panel-avatar">'+esc(state.user.email.trim().slice(0,1).toUpperCase())+'</div><div class="ev-account-panel-main"><div class="eyebrow">SIGNED-IN ACCOUNT</div><h3>'+esc(state.user.email)+'</h3><p>'+(state.authMode==="supabase"?"Authenticated workspace account":"Local development account")+' · '+esc(role)+'</p><small>Active workspace: '+esc(project?.name||"Personal library")+'</small></div><div class="ev-account-panel-actions"><button class="secondary" data-tab="runtime">Account & access</button><button class="quiet" data-ev-action="logout">Sign out</button></div></section>':'<section class="ev-account-panel is-guest"><div class="ev-account-panel-avatar">EV</div><div class="ev-account-panel-main"><div class="eyebrow">WORKSPACE ACCESS</div><h3>Sign in to your private studio</h3><p>Projects, media and collaboration are available after account authentication.</p></div><button class="secondary" data-tab="runtime">Open account console</button></section>';
 return '<div id="runtime-workspace" data-runtime-view="overview" class="stats"><div><small>Project records</small><b>'+state.projects.length+'</b><span>Account-scoped</span></div><div><small>Uploaded assets</small><b>'+state.assets.length+'</b><span>Private to this account</span></div><div><small>Active jobs</small><b>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+'</b><span>Queued or running</span></div><div><small>Media tools</small><b>'+(state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Unavailable")+'</b><span>FFmpeg / FFprobe</span></div></div>'+account+'<div class="notice">'+(state.dataDirectoryPersistence==="ephemeral"?"This environment uses an ephemeral data directory. Projects, SQLite records and media may be lost when the instance is replaced or restarted. Do not use it for important customer work.":state.dataDirectoryPersistence==="operator-confirmed-volume"?"A persistent data volume has been declared by the operator. Backup, restore and failover behavior still require separate verification before production use.":"Storage durability is unverified. A non-temporary path does not prove that a persistent volume is mounted. Configure DATA_DIR_PERSISTENCE=persistent-volume only after confirming the host volume is attached.")+'</div>';
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
 state.projects=projects.projects;state.assets=assets.assets;state.c2paInspections={};state.jobs=jobs.jobs;for(const job of state.jobs){if(job.jobType==="timeline.render"&&["completed","succeeded"].includes(job.status))void apiRequest("/api/customer-success/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({eventType:"render_completed",eventKey:"render-job:"+job.id})}).catch(()=>{});}state.audit=audit.events;state.providers=providerCatalog.providers;state.remoteUsage=usageResponse.remoteUsage;window.dispatchEvent(new Event("ev:assets-updated"));
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
 const fragment=new URLSearchParams(window.location.hash.startsWith("#")?window.location.hash.slice(1):window.location.hash);if(fragment.get("type")==="recovery"){const token=fragment.get("access_token")||"";if(token){state.recoveryToken=token;state.authView="reset";state.message="Recovery link verified. Choose a new password.";}else{state.message=fragment.get("error_description")||"This recovery link is invalid or expired. Request a new one.";state.authView="login";}window.history.replaceState({},document.title,window.location.pathname+window.location.search);}
 try{
  const health=await apiRequest<{authMode:"local"|"supabase";persistence?:{dataDirectory:"ephemeral"|"unverified"|"operator-confirmed-volume";persistentVolumeRequired:boolean};media:{ffmpeg:boolean;ffprobe:boolean};textGateway:{enabled:boolean;configured:boolean};imageGateway:{enabled:boolean;configured:boolean}}>("/api/health");
  state.authMode=health.authMode;state.dataDirectoryPersistence=health.persistence?.dataDirectory||"unknown";state.persistentVolumeRequired=Boolean(health.persistence?.persistentVolumeRequired);state.ffmpeg=health.media.ffmpeg;state.ffprobe=health.media.ffprobe;state.textGatewayEnabled=health.textGateway.enabled;state.textGatewayConfigured=health.textGateway.configured;state.imageGatewayEnabled=health.imageGateway.enabled;state.imageGatewayConfigured=health.imageGateway.configured;
  try{const me=await apiRequest<{user:RuntimeUser}>("/api/me");state.user=me.user;state.status="online";await refresh();window.dispatchEvent(new Event("ev:authenticated"));}
  catch(error){if(error instanceof ApiError&&error.status===401)state.status="auth-required";else throw error;}
 }catch(error){state.status="offline";state.message=error instanceof Error?error.message:"API unavailable";}
 paint();
 window.dispatchEvent(new Event("ev:runtime-ready"));
}
async function authenticate(form:HTMLFormElement){
 const data=new FormData(form);
 try{
  else{
   const mode=String(data.get("mode")||"login");
   const response=await apiRequest<{user:RuntimeUser;authMode:"local"|"supabase";confirmationRequired?:boolean}>("/api/auth/"+(mode==="register"?"register":"login"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),password:String(data.get("password"))})});
   if(response.confirmationRequired){state.user=null;state.status="auth-required";state.message="Account created. Check your email to confirm the address, then sign in.";paint();return;}
   state.user=response.user;
  }
  const me=await apiRequest<{user:RuntimeUser}>("/api/me");state.user=me.user;state.status="online";state.message="";await refresh();window.dispatchEvent(new Event("ev:authenticated"));paint();
 }catch(error){state.status="auth-required";state.message=error instanceof Error?error.message:"Authentication failed.";paint();}
}
document.addEventListener("click",event=>{
 const button=(event.target as HTMLElement).closest<HTMLButtonElement>("[data-auth-mode]");
 if(!button)return;
 const form=document.querySelector<HTMLFormElement>("#ev-auth");
 if(!form)return;
 const mode=button.dataset.authMode==="register"?"register":"login";
 const hidden=form.elements.namedItem("mode") as HTMLInputElement|null;
 if(hidden)hidden.value=mode;
 document.querySelectorAll<HTMLButtonElement>("[data-auth-mode]").forEach(item=>item.classList.toggle("active",item===button));
 const submit=form.querySelector<HTMLButtonElement>('button[type="submit"]');
 if(submit)submit.textContent=mode==="register"?"Create secure account":"Continue securely";
 const password=form.elements.namedItem("password") as HTMLInputElement|null;
 if(password){password.autocomplete=mode==="register"?"new-password":"current-password";password.minLength=mode==="register"?12:1;password.placeholder=mode==="register"?"At least 12 characters":"Your password";}
});
document.addEventListener("submit",event=>{
 const form=event.target as HTMLFormElement;
 if(form.id==="ev-auth-recover"){event.preventDefault();const email=String(new FormData(form).get("email")||"");void apiRequest<{ok:boolean;message:string}>("/api/auth/recover",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})}).then(result=>{state.message=result.message;paint();}).catch(error=>{state.message=error instanceof Error?error.message:"Could not request a recovery email.";paint();});return;}
 if(form.id==="ev-auth-reset"){event.preventDefault();const data=new FormData(form),password=String(data.get("password")||""),confirmPassword=String(data.get("confirmPassword")||"");if(password!==confirmPassword){state.message="The two passwords do not match.";paint();return;}if(password.length<12){state.message="Use a password with at least 12 characters.";paint();return;}if(!state.recoveryToken){state.message="Your recovery session is missing. Request a new recovery email.";state.authView="login";paint();return;}void apiRequestWithBearer<{ok:boolean}>("/api/auth/password",state.recoveryToken,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({password})}).then(()=>{state.recoveryToken="";state.authView="login";state.message="Password updated. Sign in with your new password.";paint();}).catch(error=>{state.message=error instanceof Error?error.message:"Could not update your password.";paint();});return;}
 if(form.id==="ev-auth"){event.preventDefault();void authenticate(form);}
 if(form.id==="ev-project-form"){event.preventDefault();const name=String(new FormData(form).get("name")||"").trim();if(!name)return;void apiRequest<{project:RuntimeProject}>("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})}).then(async result=>{state.projectId=result.project.id;void apiRequest("/api/customer-success/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({eventType:"project_created",eventKey:"project-created:"+result.project.id})}).catch(()=>{});await refresh();window.dispatchEvent(new CustomEvent("ev:project-changed",{detail:{projectId:state.projectId}}));paint();}).catch(error=>alert(error.message||error));}
 if(form.id==="ev-member-form"){event.preventDefault();const data=new FormData(form);void apiRequest("/api/projects/"+state.projectId+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),role:String(data.get("role"))})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
 if(form.id==="ev-review-form"){event.preventDefault();const data=new FormData(form),timecode=String(data.get("timecode")||"");void apiRequest("/api/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:state.projectId,decision:String(data.get("decision")),body:String(data.get("body")),assetId:String(data.get("assetId")||"")||null,timecodeSeconds:timecode?Number(timecode):null})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
});
document.addEventListener("input",event=>{
 const target=event.target as HTMLInputElement;
 if(!target.matches("[data-ev-compare-slider]"))return;
 const value=Math.max(0,Math.min(100,Number(target.value)||0));
 const compare=target.closest<HTMLElement>("[data-ev-compare]");
 if(compare)compare.style.setProperty("--ev-compare",value+"%");
 target.setAttribute("aria-valuetext",value+"% enhanced revealed");
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLInputElement;
 if(target.id==="ev-project-select"){state.projectId=target.value;void refresh().then(()=>{window.dispatchEvent(new CustomEvent("ev:project-changed",{detail:{projectId:state.projectId}}));paint();}).catch(error=>alert(error.message||error));return;}
 if(target.id==="ev-upload"&&target.files){const files=Array.from(target.files);void (async()=>{for(const file of files){try{const uploaded=await apiRequest<{asset?:{id?:string}}>("/api/assets",{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-file-name":encodeURIComponent(file.name),"x-project-id":state.projectId},body:file});void apiRequest("/api/customer-success/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({eventType:"asset_uploaded",eventKey:"asset-upload:"+String(uploaded.asset?.id||crypto.randomUUID())})}).catch(()=>{});}catch(error){alert(file.name+": "+(error instanceof Error?error.message:"Upload failed"));}}await refresh();paint();})();}
});
document.addEventListener("click",event=>{
 const target=event.target as HTMLElement;
 const authView=target.closest<HTMLElement>("[data-auth-view]");if(authView){state.authView=authView.dataset.authView==="recover"?"recover":"login";state.message="";paint();return;}
 const authMode=target.closest<HTMLElement>("[data-auth-mode]");if(authMode){const form=document.querySelector<HTMLFormElement>("#ev-auth");const mode=form?.elements.namedItem("mode") as HTMLInputElement|null;if(mode)mode.value=authMode.dataset.authMode||"login";document.querySelectorAll("[data-auth-mode]").forEach(button=>button.classList.toggle("active",button===authMode));return;}
 const action=target.closest<HTMLElement>("[data-ev-action]");
 if(action?.dataset.evAction==="refresh"){void refresh().then(paint).catch(error=>alert(error.message||error));return;}
 if(action?.dataset.evAction==="logout"){void apiRequest("/api/auth/logout",{method:"POST"}).catch(()=>{});state.user=null;state.status="auth-required";state.jobs=[];state.assets=[];state.projects=[];paint();return;}
 const c2paButton=target.closest<HTMLElement>("[data-ev-c2pa]");
 if(c2paButton){
  const assetId=c2paButton.dataset.evC2pa||"";
  if(!assetId)return;
  state.c2paInspections[assetId]={loading:true};paint();
  void apiRequest<{verification:C2paVerification;notice:string}>("/api/assets/"+encodeURIComponent(assetId)+"/c2pa")
   .then(result=>{state.c2paInspections[assetId]={loading:false,verification:result.verification,notice:result.notice};paint();})
   .catch(error=>{state.c2paInspections[assetId]={loading:false,error:error instanceof Error?error.message:"C2PA inspection failed."};paint();});
  return;
 }
 const job=target.closest<HTMLElement>("[data-ev-job]");
 if(job){const assetId=job.dataset.evAsset||"",jobType=job.dataset.evJob||"",input:Record<string,unknown>={};for(const [key,value] of Object.entries(job.dataset))if(key.startsWith("ev")&&!["evAsset","evJob"].includes(key)){const name=key.slice(2).replace(/^[A-Z]/,letter=>letter.toLowerCase());input[name]=value!==""&&Number.isFinite(Number(value))?Number(value):value;}void apiRequest("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType,sourceAssetId:assetId,projectId:state.projectId||undefined,...input})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const remove=target.closest<HTMLElement>("[data-ev-remove-member]");
 if(remove){void apiRequest("/api/projects/"+state.projectId+"/members/"+remove.dataset.evRemoveMember,{method:"DELETE"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const reviewAsset=target.closest<HTMLElement>("[data-ev-review-asset]");
 if(reviewAsset){const form=document.querySelector<HTMLFormElement>("#ev-review-form");if(form){const field=form.elements.namedItem("assetId") as HTMLInputElement|null;if(field)field.value=reviewAsset.dataset.evReviewAsset||"";const asset=state.assets.find(item=>item.id===field?.value);const label=document.querySelector<HTMLElement>("#ev-review-target");if(label)label.textContent="Review attached to: "+(asset?.name||"selected media");form.scrollIntoView({behavior:"smooth",block:"center"});(form.elements.namedItem("body") as HTMLTextAreaElement|null)?.focus();}return;}
 const review=target.closest<HTMLElement>("[data-ev-review-status]");
 if(review){void apiRequest("/api/reviews/"+review.dataset.evReviewId,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({status:review.dataset.evReviewStatus})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const cancel=target.closest<HTMLElement>("[data-ev-cancel]");
 if(cancel){void apiRequest("/api/jobs/"+cancel.dataset.evCancel+"/cancel",{method:"POST"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
});
