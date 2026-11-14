import { apiRequest, apiRequestWithBearer, ApiError } from "../core/api";
import { cloudAssetProjectQuery, selectCloudAssetProject } from "./cloud-asset-project";
import { describePersistenceReadiness } from "./persistence-readiness";
import { describeRuntimeCapabilities, resolveLocalAssetUploadReadiness } from "./runtime-capabilities";
import { buildCreativeGraph, compareCreativeGraphSnapshot } from "../core/creative-graph";
import { hasCloudJobFinished } from "./cloud-job-polling";

type RuntimeUser={id:string;email:string};
type RuntimeProject={id:string;name:string;description?:string;revision?:number;settings?:Record<string,any>;access_role?:"owner"|"editor"|"reviewer"|"viewer"};
type RuntimeAsset={id:string;projectId?:string|null;name:string;mediaType:string;size:number;sha256:string;derivativeOf?:string|null;metadata?:Record<string,unknown>;createdAt:string};
type RuntimeCloudProject={id:string;name:string;revision?:number};
type RuntimeCloudAsset=RuntimeAsset&{downloadUrl?:string|null};
type CloudRuntimeJob={id:string;owner_id:string;project_id:string|null;job_type:string;status:string;progress:number;input:Record<string,unknown>;output?:Record<string,unknown>|null;error?:{code?:string;message?:string}|null;attempt_count?:number;cancel_requested_at?:string|null;created_at:string;updated_at:string;completed_at?:string|null};
type RuntimeJob={id:string;projectId?:string|null;jobType:string;status:string;progress:number;input:Record<string,unknown>;output?:Record<string,unknown>|null;error?:{code?:string;message?:string}|null;createdAt:string;updatedAt:string};
type RuntimeReview={id:string;project_id:string;asset_id?:string|null;timecode_seconds?:number|null;decision:string;body:string;status:string;created_at:string};
type C2paVerification={status:"trusted"|"valid_untrusted"|"invalid"|"not_present"|"validation_unavailable";present:boolean;valid:boolean;trusted:boolean;assetSha256:string;validationState:string|null;findings:string[];manifest:null|{title:string|null;format:string|null;claimGenerator:string|null;ingredientCount:number;ingredients:Array<{title:string|null;format:string|null;relationship:string|null;hasManifestData:boolean}>};validationStatuses:Array<{code:string;success:boolean|null;explanation:string|null}>};
type C2paInspectionState={loading:boolean;verification?:C2paVerification;notice?:string;error?:string};
type ProviderStatus={id:string;provider:string;enabled:boolean;configured:boolean;remote:boolean;model:string|null;selfTestAllowed?:boolean;videoAiUpscaleEnabled?:boolean;videoAiUpscaleWorkerSelfTestPassed?:boolean;videoAiUpscaleReason?:string;availableModels?:Array<{id:string;label:string;minDurationSeconds?:number;maxDurationSeconds?:number;aspectRatios?:string[];resolutions?:string[];inputModes?:string[];readiness?:string;available?:boolean;executionVerified?:boolean;qualityVerified?:boolean;reason?:string}>;status:"ready"|"disabled"|"needs_configuration"|"remote_opt_in_required"|"unavailable"|"unverified";reason:string;capabilities:string[]};
type RemoteUsage={window:string;configurationValid:boolean;limit:number|null;used:number;remaining:number|null;projectUsed:number|null;remoteDisabled:boolean};
let workspaceRevisions=new Map<string,number>();
let workspaceSaveTimers=new Map<string,ReturnType<typeof setTimeout>>();
let workspaceSaveChain:Promise<void>=Promise.resolve();
let cloudJobPollingTimer:ReturnType<typeof setInterval>|null=null;
let cloudJobPollingBusy=false;
const state:{status:"checking"|"offline"|"auth-required"|"online";authMode:"local"|"supabase";cloudMediaReady:boolean;cloudMediaJobsEnabled:boolean;cloudMediaJobs:CloudRuntimeJob[];cloudAssets:RuntimeCloudAsset[];cloudProjects:RuntimeCloudProject[];cloudProjectId:string;authView:"login"|"recover"|"reset";recoveryToken:string;dataDirectoryPersistence:"unknown"|"ephemeral"|"unverified"|"operator-confirmed-volume";databaseMode:"unknown"|"sqlite"|"postgres";storageMode:"unknown"|"local-disk"|"object-storage";persistentVolumeRequired:boolean;localAssetUploadsAllowed:boolean;localAssetUploadBlockReason:string;authSessionReady:boolean;authSessionEncrypted:boolean;billingEnabled:boolean;billingProviderConfigured:boolean;billingWebhookConfigured:boolean;billingProviderMode:"unknown"|"sandbox"|"live";cloudVideoWorker:{enabled:boolean;remoteExecutionGates:boolean;modelRouterEnabled:boolean;modelRouterRemoteEnabled:boolean;modelRouterConfigPresent:boolean;providerCredentialConfigured:boolean;outputHostAllowlistConfigured:boolean;supabaseCredentialsConfigured:boolean;directRunwayModelsRequested:boolean;runtimeMode:"separate-process"|"embedded"|"unknown"};user:RuntimeUser|null;projects:RuntimeProject[];assets:RuntimeAsset[];jobs:RuntimeJob[];audit:Array<Record<string,unknown>>;members:Array<{id:string;email:string;role:string;createdAt:string}>;reviews:RuntimeReview[];projectId:string;message:string;ffmpeg:boolean;ffprobe:boolean;textGatewayEnabled:boolean;textGatewayConfigured:boolean;imageGatewayEnabled:boolean;imageGatewayConfigured:boolean;providers:ProviderStatus[];remoteUsage:RemoteUsage|null;c2paInspections:Record<string,C2paInspectionState>;evidenceAssetId:string;evidenceRecords:Array<Record<string,any>>;evidenceLoading:boolean;evidenceError:string;projectEvidenceRecords:Array<any>;creativeGraphWorkspace:Record<string,any>|null;creativeGraphTimelines:Array<any>;creativeGraph:ReturnType<typeof buildCreativeGraph>|null;creativeGraphSnapshot:Record<string,any>|null}={
 status:"checking",authMode:"local",cloudMediaReady:false,cloudMediaJobsEnabled:false,cloudMediaJobs:[],cloudAssets:[],cloudProjects:[],cloudProjectId:"",authView:"login",recoveryToken:"",dataDirectoryPersistence:"unknown",databaseMode:"unknown",storageMode:"unknown",persistentVolumeRequired:false,localAssetUploadsAllowed:false,localAssetUploadBlockReason:"Checking server storage readiness before enabling local uploads.",authSessionReady:false,authSessionEncrypted:false,billingEnabled:false,billingProviderConfigured:false,billingWebhookConfigured:false,billingProviderMode:"unknown",cloudVideoWorker:{enabled:false,remoteExecutionGates:false,modelRouterEnabled:false,modelRouterRemoteEnabled:false,modelRouterConfigPresent:false,providerCredentialConfigured:false,outputHostAllowlistConfigured:false,supabaseCredentialsConfigured:false,directRunwayModelsRequested:false,runtimeMode:"unknown"},user:null,projects:[],assets:[],jobs:[],audit:[],members:[],reviews:[],projectId:"",message:"",ffmpeg:false,ffprobe:false,textGatewayEnabled:false,textGatewayConfigured:false,imageGatewayEnabled:false,imageGatewayConfigured:false,providers:[],remoteUsage:null,c2paInspections:{},evidenceAssetId:"",evidenceRecords:[],evidenceLoading:false,evidenceError:"",projectEvidenceRecords:[],creativeGraphWorkspace:null,creativeGraphTimelines:[],creativeGraph:null,creativeGraphSnapshot:null
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
 const selfTestAssets=state.assets.filter(asset=>["image/png","image/jpeg","image/webp"].includes(asset.mediaType)&&asset.size<=5*1024*1024);
 const selfTestModels=models.filter(model=>model.available===true);
 const selfTestMarkup=provider?.selfTestAllowed===true?'<section class="ai-upscale-model ai-upscale-self-test"><div class="ai-upscale-model-head"><strong>Administrator inference self-test</strong><span class="ai-upscale-state is-locked">LOCAL WORKER</span></div><p>Verify real model execution with a private test image before collecting independent visual-quality evidence. The source image is not modified.</p><div class="ai-upscale-batch-controls"><label>Test image<select id="ev-upscale-self-test-asset" '+(selfTestAssets.length?"":"disabled")+'>'+selfTestAssets.map(asset=>'<option value="'+esc(asset.id)+'">'+esc(asset.name)+'</option>').join("")+'</select></label><label>Model<select id="ev-upscale-self-test-model" '+(selfTestModels.length?"":"disabled")+'>'+selfTestModels.map(model=>'<option value="'+esc(model.id)+'">'+esc(model.label||model.id)+'</option>').join("")+'</select></label><label>Scale<select id="ev-upscale-self-test-scale"><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label><button type="button" class="primary" data-ev-upscale-self-test '+(provider.enabled&&selfTestAssets.length&&selfTestModels.length?"":"disabled aria-disabled=\"true\"")+'">Run inference self-test</button></div><small class="ai-upscale-footnote">'+(selfTestAssets.length?"Select a PNG, JPEG or WebP image no larger than 5 MB.":"Upload a PNG, JPEG or WebP test image no larger than 5 MB first.")+' Only allowlisted administrators can run this check. A successful execution test does not approve visual quality.</small></section>':"";
 return '<section class="ai-upscale-controls" aria-label="AI super-resolution model readiness"><div class="ai-upscale-heading"><div><small class="ai-upscale-label">NEURAL IMAGE RESTORATION</small><strong>Real-ESRGAN model readiness</strong></div><span class="ai-upscale-original">SOURCE PRESERVED</span></div>'+(models.length?'<div class="ai-upscale-model-grid">'+modelCards+'</div>':'<p class="ai-upscale-footnote">No model readiness records are available. '+esc(explanation)+'</p>')+selfTestMarkup+'<p class="ai-upscale-footnote">A model is unlocked only after its own installation, execution self-test and complete five-category human-reviewed quality evidence pass. This panel reports readiness; it does not submit inference or incur provider charges.</p></section>';
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

function renderVideoAiUpscaleControls(assetId:string):string{
 const provider=state.providers.find(item=>item.id==="ai-upscale");
 const model=(provider?.availableModels||[]).find(item=>item.id==="realesrgan-x4plus");
 const workerEnabled=provider?.videoAiUpscaleEnabled===true;
 const workerVerified=provider?.videoAiUpscaleWorkerSelfTestPassed===true;
 const ready=model?.readiness==="ready"&&model.qualityVerified===true&&model.executionVerified===true&&workerEnabled&&workerVerified;
 const reason=!workerEnabled?"Video AI upscaling is disabled on the cloud worker.":!workerVerified?"A worker-side video inference self-test has not been confirmed.":model?.reason||provider?.reason||"Video enhancement requires a verified Real-ESRGAN model and worker execution self-test.";
 const button=(scale:number)=>'<button type="button" '+(ready?'':'disabled aria-disabled="true"')+' title="'+esc(reason)+'" data-ev-job="media.video-ai-upscale" data-ev-asset="'+esc(assetId)+'" data-ev-model="realesrgan-x4plus" data-ev-scale="'+scale+'" data-ev-tile="0">Enhance video · '+scale+'×</button>';
 return '<section class="ai-upscale-controls" aria-label="AI video super-resolution"><div class="ai-upscale-heading"><div><small class="ai-upscale-label">VIDEO FINISHING</small><strong>Framewise AI enhancement</strong></div><span class="ai-upscale-original">SOURCE PRESERVED</span></div><div class="ai-upscale-presets">'+button(2)+button(4)+'</div><p class="ai-upscale-footnote">'+esc(reason)+' Jobs are limited to 300 frames and 10 minutes. Audio and subtitle streams are preserved or safely transcoded. Temporal consistency is not certified by framewise inference; every result requires human quality review.</p></section>';
}
function renderBatchUpscaleControls():string{
 const images=state.assets.filter(asset=>String(asset.mediaType||"").startsWith("image/")&&!asset.derivativeOf&&(asset.projectId||null)===(state.projectId||null));
 if(!images.length)return "";
 const provider=state.providers.find(item=>item.id==="ai-upscale");
 const readyModels=(provider?.availableModels||[]).filter(model=>model.readiness==="ready"&&model.qualityVerified===true&&model.executionVerified===true);
 const modelOptions=readyModels.map(model=>'<option value="'+esc(model.id)+'">'+esc(model.label||model.id)+'</option>').join("");
 const disabled=state.status!=="online"||!readyModels.length;
 return '<section class="ai-upscale-batch"><div class="runtime-section-heading"><div><div class="eyebrow">BATCH IMAGE ENHANCEMENT</div><h3>Enhance selected originals</h3></div><span>'+images.length+' eligible image(s)</span></div><p>Select original images below, then submit one batch. Each image becomes an independently tracked queue job; originals are never overwritten.</p><div class="ai-upscale-batch-controls"><label>Verified model<select id="ev-batch-upscale-model" '+(readyModels.length?'':'disabled')+'>'+modelOptions+'</select></label><label>Scale<select id="ev-batch-upscale-scale"><option value="2">2×</option><option value="3">3×</option><option value="4" selected>4×</option></select></label><button type="button" class="primary" data-ev-batch-upscale '+(disabled?'disabled aria-disabled="true"':'')+'>Queue selected images</button></div><small class="ai-upscale-footnote">'+(readyModels.length?'Only models with installed weights, execution self-tests and reviewed quality evidence are selectable.':'Batch submission is locked until at least one model passes its execution and five-category visual-quality gates.')+'</small></section>';
}
function rebuildCreativeGraph(){
 const project=state.projects.find(item=>item.id===state.projectId);
 const workspace=state.creativeGraphWorkspace||{},production=project?.settings?.creativeProduction||{};
 if(!state.projectId||!project){state.creativeGraph=null;return;}
 state.creativeGraph=buildCreativeGraph({
  project:{id:project.id,name:project.name,brief:String(workspace.creativeProjects?.[0]?.brief||workspace.plan||"")},
  creativeDNA:production.creativeDNA||{},
  seriesPlans:Array.isArray(production.seriesPlans)?production.seriesPlans:[],
  shots:Array.isArray(workspace.shots)?workspace.shots:[],
  characters:Array.isArray(workspace.characters)?workspace.characters:[],
  assets:state.assets.filter(asset=>asset.projectId===project.id).map(asset=>({id:asset.id,name:asset.name,mediaType:asset.mediaType,sha256:asset.sha256,size:asset.size})),
  evidenceRecords:state.projectEvidenceRecords,
  timelines:state.creativeGraphTimelines
 });
}
function renderCreativeGraphPanel():string{
 const selectedAsset=state.assets.find(item=>item.id===state.evidenceAssetId);
 if(!state.projectId||!selectedAsset?.projectId)return "";
 const graph=state.creativeGraph;
 if(!graph)return '<section class="creative-graph-panel"><b>Creative dependency graph</b><p class="muted">Select a project and load its creative workspace to build the graph.</p></section>';
 const baseline=state.creativeGraphSnapshot;
 const comparison=baseline?.graph?compareCreativeGraphSnapshot(graph,baseline.graph):null;
 const nodeRows=graph.nodes.slice(0,40).map(node=>'<span class="creative-graph-node '+esc(node.type)+' '+esc(node.status)+'"><b>'+esc(node.type.replaceAll("_"," "))+'</b> '+esc(node.label)+'</span>').join("");
 const stale=comparison?.potentiallyStaleIds||[];
 return '<section class="creative-graph-panel"><div class="creative-graph-heading"><div><small class="eyebrow">CREATIVE TRACEABILITY</small><h3>Creative dependency graph</h3><p>Explicit links between project intent, shots, characters, source assets and reviewed evidence. Project membership is shown separately from authored links.</p></div><button type="button" class="secondary" data-ev-graph-save>Save review baseline</button></div><div class="creative-graph-metrics"><div><b>'+graph.nodes.length+'</b><small>Nodes</small></div><div><b>'+graph.edges.length+'</b><small>Links</small></div><div><b>'+graph.unlinkedShots.length+'</b><small>Unlinked shots</small></div><div><b>'+graph.unlinkedEvidence.length+'</b><small>Evidence gaps</small></div><div><b>'+graph.counts.timeline+'</b><small>Timelines</small></div><div><b>'+graph.counts.clip+'</b><small>Timeline clips</small></div></div><div class="creative-graph-nodes">'+(nodeRows||'<span class="muted">No connected production records yet.</span>')+'</div>'+(graph.nodes.length>40?'<small class="muted">Showing 40 of '+graph.nodes.length+' graph nodes.</small>':"")+(baseline?'<p class="creative-graph-baseline">Saved baseline · revision '+esc(baseline.revision)+' · '+esc(String(baseline.graphHash||"").slice(0,16))+'…</p>':'<p class="muted">No review baseline has been saved for this project.</p>')+(comparison?'<div class="creative-graph-diff"><b>Baseline comparison</b><span>'+comparison.changedNodeIds.length+' changed · '+comparison.addedNodeIds.length+' added · '+comparison.removedNodeIds.length+' removed · '+stale.length+' potentially stale</span>'+(stale.length?'<small>Review downstream items: '+esc(stale.slice(0,12).join(", "))+'</small>':'<small>No downstream review candidates identified.</small>')+'</div>':"")+'</section>';
}
function renderEvidencePanel():string{
 if(!state.evidenceAssetId)return "";
 const asset=state.assets.find(item=>item.id===state.evidenceAssetId);
 if(!asset)return "";
 const projectId=asset.projectId||"",role=state.projects.find(item=>item.id===projectId)?.access_role||"";
 const canReview=!projectId||["owner","editor","reviewer"].includes(role);
 const records=state.evidenceRecords.map(record=>'<article class="evidence-record"><div class="evidence-record-head"><b>'+esc(record.kind||"Evidence")+'</b><span class="evidence-status '+esc(record.status||"submitted")+'">'+esc(String(record.status||"submitted").replaceAll("_"," "))+'</span></div><p>'+esc(record.claim||"")+'</p><small>Source: '+esc(record.sourceAssetName||asset.name)+' · SHA-256 '+esc(String(record.sourceSha256||"").slice(0,16))+'… · Target: '+esc(record.target?.type||"unknown")+' / '+esc(record.target?.id||"")+'</small>'+(record.reviewNote?'<p class="evidence-review-note">Reviewer note: '+esc(record.reviewNote)+'</p>':"")+(canReview&&["submitted","needs_review"].includes(record.status)?'<div class="evidence-review-controls"><select data-evidence-status="'+esc(record.id)+'"><option value="verified">Verify evidence</option><option value="rejected">Reject evidence</option><option value="needs_review">Needs more review</option></select><textarea data-evidence-note="'+esc(record.id)+'" rows="2" minlength="8" placeholder="Explain the review decision (at least 8 characters)"></textarea><button type="button" data-ev-evidence-review="'+esc(record.id)+'">Save review decision</button></div>':"")+'</article>').join("");
 const targetDefault=projectId||asset.id,targetType=projectId?"project":"asset";
 return '<section class="evidence-ledger-panel" aria-label="Asset evidence ledger"><p class="evidence-storage-note">Production evidence writes require an operator-confirmed persistent data volume. Temporary or unverified production storage is rejected to protect review history.</p><div class="evidence-ledger-heading"><div><small class="eyebrow">PROVENANCE & REVIEW</small><h3>Evidence ledger</h3><p>Evidence is linked to this exact source file and its SHA-256. A reviewer decision records review status; it does not prove the claim by itself.</p></div><button type="button" class="secondary" data-ev-evidence-close>Close</button></div>'+(state.evidenceError?'<p class="evidence-error">'+esc(state.evidenceError)+'</p>':"")+(state.evidenceLoading?'<p class="muted">Loading evidence records…</p>':'')+'<form id="ev-evidence-form" class="evidence-submit-form"><input type="hidden" name="assetId" value="'+esc(asset.id)+'"><label>Evidence target<select name="targetType"><option value="'+targetType+'">'+(targetType==="project"?"Current project":"This asset")+'</option><option value="shot">Shot</option><option value="scene">Scene</option><option value="timeline">Timeline</option><option value="asset">Another asset</option></select></label><label>Target ID<input name="targetId" value="'+esc(targetDefault)+'" required maxlength="160"></label><label>Evidence kind<input name="kind" value="source_reference" required maxlength="64"></label><label>Claim or observation<textarea name="claim" rows="3" minlength="8" maxlength="1200" required placeholder="Describe what this source is evidence for"></textarea></label><div class="evidence-form-grid"><label>Method<input name="method" maxlength="120" placeholder="How it was observed"></label><label>Source reference<input name="sourceRef" maxlength="1000" placeholder="Capture ID, document reference, etc."></label><label>Observed at<input name="observedAt" type="datetime-local"></label></div><button type="submit" class="primary">Submit for review</button></form><div class="evidence-record-list"><div class="evidence-record-list-heading"><b>Recorded evidence</b><span>'+state.evidenceRecords.length+' record(s)</span></div>'+(records||'<div class="empty">No evidence records are attached to this source yet.</div>')+'</div></section>'+renderCreativeGraphPanel();
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
  const actions='<a class="download-output" href="'+file+'" target="_blank" rel="noopener">Open original</a>'+c2paAction+'<button type="button" data-ev-evidence-open="'+esc(a.id)+'">Evidence ledger</button>'+(state.projectId&&["owner","editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<button data-ev-review-asset="'+esc(a.id)+'">Review asset</button>':'')+'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect</button>'+(isVideo?renderVideoAiUpscaleControls(a.id)+'<button data-ev-job="media.thumbnail" data-ev-asset="'+esc(a.id)+'">Extract frame</button><button data-ev-job="media.proxy" data-ev-asset="'+esc(a.id)+'">Create proxy</button><button data-ev-job="media.audio_extract" data-ev-asset="'+esc(a.id)+'">Extract audio</button><button data-ev-job="media.denoise" data-ev-asset="'+esc(a.id)+'" data-ev-luma="4" data-ev-chroma="3">Denoise</button><button data-ev-job="media.color" data-ev-asset="'+esc(a.id)+'" data-ev-brightness="0" data-ev-contrast="1" data-ev-saturation="1">Color correction</button><button data-ev-job="media.resize" data-ev-asset="'+esc(a.id)+'" data-ev-width="1920" data-ev-height="1080" data-ev-fit="contain">Reframe 16:9</button><button data-ev-job="media.interpolate" data-ev-asset="'+esc(a.id)+'" data-ev-fps="30">Interpolate 30 fps</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="2560" data-ev-height="1440" data-ev-algorithm="lanczos">Scale to QHD · Lanczos</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="2560" data-ev-height="1440" data-ev-algorithm="spline36" data-ev-sharpness="0.5">Scale to QHD · Spline + sharpen</button><button data-ev-job="media.upscale" data-ev-asset="'+esc(a.id)+'" data-ev-width="3840" data-ev-height="2160" data-ev-algorithm="lanczos">Scale to 4K · Lanczos</button>':isAudio?'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect audio</button><button data-ev-job="media.audio-clean" data-ev-asset="'+esc(a.id)+'" data-ev-noise-floor="-25" data-ev-target-lufs="-16">Clean speech & normalize</button>':isImage?renderAiUpscaleControls(a.id):'');
  const batchSelect=isImage&&!a.derivativeOf&&(a.projectId||null)===(state.projectId||null)?'<label class="ai-upscale-batch-select"><input type="checkbox" data-ev-batch-asset="'+esc(a.id)+'"> Include in batch enhancement</label>':"";
  return '<article class="runtime-asset"><div class="runtime-asset-preview">'+preview+'</div><div class="runtime-asset-info"><b>'+esc(a.name)+'</b><small>'+Math.max(1,Math.round(a.size/1024))+' KB · '+esc(a.mediaType)+'</small><code>'+esc(a.sha256.slice(0,20))+'…</code>'+(a.derivativeOf?'<small>Derivative of '+esc(sourceAsset?.name||a.derivativeOf)+'</small>':'')+batchSelect+'</div>'+lineage+renderC2paInspection(a.id)+'<div class="runtime-asset-actions">'+actions+'</div></article>';
 }).join("")+'</div>'+renderEvidencePanel();
}
function renderCloudAssets(){
 if(!state.cloudAssets.length)return '<div class="empty">No private cloud assets are stored in this project yet. Cloud uploads remain separate from local preview storage.</div>';
 return '<div class="runtime-assets">'+state.cloudAssets.map(asset=>{
  const url=asset.downloadUrl?esc(asset.downloadUrl):"";
  const isVideo=asset.mediaType.startsWith("video/"),isAudio=asset.mediaType.startsWith("audio/"),isImage=asset.mediaType.startsWith("image/");
  const preview=url?(isImage?'<img loading="lazy" src="'+url+'" alt="">':isVideo?'<video controls preload="metadata" src="'+url+'"></video>':isAudio?'<audio controls preload="metadata" src="'+url+'"></audio>':'<a href="'+url+'" target="_blank" rel="noopener noreferrer">Open file</a>'):'<div class="empty">Secure download link unavailable. Refresh to retry.</div>';
  const mediaActions=state.cloudMediaJobsEnabled?'<button data-ev-cloud-job="media.probe" data-ev-cloud-asset="'+esc(asset.id)+'">Inspect</button>'+(isVideo?'<button data-ev-cloud-job="media.thumbnail" data-ev-cloud-asset="'+esc(asset.id)+'">Extract thumbnail</button><button data-ev-cloud-job="media.proxy" data-ev-cloud-asset="'+esc(asset.id)+'">Create proxy</button><button data-ev-cloud-job="media.denoise" data-ev-cloud-asset="'+esc(asset.id)+'">Denoise video</button>':'')+(isAudio?'<button data-ev-cloud-job="media.audio-clean" data-ev-cloud-asset="'+esc(asset.id)+'">Clean audio</button>':''):'';
  return '<article class="runtime-asset"><div class="runtime-asset-preview">'+preview+'</div><div class="runtime-asset-info"><b>'+esc(asset.name)+'</b><small>'+Math.max(1,Math.round(asset.size/1024))+' KB · '+esc(asset.mediaType)+' · PRIVATE CLOUD</small><code>'+esc(asset.sha256.slice(0,20))+'…</code></div><div class="runtime-asset-actions">'+(url?'<a class="download-output" href="'+url+'" target="_blank" rel="noopener noreferrer">Open secure original</a>':'')+mediaActions+'<button data-ev-cloud-remove="'+esc(asset.id)+'">Archive cloud asset</button></div></article>';
 }).join("")+'</div>';
}
function renderCloudMediaJobs(){
 if(!state.cloudMediaJobsEnabled)return '<div class="notice">Cloud processing remains disabled until an isolated worker is deployed and its private storage, queue and authorization checks are verified.</div>';
 if(!state.cloudMediaJobs.length)return '<div class="empty">No cloud processing jobs yet. Choose an operation on a private cloud asset above.</div>';
 return '<div class="runtime-jobs" aria-live="polite">'+state.cloudMediaJobs.map(job=>{
  const progress=Math.max(0,Math.min(100,Number(job.progress)||0));
  const cancelRequested=Boolean(job.cancel_requested_at);
  const status=cancelRequested?"CANCELLATION REQUESTED":String(job.status||"unknown").toUpperCase();
  const attempt=Number.isSafeInteger(job.attempt_count)&&Number(job.attempt_count)>0?' · attempt '+Number(job.attempt_count):"";
  const error=job.error?.message?'<small class="muted">'+esc(job.error.code||"JOB_ERROR")+' · '+esc(job.error.message)+'</small>':"";
  const completed=job.completed_at?'<small>Finished '+esc(fmt(job.completed_at))+'</small>':"";
  const cancelButton=["queued","processing"].includes(job.status)&&!cancelRequested?'<button class="secondary" data-ev-cloud-cancel="'+esc(job.id)+'">Cancel job</button>':"";
  return '<article class="runtime-job" data-cloud-job-status="'+esc(job.status)+'"><div class="runtime-job-main"><b>'+esc(job.job_type.replaceAll("media.","").replaceAll("-"," "))+'</b><small>'+esc(status)+' · '+progress+'%'+attempt+'</small><div class="progress" role="progressbar" aria-label="Cloud job progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+progress+'"><i style="width:'+progress+'%"></i></div><small>'+esc(job.id)+' · '+esc(fmt(job.created_at))+'</small>'+completed+error+cancelButton+'</div></article>';
 }).join("")+'</div>';
}
async function refreshCloudMediaJobs(){
 if(cloudJobPollingBusy||!state.user||!state.cloudMediaReady||!state.cloudMediaJobsEnabled||!state.cloudProjectId)return;
 if(document.visibilityState!=="visible"||!document.querySelector<HTMLElement>('#runtime-workspace[data-runtime-view="library"]'))return;
 const scope=cloudAssetProjectQuery(state.cloudProjectId);if(!scope)return;
 cloudJobPollingBusy=true;
 try{
  const response=await apiRequest<{jobs:CloudRuntimeJob[]}>("/api/cloud/jobs"+scope);
  const next=Array.isArray(response.jobs)?response.jobs:[];
  const finished=hasCloudJobFinished(state.cloudMediaJobs,next);
  state.cloudMediaJobs=next;
  if(finished){
   await refresh();
   paint();
   return;
  }
  const list=document.querySelector<HTMLElement>("#cloud-media-jobs-list");
  if(list)list.innerHTML=renderCloudMediaJobs();
  const count=document.querySelector<HTMLElement>("#cloud-media-job-count");
  if(count)count.textContent=state.cloudMediaJobs.length+" recent jobs";
  const status=document.querySelector<HTMLElement>("#cloud-media-job-refresh-status");
  if(status)status.textContent="Live · updated "+new Date().toLocaleTimeString();
 }catch{
  const status=document.querySelector<HTMLElement>("#cloud-media-job-refresh-status");
  if(status)status.textContent="Refresh unavailable · showing the last known job status";
 }finally{
  cloudJobPollingBusy=false;
 }
}
function startCloudJobPolling(){
 if(!cloudJobPollingTimer)cloudJobPollingTimer=setInterval(()=>{void refreshCloudMediaJobs();},5000);
}
function renderCloudAssetLibrary(){
 if(!state.cloudMediaReady)return '<section class="panel"><div class="eyebrow">PRIVATE CLOUD STORAGE</div><h3>Cloud originals · not connected</h3><p>Local media storage remains available. Cloud uploads and signed downloads stay disabled until this environment passes the authenticated isolated-database and private-bucket readiness checks.</p></section>';
 const projectOptions=state.cloudProjects.map(project=>'<option value="'+esc(project.id)+'" '+(project.id===state.cloudProjectId?'selected':'')+'>'+esc(project.name)+'</option>').join("");
 const projectPicker=state.cloudProjects.length?'<label>Cloud project<select id="ev-cloud-project-select"><option value="">Select a cloud project</option>'+projectOptions+'</select></label>':'<div class="notice">Create a cloud project in the Cloud Projects workspace before uploading media. Unassigned cloud uploads are disabled so assets cannot become detached from the editor project.</div>';
 const upload=state.cloudProjectId?'<label class="upload primary">＋ Upload to selected cloud project<input id="ev-cloud-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label>':'<button class="secondary" disabled>＋ Upload unavailable · select a cloud project</button>';
 return '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">PRIVATE PROJECT MEDIA</div><h3>Cloud project originals</h3></div><span>'+state.cloudAssets.length+' cloud assets</span></div><p>Uploads are stored against the selected cloud project, so the same assets are available in its cloud timeline editor. Local project IDs and local disk assets remain separate.</p>'+projectPicker+upload+'<small>250 MiB maximum per file · server-side signature validation · project-role authorization · short-lived signed downloads</small>'+renderCloudAssets()+'</section><section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">CLOUD WORKER QUEUE</div><h3>Private cloud processing</h3></div><div><span id="cloud-media-job-count">'+state.cloudMediaJobs.length+' recent jobs</span> <button type="button" class="secondary" data-ev-cloud-jobs-refresh '+(state.cloudMediaJobsEnabled?'':'disabled')+'>↻ Refresh queue</button></div></div><small id="cloud-media-job-refresh-status">Auto-refreshes every 5 seconds while this library is open.</small><div id="cloud-media-jobs-list">'+renderCloudMediaJobs()+'</div></section>';
}
function renderJobs(){
 if(!state.jobs.length)return '<div class="empty">No jobs submitted. Media processing jobs will appear here with progress, events and output assets.</div>';
 return '<div class="runtime-jobs">'+state.jobs.map(j=>{
  const batchId=typeof j.input?.batchId==="string"?j.input.batchId:"";
  const batchIndex=Number.isSafeInteger(j.input?.batchIndex)?Number(j.input.batchIndex)+1:0;
  const batchTotal=Number.isSafeInteger(j.input?.batchTotal)?Number(j.input.batchTotal):0;
  const batchMeta=batchId?'<small class="runtime-job-batch">Batch '+esc(batchId.slice(0,8))+' · image '+(batchIndex||"—")+'/'+(batchTotal||"—")+'</small>':"";
  return '<article class="runtime-job"><div class="runtime-job-heading"><b>'+esc(j.jobType)+'</b><span class="job-status '+esc(j.status)+'">'+esc(j.status)+'</span></div>'+batchMeta+'<code>'+esc(j.id)+'</code><div class="progress"><i style="width:'+Math.max(0,Math.min(100,j.progress))+'%"></i></div><small>'+Math.round(j.progress)+'% · '+fmt(j.createdAt)+'</small>'+(j.error?'<p class="job-error">'+esc(j.error.code||"ERROR")+' · '+esc(j.error.message||"")+'</p>':'')+(j.status==="queued"||j.status==="running"?'<button data-ev-cancel="'+esc(j.id)+'">Cancel</button>':'')+((j.output&&typeof j.output==="object"&&"outputAsset" in j.output&&j.output.outputAsset&&typeof j.output.outputAsset==="object"&&"id" in j.output.outputAsset)?'<a class="download-output" href="/api/assets/'+esc((j.output.outputAsset as {id:string}).id)+'/file">Download output · '+esc((j.output.outputAsset as {name?:string}).name||"media file")+'</a>':'')+'</article>';
 }).join("")+'</div>';
}
function persistenceNoticeMarkup(){
 const readiness=describePersistenceReadiness({dataDirectory:state.dataDirectoryPersistence,database:state.databaseMode,storage:state.storageMode});
 if(readiness.level==="ready")return "";
 return '<div class="notice" role="status" data-persistence-readiness="'+readiness.level+'"><b>'+esc(readiness.title)+'</b><p>'+esc(readiness.message)+'</p>'+(readiness.details.length?'<ul>'+readiness.details.map(item=>'<li>'+esc(item)+'</li>').join("")+'</ul>':"")+'</div>';
}

function capabilityReadinessMarkup(){
 const items=describeRuntimeCapabilities({authMode:state.authMode,authSessionReady:state.authSessionReady,authSessionEncrypted:state.authSessionEncrypted,cloudMediaReady:state.cloudMediaReady,cloudMediaJobsEnabled:state.cloudMediaJobsEnabled,textGatewayEnabled:state.textGatewayEnabled,textGatewayConfigured:state.textGatewayConfigured,imageGatewayEnabled:state.imageGatewayEnabled,imageGatewayConfigured:state.imageGatewayConfigured,ffmpeg:state.ffmpeg,ffprobe:state.ffprobe,billingEnabled:state.billingEnabled,billingProviderConfigured:state.billingProviderConfigured,billingWebhookConfigured:state.billingWebhookConfigured,billingProviderMode:state.billingProviderMode,cloudVideoWorker:state.cloudVideoWorker});
 const counts=items.reduce((acc,item)=>{acc[item.state]=(acc[item.state]||0)+1;return acc;},{ready:0,limited:0,disabled:0,blocked:0} as Record<string,number>);
 return '<section class="panel" data-runtime-capability-readiness><div class="eyebrow">LIVE SERVICE READINESS</div><h3>What is actually enabled</h3><div class="runtime-summary"><div><small>Ready</small><b>'+counts.ready+'</b></div><div><small>Limited</small><b>'+counts.limited+'</b></div><div><small>Disabled</small><b>'+counts.disabled+'</b></div><div><small>Blocked</small><b>'+counts.blocked+'</b></div></div><div class="engine-grid">'+items.map(item=>'<div class="engine" data-capability="'+esc(item.id)+'" data-state="'+item.state+'"><i></i><b>'+esc(item.label)+' · '+esc(item.state.toUpperCase())+'</b><small>'+esc(item.detail)+'</small></div>').join('')+'</div><p class="runtime-engine-note">Read-only status from the server health contract. A ready configuration does not bypass project permissions, human approvals, spending limits or provider-specific release gates.</p></section>';
}

export function renderRuntimeWorkspace(){
 return '<div id="runtime-workspace" data-runtime-view="runtime"><div class="runtime-toolbar">'+statusMarkup()+'<button class="secondary" data-ev-action="refresh">↻ Refresh</button>'+(state.user?'<button class="secondary" data-ev-action="logout">Sign out · '+esc(state.user.email)+'</button>':'')+'</div>'+
 (state.status==="offline"?'<div class="notice">The local API is not reachable. Start the complete stack with <code>npm run dev</code>. Planning workspaces remain available; uploads and processing require the API.</div>':'')+
 (state.status==="auth-required"?'<div class="notice">Sign in to activate persistent project and media storage. Other planning workspaces remain available.</div>':'')+
 persistenceNoticeMarkup()+
 capabilityReadinessMarkup()+
 '<div class="runtime-summary"><div><small>Projects</small><b>'+state.projects.length+'</b></div><div><small>Stored assets</small><b>'+state.assets.length+'</b></div><div><small>Jobs</small><b>'+state.jobs.length+'</b></div><div><small>Local media tools</small><b>'+(state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Not detected")+'</b></div></div>'+
 '<div class="runtime-two-col"><section class="panel"><div class="eyebrow">PROJECT REGISTRY</div><h3>Persistent projects</h3><form id="ev-project-form"><label>New project name</label><input name="name" required maxlength="160" placeholder="Campaign, film, episode or client project"><button class="primary">Create project</button></form><label>Current project</label><select id="ev-project-select">'+projectOptions()+'</select><div class="runtime-project-list">'+state.projects.map(p=>'<div><b>'+esc(p.name)+'</b><small>'+esc(p.id)+'</small></div>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">MEDIA INGEST</div><h3>Upload original media</h3><p>Originals are stored unchanged. Uploads receive a SHA-256 checksum and remain private to this account.</p>'+(state.localAssetUploadsAllowed?'<label class="upload primary">＋ Select media<input id="ev-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label><small>250 MiB maximum per file · supported image, video, audio and document types</small>':'<div class="notice" role="status" data-local-upload-readiness="blocked"><b>Local uploads are disabled</b><p>'+esc(state.localAssetUploadBlockReason)+'</p><p>Uploads will be re-enabled after persistent storage is explicitly verified and required by the server.</p>'+(state.cloudMediaReady?'<p>Private cloud media uploads remain a separate capability when an authorized cloud project is available.</p>':'')+'</div>')+'<p class="runtime-engine-note">FFmpeg: '+(state.ffmpeg?"available":"not detected")+' · FFprobe: '+(state.ffprobe?"available":"not detected")+'</p></section></div>'+renderProjectMembers()+
 '<section class="panel"><div class="eyebrow">REMOTE AI USAGE GUARDRAIL</div><h3>Request allowance</h3>'+(state.remoteUsage?('<div class="runtime-summary"><div><small>Used · rolling 24h</small><b>'+state.remoteUsage.used+'</b></div><div><small>Daily limit</small><b>'+(state.remoteUsage.limit===null?"Config error":state.remoteUsage.limit)+'</b></div><div><small>Remaining</small><b>'+(state.remoteUsage.remaining===null?"—":state.remoteUsage.remaining)+'</b></div><div><small>Remote execution</small><b>'+(state.remoteUsage.configurationValid?(state.remoteUsage.remoteDisabled?"Disabled by limit":"Guarded"):"Blocked · invalid config")+'</b></div></div><p class="runtime-engine-note">'+(state.remoteUsage.configurationValid?"Account-wide remote requests are counted before dispatch. Failed requests remain counted until they age out of the 24-hour window.":"Remote requests fail closed until REMOTE_AI_DAILY_REQUEST_LIMIT is corrected.")+' Cost is not estimated; check provider pricing before enabling remote services.</p>'):'<div class="empty">Usage allowance is unavailable until the API is connected.</div>')+'</section>'+'<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">SOURCE & DERIVATIVE LIBRARY</div><h3>Media assets</h3></div><span>'+state.assets.length+' items</span></div>'+renderAssets()+'</section>'+renderCloudAssetLibrary()+
 '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">ASYNC PROCESSING</div><h3>Job queue</h3></div><span>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+' active</span></div>'+renderJobs()+'</section>'+
 '<section class="panel"><div class="eyebrow">COLLABORATIVE REVIEW</div><h3>Comments and decisions</h3>'+(state.projectId&&["owner","editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<form id="ev-review-form"><input type="hidden" name="assetId" value=""><p class="review-target" id="ev-review-target">Project-level review · choose “Review asset” on a media item to attach feedback to that asset.</p><label>Decision</label><select name="decision"><option value="comment">Comment</option><option value="request_changes">Request changes</option><option value="approve">Approve</option></select><label>Timecode (seconds, optional)</label><input name="timecode" type="number" min="0" step="0.001" placeholder="12.500"><label>Review note</label><textarea name="body" rows="3" required maxlength="10000" placeholder="Describe the issue, requested change or approval."></textarea><button class="primary">Submit review</button></form>':'<small>Select a project and use an owner, editor or reviewer account to comment or approve.</small>')+
 '<div class="review-list">'+state.reviews.map(r=>'<article><div><b>'+esc(r.decision.replace("_"," "))+(r.asset_id?' · '+esc(state.assets.find(a=>a.id===r.asset_id)?.name||"media asset"):' · project')+'</b><span class="job-status">'+esc(r.status)+'</span></div><p>'+esc(r.body)+'</p><small>'+(r.timecode_seconds===null||r.timecode_seconds===undefined?"No timecode":r.timecode_seconds.toFixed(3)+"s")+' · '+esc(r.created_at)+'</small>'+(state.projects.find(p=>p.id===state.projectId)?.access_role==="owner"||["editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<div><button data-ev-review-status="resolved" data-ev-review-id="'+esc(r.id)+'">Resolve</button><button data-ev-review-status="open" data-ev-review-id="'+esc(r.id)+'">Reopen</button></div>':'')+'</article>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">AUDIT TRAIL</div><h3>Recent workspace events</h3>'+(state.audit.length?'<div class="audit-list">'+state.audit.slice(0,25).map(e=>'<div><b>'+esc(e.type)+'</b><small>'+esc(e.subjectType)+' · '+esc(e.subjectId)+' · '+esc(e.createdAt)+'</small></div>').join("")+'</div>':'<div class="empty">No events recorded yet.</div>')+'</section></div>';
}

export function renderAssetLibrary(){
 startCloudJobPolling();
 return '<div id="runtime-workspace" data-runtime-view="library"><div class="runtime-toolbar">'+statusMarkup()+'<button class="secondary" data-ev-action="refresh">↻ Refresh</button>'+(state.user?'<button class="secondary" data-ev-action="logout">Sign out</button>':'')+'</div>'+
 (state.status==="offline"||state.status==="auth-required"?'<div class="notice">Sign in to use the persistent asset library. Browser planning drafts remain available offline.</div>':'')+
 '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">PRIVATE MEDIA LIBRARY</div><h3>Originals and derivatives</h3></div><span>'+state.assets.length+' stored assets</span></div><label>Project scope</label><select id="ev-project-select">'+projectOptions()+'</select><p>Upload originals, inspect media metadata, create thumbnails, proxies and audio extracts. Source files remain unchanged.</p><label class="upload primary">＋ Import media<input id="ev-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label>'+renderBatchUpscaleControls()+renderAssets()+'</section>'+renderCloudAssetLibrary()+
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
 return '<div id="runtime-workspace" data-runtime-view="overview" class="stats"><div><small>Project records</small><b>'+state.projects.length+'</b><span>Account-scoped</span></div><div><small>Stored assets</small><b>'+state.assets.length+'</b><span>Account-scoped media</span></div><div><small>Active jobs</small><b>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+'</b><span>Queued or running</span></div><div><small>Media tools</small><b>'+(state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Unavailable")+'</b><span>FFmpeg / FFprobe</span></div></div>'+account+persistenceNoticeMarkup();
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
 state.cloudAssets=[];state.cloudProjects=[];
 if(state.cloudMediaReady){
  try{
   const projectResponse=await apiRequest<{projects:RuntimeCloudProject[]}>("/api/cloud/projects?limit=100");
   state.cloudProjects=Array.isArray(projectResponse.projects)?projectResponse.projects.filter(project=>typeof project?.id==="string"&&typeof project?.name==="string"):[];
   state.cloudProjectId=selectCloudAssetProject(state.cloudProjectId,state.cloudProjects);
   const scope=cloudAssetProjectQuery(state.cloudProjectId);
   if(scope){
    const response=await apiRequest<{assets:RuntimeCloudAsset[]}>("/api/cloud/assets"+scope);
    state.cloudAssets=await Promise.all(response.assets.map(async asset=>{
     try{
      const signed=await apiRequest<{url:string}>("/api/cloud/assets/"+encodeURIComponent(asset.id));
      return {...asset,downloadUrl:signed.url};
     }catch{return {...asset,downloadUrl:null};}
    }));
   }
  }catch{state.cloudAssets=[];state.cloudProjects=[];state.cloudProjectId="";}
 }
 if(state.cloudMediaJobsEnabled&&state.cloudMediaReady&&state.cloudProjectId){
  try{
   const scope=cloudAssetProjectQuery(state.cloudProjectId);
   const response=scope?await apiRequest<{jobs:CloudRuntimeJob[]}>("/api/cloud/jobs"+scope):{jobs:[]};
   state.cloudMediaJobs=response.jobs||[];
  }catch{state.cloudMediaJobs=[];}
 }else state.cloudMediaJobs=[];
 if(state.projectId){try{const response=await apiRequest<{members:Array<{id:string;email:string;role:string;createdAt:string}>}>("/api/projects/"+state.projectId+"/members");state.members=response.members;}catch{state.members=[];}
  try{const response=await apiRequest<{reviews:RuntimeReview[]}>("/api/reviews?projectId="+encodeURIComponent(state.projectId));state.reviews=response.reviews;}catch{state.reviews=[];}
 }
 else {state.members=[];state.reviews=[];}
}
function paint(){updateShell();renderGate();const root=document.querySelector<HTMLElement>("#runtime-workspace");if(root){const view=root.dataset.runtimeView;root.outerHTML=view==="library"?renderAssetLibrary():view==="engines"?renderEngineStatus():view==="overview"?renderRuntimeOverview():renderRuntimeWorkspace();}}
export async function initRuntime(){
 const fragment=new URLSearchParams(window.location.hash.startsWith("#")?window.location.hash.slice(1):window.location.hash);if(fragment.get("type")==="recovery"){const token=fragment.get("access_token")||"";if(token){state.recoveryToken=token;state.authView="reset";state.message="Recovery link verified. Choose a new password.";}else{state.message=fragment.get("error_description")||"This recovery link is invalid or expired. Request a new one.";state.authView="login";}window.history.replaceState({},document.title,window.location.pathname+window.location.search);}
 try{
  const health=await apiRequest<{authMode:"local"|"supabase";authSession?:{configurationReady?:boolean;encryptedServerTokens?:boolean};cloudMedia?:{enabled:boolean;ready:boolean};cloudMediaJobsApi?:{enabled:boolean};persistence?:{dataDirectory:"ephemeral"|"unverified"|"operator-confirmed-volume";persistentVolumeRequired:boolean};localAssetUploads?:{enabled?:boolean;code?:string|null;message?:string|null};database?:"sqlite"|"postgres";storage?:"local-disk"|"object-storage";media:{ffmpeg:boolean;ffprobe:boolean};textGateway:{enabled:boolean;configured:boolean};imageGateway:{enabled:boolean;configured:boolean};billing?:{enabled?:boolean;providerKeyConfigured?:boolean;webhookSecretConfigured?:boolean;provider?:"sandbox"|"live"};cloudVideoWorker?:{enabled?:boolean;remoteExecutionGates?:boolean;modelRouterEnabled?:boolean;modelRouterRemoteEnabled?:boolean;modelRouterConfigPresent?:boolean;providerCredentialConfigured?:boolean;outputHostAllowlistConfigured?:boolean;supabaseCredentialsConfigured?:boolean;directRunwayModelsRequested?:boolean;runtimeMode?:"separate-process"|"embedded"|"unknown"}}>("/api/health");
  state.authMode=health.authMode;state.cloudMediaReady=Boolean(health.cloudMedia?.enabled&&health.cloudMedia?.ready);state.cloudMediaJobsEnabled=health.cloudMediaJobsApi?.enabled===true;state.dataDirectoryPersistence=health.persistence?.dataDirectory||"unknown";state.databaseMode=health.database||"unknown";state.storageMode=health.storage||"unknown";state.persistentVolumeRequired=Boolean(health.persistence?.persistentVolumeRequired);const localUploadReadiness=resolveLocalAssetUploadReadiness(health.localAssetUploads);state.localAssetUploadsAllowed=localUploadReadiness.enabled;state.localAssetUploadBlockReason=localUploadReadiness.message;state.ffmpeg=health.media.ffmpeg;state.ffprobe=health.media.ffprobe;state.textGatewayEnabled=health.textGateway.enabled;state.textGatewayConfigured=health.textGateway.configured;state.imageGatewayEnabled=health.imageGateway.enabled;state.imageGatewayConfigured=health.imageGateway.configured;state.authSessionReady=health.authMode!=="supabase"||health.authSession?.configurationReady===true;state.authSessionEncrypted=health.authMode!=="supabase"||health.authSession?.encryptedServerTokens===true;state.billingEnabled=health.billing?.enabled===true;state.billingProviderConfigured=health.billing?.providerKeyConfigured===true;state.billingWebhookConfigured=health.billing?.webhookSecretConfigured===true;state.billingProviderMode=health.billing?.provider||"unknown";state.cloudVideoWorker={enabled:health.cloudVideoWorker?.enabled===true,remoteExecutionGates:health.cloudVideoWorker?.remoteExecutionGates===true,modelRouterEnabled:health.cloudVideoWorker?.modelRouterEnabled===true,modelRouterRemoteEnabled:health.cloudVideoWorker?.modelRouterRemoteEnabled===true,modelRouterConfigPresent:health.cloudVideoWorker?.modelRouterConfigPresent===true,providerCredentialConfigured:health.cloudVideoWorker?.providerCredentialConfigured===true,outputHostAllowlistConfigured:health.cloudVideoWorker?.outputHostAllowlistConfigured===true,supabaseCredentialsConfigured:health.cloudVideoWorker?.supabaseCredentialsConfigured===true,directRunwayModelsRequested:health.cloudVideoWorker?.directRunwayModelsRequested===true,runtimeMode:health.cloudVideoWorker?.runtimeMode||"unknown"};
  if(health.authMode==="supabase"&&health.authSession?.configurationReady===false){state.status="auth-required";state.authView="login";state.message="Account sign-in is temporarily unavailable. The operator must configure SUPABASE_SESSION_ENCRYPTION_KEY in the server secret manager before sessions can be issued. No browser token fallback is enabled.";}
  else{
   try{const me=await apiRequest<{user:RuntimeUser}>("/api/me");state.user=me.user;state.status="online";await refresh();window.dispatchEvent(new Event("ev:authenticated"));}
   catch(error){if(error instanceof ApiError&&error.status===401)state.status="auth-required";else throw error;}
  }
 }catch(error){state.status="offline";state.message=error instanceof Error?error.message:"API unavailable";}
 paint();
 window.dispatchEvent(new Event("ev:runtime-ready"));
}
async function authenticate(form:HTMLFormElement){
 const data=new FormData(form);
 try{
  const mode=String(data.get("mode")||"login");
  const response=await apiRequest<{user:RuntimeUser;authMode:"local"|"supabase";confirmationRequired?:boolean}>("/api/auth/"+(mode==="register"?"register":"login"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),password:String(data.get("password"))})});
  if(response.confirmationRequired){state.user=null;state.status="auth-required";state.message="Account created. Check your email to confirm the address, then sign in.";paint();return;}
  state.user=response.user;
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
 if(form.id==="ev-evidence-form"){event.preventDefault();const data=new FormData(form),assetId=String(data.get("assetId")||"");const observed=String(data.get("observedAt")||"");void apiRequest("/api/assets/"+encodeURIComponent(assetId)+"/evidence",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targetType:String(data.get("targetType")||""),targetId:String(data.get("targetId")||""),kind:String(data.get("kind")||""),claim:String(data.get("claim")||""),method:String(data.get("method")||""),sourceRef:String(data.get("sourceRef")||""),observedAt:observed?new Date(observed).toISOString():null})}).then(async()=>{state.evidenceError="";state.evidenceRecords=(await apiRequest<{records:Array<Record<string,any>>}>("/api/assets/"+encodeURIComponent(assetId)+"/evidence")).records;if(state.projectId){state.projectEvidenceRecords=(await apiRequest<{records:Array<Record<string,any>>}>("/api/evidence?projectId="+encodeURIComponent(state.projectId))).records;rebuildCreativeGraph();}paint();}).catch(error=>{state.evidenceError=error instanceof Error?error.message:"Evidence submission failed.";paint();});return;}
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
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")void refreshCloudMediaJobs();});
window.addEventListener("beforeunload",()=>{if(cloudJobPollingTimer)clearInterval(cloudJobPollingTimer);cloudJobPollingTimer=null;});
document.addEventListener("change",event=>{
 const target=event.target as HTMLInputElement;
 if(target.id==="ev-project-select"){state.projectId=target.value;void refresh().then(()=>{window.dispatchEvent(new CustomEvent("ev:project-changed",{detail:{projectId:state.projectId}}));paint();}).catch(error=>alert(error.message||error));return;}
 if(target.id==="ev-cloud-project-select"){state.cloudProjectId=target.value;void refresh().then(paint).catch(error=>alert(error.message||error));return;}
 if(target.id==="ev-cloud-upload"&&target.files){
  const files=Array.from(target.files);
  const cloudProjectId=state.cloudProjectId;
  if(!cloudProjectId){alert("Select a cloud project before uploading private media.");target.value="";return;}
  void (async()=>{
   for(const file of files){
    try{
     await apiRequest("/api/cloud/assets",{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-file-name":encodeURIComponent(file.name),"x-project-id":cloudProjectId},body:file});
    }catch(error){alert(file.name+": "+(error instanceof Error?error.message:"Private cloud upload failed."));}
   }
   await refresh();paint();
  })();
 }
 if(target.id==="ev-upload"&&target.files){const files=Array.from(target.files);void (async()=>{for(const file of files){try{const uploaded=await apiRequest<{asset?:{id?:string}}>("/api/assets",{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-file-name":encodeURIComponent(file.name),"x-project-id":state.projectId},body:file});void apiRequest("/api/customer-success/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({eventType:"asset_uploaded",eventKey:"asset-upload:"+String(uploaded.asset?.id||crypto.randomUUID())})}).catch(()=>{});}catch(error){alert(file.name+": "+(error instanceof Error?error.message:"Upload failed"));}}await refresh();paint();})();}
});
document.addEventListener("click",event=>{
 const target=event.target as HTMLElement;
 const authView=target.closest<HTMLElement>("[data-auth-view]");if(authView){state.authView=authView.dataset.authView==="recover"?"recover":"login";state.message="";paint();return;}
 const authMode=target.closest<HTMLElement>("[data-auth-mode]");if(authMode){const form=document.querySelector<HTMLFormElement>("#ev-auth");const mode=form?.elements.namedItem("mode") as HTMLInputElement|null;if(mode)mode.value=authMode.dataset.authMode||"login";document.querySelectorAll("[data-auth-mode]").forEach(button=>button.classList.toggle("active",button===authMode));return;}
 const cloudJobsRefresh=target.closest<HTMLElement>("[data-ev-cloud-jobs-refresh]");
 if(cloudJobsRefresh){void refreshCloudMediaJobs();return;}
 const action=target.closest<HTMLElement>("[data-ev-action]");
 if(action?.dataset.evAction==="refresh"){void refresh().then(paint).catch(error=>alert(error.message||error));return;}
 if(action?.dataset.evAction==="logout"){void apiRequest("/api/auth/logout",{method:"POST"}).catch(()=>{});state.user=null;state.status="auth-required";state.jobs=[];state.assets=[];state.cloudAssets=[];state.cloudProjects=[];state.cloudProjectId="";state.projects=[];paint();return;}
 const evidenceOpen=target.closest<HTMLElement>("[data-ev-evidence-open]");
 if(evidenceOpen){const assetId=evidenceOpen.dataset.evEvidenceOpen||"";state.evidenceAssetId=assetId;state.evidenceRecords=[];state.evidenceLoading=true;state.evidenceError="";paint();void (async()=>{const asset=state.assets.find(item=>item.id===assetId);const result=await apiRequest<{records:Array<Record<string,any>>}>("/api/assets/"+encodeURIComponent(assetId)+"/evidence");state.evidenceRecords=result.records;if(asset?.projectId){const [projectEvidence,workspace,snapshot,timelineData]=await Promise.all([apiRequest<{records:Array<Record<string,any>>}>("/api/evidence?projectId="+encodeURIComponent(asset.projectId)),apiRequest<{document:Record<string,any>}>("/api/projects/"+encodeURIComponent(asset.projectId)+"/workspace"),apiRequest<{snapshot:Record<string,any>|null}>("/api/projects/"+encodeURIComponent(asset.projectId)+"/creative-graph/snapshots"),apiRequest<{timelines:Array<any>}>("/api/timelines?projectId="+encodeURIComponent(asset.projectId)+"&includeGraphData=true")]);state.projectEvidenceRecords=projectEvidence.records;state.creativeGraphWorkspace=workspace.document;state.creativeGraphSnapshot=snapshot.snapshot;state.creativeGraphTimelines=timelineData.timelines.map(timeline=>({id:timeline.id,name:timeline.name,timeline:timeline.graphData}));rebuildCreativeGraph();}else{state.projectEvidenceRecords=result.records;state.creativeGraphWorkspace=null;state.creativeGraphTimelines=[];state.creativeGraphSnapshot=null;state.creativeGraph=null;}state.evidenceLoading=false;paint();})().catch(error=>{state.evidenceLoading=false;state.evidenceError=error instanceof Error?error.message:"Evidence records could not be loaded.";paint();});return;}
 const graphSave=target.closest<HTMLElement>("[data-ev-graph-save]");
 if(graphSave){if(!state.projectId||!state.creativeGraph){alert("Load a project creative graph before saving a baseline.");return;}graphSave.setAttribute("disabled","true");void apiRequest<{snapshot:Record<string,any>}>("/api/projects/"+encodeURIComponent(state.projectId)+"/creative-graph/snapshots",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({graph:state.creativeGraph})}).then(result=>{state.creativeGraphSnapshot=result.snapshot;paint();}).catch(error=>{state.evidenceError=error instanceof Error?error.message:"Creative graph baseline could not be saved.";paint();});return;}
 const evidenceClose=target.closest<HTMLElement>("[data-ev-evidence-close]");
 if(evidenceClose){state.evidenceAssetId="";state.evidenceRecords=[];state.evidenceError="";paint();return;}
 const evidenceReview=target.closest<HTMLElement>("[data-ev-evidence-review]");
 if(evidenceReview){const evidenceId=evidenceReview.dataset.evEvidenceReview||"",note=document.querySelector<HTMLTextAreaElement>('[data-evidence-note="'+CSS.escape(evidenceId)+'"]'),status=document.querySelector<HTMLSelectElement>('[data-evidence-status="'+CSS.escape(evidenceId)+'"]'),asset=state.assets.find(item=>item.id===state.evidenceAssetId);if(!asset||!note||!status)return;if(note.value.trim().length<8){alert("Provide a review reason of at least eight characters.");return;}evidenceReview.setAttribute("disabled","true");void apiRequest("/api/assets/"+encodeURIComponent(asset.id)+"/evidence/"+encodeURIComponent(evidenceId)+"/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:status.value,reviewNote:note.value})}).then(async()=>{state.evidenceRecords=(await apiRequest<{records:Array<Record<string,any>>}>("/api/assets/"+encodeURIComponent(asset.id)+"/evidence")).records;if(state.projectId){state.projectEvidenceRecords=(await apiRequest<{records:Array<Record<string,any>>}>("/api/evidence?projectId="+encodeURIComponent(state.projectId))).records;rebuildCreativeGraph();}state.evidenceError="";paint();}).catch(error=>{state.evidenceError=error instanceof Error?error.message:"Evidence review failed.";paint();});return;}
 const cloudRemove=target.closest<HTMLElement>("[data-ev-cloud-remove]");
 if(cloudRemove){
  const assetId=cloudRemove.dataset.evCloudRemove||"";
  if(!assetId)return;
  if(!window.confirm("Archive this private cloud asset? The asset will be soft-deleted and storage cleanup will follow the configured retention policy."))return;
  void apiRequest("/api/cloud/assets/"+encodeURIComponent(assetId),{method:"DELETE"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error instanceof Error?error.message:"Cloud asset could not be archived."));
  return;
 }
 const cloudJob=target.closest<HTMLElement>("[data-ev-cloud-job]");
 if(cloudJob){
  const assetId=cloudJob.dataset.evCloudAsset||"",jobType=cloudJob.dataset.evCloudJob||"";
  if(!assetId||!jobType)return;
  cloudJob.setAttribute("disabled","true");
  void apiRequest("/api/cloud/assets/"+encodeURIComponent(assetId)+"/media-jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType,options:jobType==="media.thumbnail"?{seconds:1}:{}})})
   .then(async()=>{await refresh();paint();alert("Private cloud processing job queued. Track its status in the Cloud Worker Queue.");})
   .catch(error=>{cloudJob.removeAttribute("disabled");alert(error instanceof Error?error.message:"Cloud media job could not be queued.");});
  return;
 }
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
 const selfTestButton=target.closest<HTMLElement>("[data-ev-upscale-self-test]");
 if(selfTestButton){
  const sourceAssetId=document.querySelector<HTMLSelectElement>("#ev-upscale-self-test-asset")?.value||"";
  const model=document.querySelector<HTMLSelectElement>("#ev-upscale-self-test-model")?.value||"";
  const scale=Number(document.querySelector<HTMLSelectElement>("#ev-upscale-self-test-scale")?.value||2);
  if(!sourceAssetId||!model){alert("Select an eligible test image and an installed model first.");return;}
  selfTestButton.setAttribute("disabled","true");
  void apiRequest<{selfTest:{passed:boolean;executionVerified:boolean;inferenceVerified:boolean;model:string;scale:number;outputBytes:number}}>("/api/admin/ai-upscale/self-test",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sourceAssetId,model,scale})})
   .then(async result=>{await refresh();paint();alert("Inference self-test passed for "+result.selfTest.model+" at "+result.selfTest.scale+"×. Output: "+result.selfTest.outputBytes.toLocaleString()+" bytes. Independent five-category visual review is still required.");})
   .catch(error=>{selfTestButton.removeAttribute("disabled");alert(error instanceof Error?error.message:"Worker inference self-test failed.");});
  return;
 }
 const batchButton=target.closest<HTMLElement>("[data-ev-batch-upscale]");
 if(batchButton){
  const selected=Array.from(document.querySelectorAll<HTMLInputElement>("[data-ev-batch-asset]:checked")).map(input=>input.dataset.evBatchAsset||"").filter(Boolean);
  if(!selected.length){alert("Select at least one original image.");return;}
  if(selected.length>100){alert("A batch can contain at most 100 images.");return;}
  const model=(document.querySelector<HTMLSelectElement>("#ev-batch-upscale-model")?.value||"").trim();
  const scale=Number(document.querySelector<HTMLSelectElement>("#ev-batch-upscale-scale")?.value||4);
  if(!model){alert("No verified enhancement model is available.");return;}
  batchButton.setAttribute("disabled","true");
  void apiRequest("/api/jobs/batch",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({projectId:state.projectId||undefined,model,scale,format:"png",tile:0,items:selected.map(sourceAssetId=>({sourceAssetId}))})})
   .then(async()=>{await refresh();paint();alert("Batch queued. Each image has its own job and shared batch ID.");})
   .catch(error=>{batchButton.removeAttribute("disabled");alert(error instanceof Error?error.message:"Batch submission failed.");});
  return;
 }
 const cloudCancel=target.closest<HTMLElement>("[data-ev-cloud-cancel]");
 if(cloudCancel){
  const id=cloudCancel.dataset.evCloudCancel||"";cloudCancel.setAttribute("disabled","true");
  void apiRequest<{job:{status:string;cancel_requested_at?:string|null};idempotentReplay:boolean;cancellationRequested:boolean}>("/api/cloud/jobs/"+encodeURIComponent(id)+"/cancel",{method:"POST"})
   .then(async result=>{state.message=result.cancellationRequested?(result.job.status==="queued"?"Cancellation queued. The worker will mark the job cancelled before starting execution.":"Cancellation requested. The active worker will stop at its next cancellation check."):"Cloud job cancelled.";await refresh();paint();})
   .catch(error=>{cloudCancel.removeAttribute("disabled");state.message=error instanceof Error?error.message:"Cloud job cancellation could not be recorded.";paint();});
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
