import { apiRequest, ApiError, setApiAccessToken, clearApiAccessToken } from "../core/api";

type RuntimeUser={id:string;email:string};
type RuntimeProject={id:string;name:string;description?:string;revision?:number;access_role?:"owner"|"editor"|"reviewer"|"viewer"};
type RuntimeAsset={id:string;projectId?:string|null;name:string;mediaType:string;size:number;sha256:string;createdAt:string};
type RuntimeJob={id:string;projectId?:string|null;jobType:string;status:string;progress:number;input:Record<string,unknown>;output?:Record<string,unknown>|null;error?:{code?:string;message?:string}|null;createdAt:string;updatedAt:string};
type RuntimeReview={id:string;project_id:string;asset_id?:string|null;timecode_seconds?:number|null;decision:string;body:string;status:string;created_at:string};
const state:{status:"checking"|"offline"|"auth-required"|"online";authMode:"local"|"supabase";user:RuntimeUser|null;projects:RuntimeProject[];assets:RuntimeAsset[];jobs:RuntimeJob[];audit:Array<Record<string,unknown>>;members:Array<{id:string;email:string;role:string;createdAt:string}>;reviews:RuntimeReview[];projectId:string;message:string;ffmpeg:boolean;ffprobe:boolean}={
 status:"checking",authMode:"local",user:null,projects:[],assets:[],jobs:[],audit:[],members:[],reviews:[],projectId:"",message:"",ffmpeg:false,ffprobe:false
};
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const fmt=(value:string)=>new Date(value).toLocaleString();
function statusMarkup(){return '<span class="runtime-status '+state.status+'"><i></i>'+esc(state.status==="online"?"API CONNECTED":state.status==="auth-required"?"SIGN IN REQUIRED":state.status==="offline"?"OFFLINE":"CONNECTING")+'</span>';}
function updateShell(){
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
 document.body.insertAdjacentHTML("beforeend",'<div id="ev-auth-gate" class="auth-overlay"><section class="auth-card"><div class="eyebrow">SECURE PRODUCTION WORKSPACE</div><h2>Sign in to continue</h2><p>Projects, original media, processing jobs and audit history are private to your account.</p>'+
 (external?'<form id="ev-auth-token"><label>Access token</label><textarea name="token" rows="3" required autocomplete="off" placeholder="Paste a short-lived access token"></textarea><button class="primary wide">Verify session</button></form>':
 '<form id="ev-auth"><label>Email</label><input name="email" type="email" required autocomplete="username"><label>Password</label><input name="password" type="password" minlength="12" required autocomplete="current-password"><label>Account action</label><select name="mode"><option value="login">Sign in</option><option value="register">Create local development account</option></select><button class="primary wide">Continue securely</button></form>')+
 '<p class="auth-error">'+esc(state.message)+'</p><small>Local password accounts are development-only. Production requires the configured external identity service.</small></section></div>');
}
function projectOptions(){return '<option value="">Personal library</option>'+state.projects.map(p=>'<option value="'+esc(p.id)+'" '+(state.projectId===p.id?"selected":"")+'>'+esc(p.name)+'</option>').join("");}
function renderAssets(){
 if(!state.assets.length)return '<div class="empty">No stored media yet. Upload a source file to begin.</div>';
 return '<div class="runtime-assets">'+state.assets.map(a=>{
   const isVideo=a.mediaType.startsWith("video/"),isAudio=a.mediaType.startsWith("audio/"),isImage=a.mediaType.startsWith("image/");
   return '<article class="runtime-asset"><div class="runtime-asset-preview">'+(isImage?'<img src="/api/assets/'+esc(a.id)+'/file" alt="">':isVideo?"▶":isAudio?"♫":"▤")+'</div><div class="runtime-asset-info"><b>'+esc(a.name)+'</b><small>'+Math.max(1,Math.round(a.size/1024))+' KB · '+esc(a.mediaType)+'</small><code>'+esc(a.sha256.slice(0,20))+'…</code></div><div class="runtime-asset-actions"><button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect</button>'+(isVideo?'<button data-ev-job="media.thumbnail" data-ev-asset="'+esc(a.id)+'">Extract frame</button><button data-ev-job="media.proxy" data-ev-asset="'+esc(a.id)+'">Create proxy</button><button data-ev-job="media.audio_extract" data-ev-asset="'+esc(a.id)+'">Extract audio</button>':isAudio?'<button data-ev-job="media.probe" data-ev-asset="'+esc(a.id)+'">Inspect audio</button>':'')+'</div></article>';
 }).join("")+'</div>';
}
function renderJobs(){
 if(!state.jobs.length)return '<div class="empty">No jobs submitted. Media processing jobs will appear here with progress, events and output assets.</div>';
 return '<div class="runtime-jobs">'+state.jobs.map(j=>'<article class="runtime-job"><div class="runtime-job-heading"><b>'+esc(j.jobType)+'</b><span class="job-status '+esc(j.status)+'">'+esc(j.status)+'</span></div><code>'+esc(j.id)+'</code><div class="progress"><i style="width:'+Math.max(0,Math.min(100,j.progress))+'%"></i></div><small>'+Math.round(j.progress)+'% · '+fmt(j.createdAt)+'</small>'+(j.error?'<p class="job-error">'+esc(j.error.code||"ERROR")+' · '+esc(j.error.message||"")+'</p>':'')+(j.status==="queued"||j.status==="running"?'<button data-ev-cancel="'+esc(j.id)+'">Cancel</button>':'')+'</article>').join("")+'</div>';
}
export function renderRuntimeWorkspace(){
 return '<div id="runtime-workspace"><div class="runtime-toolbar">'+statusMarkup()+'<button class="secondary" data-ev-action="refresh">↻ Refresh</button>'+(state.user?'<button class="secondary" data-ev-action="logout">Sign out · '+esc(state.user.email)+'</button>':'')+'</div>'+
 (state.status==="offline"?'<div class="notice">The local API is not reachable. Start the complete stack with <code>npm run dev</code>. Planning workspaces remain available; uploads and processing require the API.</div>':'')+
 (state.status==="auth-required"?'<div class="notice">Sign in to activate persistent project and media storage. Other planning workspaces remain available.</div>':'')+
 '<div class="runtime-summary"><div><small>Projects</small><b>'+state.projects.length+'</b></div><div><small>Stored assets</small><b>'+state.assets.length+'</b></div><div><small>Jobs</small><b>'+state.jobs.length+'</b></div><div><small>Local media tools</small><b>'+(state.ffmpeg&&state.ffprobe?"Ready":state.ffprobe?"Probe only":"Not detected")+'</b></div></div>'+
 '<div class="runtime-two-col"><section class="panel"><div class="eyebrow">PROJECT REGISTRY</div><h3>Persistent projects</h3><form id="ev-project-form"><label>New project name</label><input name="name" required maxlength="160" placeholder="Campaign, film, episode or client project"><button class="primary">Create project</button></form><label>Current project</label><select id="ev-project-select">'+projectOptions()+'</select><div class="runtime-project-list">'+state.projects.map(p=>'<div><b>'+esc(p.name)+'</b><small>'+esc(p.id)+'</small></div>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">MEDIA INGEST</div><h3>Upload original media</h3><p>Originals are stored unchanged. Uploads receive a SHA-256 checksum and remain private to this account.</p><label class="upload primary">＋ Select media<input id="ev-upload" type="file" multiple accept="image/*,video/*,audio/*,application/pdf,text/plain"></label><small>250 MiB maximum per file · supported image, video, audio and document types</small><p class="runtime-engine-note">FFmpeg: '+(state.ffmpeg?"available":"not detected")+' · FFprobe: '+(state.ffprobe?"available":"not detected")+'</p></section></div>'+
 '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">SOURCE & DERIVATIVE LIBRARY</div><h3>Media assets</h3></div><span>'+state.assets.length+' items</span></div>'+renderAssets()+'</section>'+
 '<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">ASYNC PROCESSING</div><h3>Job queue</h3></div><span>'+state.jobs.filter(j=>["queued","running"].includes(j.status)).length+' active</span></div>'+renderJobs()+'</section>'+
 '<section class="panel"><div class="eyebrow">COLLABORATIVE REVIEW</div><h3>Comments and decisions</h3>'+(state.projectId&&["owner","editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<form id="ev-review-form"><label>Decision</label><select name="decision"><option value="comment">Comment</option><option value="request_changes">Request changes</option><option value="approve">Approve</option></select><label>Timecode (seconds, optional)</label><input name="timecode" type="number" min="0" step="0.001" placeholder="12.500"><label>Review note</label><textarea name="body" rows="3" required maxlength="10000" placeholder="Describe the issue, requested change or approval."></textarea><button class="primary">Submit review</button></form>':'<small>Select a project and use an owner, editor or reviewer account to comment or approve.</small>')+
 '<div class="review-list">'+state.reviews.map(r=>'<article><div><b>'+esc(r.decision.replace("_"," "))+'</b><span class="job-status">'+esc(r.status)+'</span></div><p>'+esc(r.body)+'</p><small>'+(r.timecode_seconds===null||r.timecode_seconds===undefined?"No timecode":r.timecode_seconds.toFixed(3)+"s")+' · '+esc(r.created_at)+'</small>'+(state.projects.find(p=>p.id===state.projectId)?.access_role==="owner"||["editor","reviewer"].includes(state.projects.find(p=>p.id===state.projectId)?.access_role||"")?'<div><button data-ev-review-status="resolved" data-ev-review-id="'+esc(r.id)+'">Resolve</button><button data-ev-review-status="open" data-ev-review-id="'+esc(r.id)+'">Reopen</button></div>':'')+'</article>').join("")+'</div></section>'+
 '<section class="panel"><div class="eyebrow">AUDIT TRAIL</div><h3>Recent workspace events</h3>'+(state.audit.length?'<div class="audit-list">'+state.audit.slice(0,25).map(e=>'<div><b>'+esc(e.type)+'</b><small>'+esc(e.subjectType)+' · '+esc(e.subjectId)+' · '+esc(e.createdAt)+'</small></div>').join("")+'</div>':'<div class="empty">No events recorded yet.</div>')+'</section></div>';
}
async function refresh(){
 const [projects,assets,jobs,audit]=await Promise.all([
  apiRequest<{projects:RuntimeProject[]}>("/api/projects"),
  apiRequest<{assets:RuntimeAsset[]}>("/api/assets"),
  apiRequest<{jobs:RuntimeJob[]}>("/api/jobs"),
  apiRequest<{events:Array<Record<string,unknown>>}>("/api/audit")
 ]);
 state.projects=projects.projects;state.assets=assets.assets;state.jobs=jobs.jobs;state.audit=audit.events;
 if(state.projectId&&!state.projects.some(p=>p.id===state.projectId))state.projectId="";
 if(state.projectId){try{const response=await apiRequest<{members:Array<{id:string;email:string;role:string;createdAt:string}>}>("/api/projects/"+state.projectId+"/members");state.members=response.members;}catch{state.members=[];}
  try{const response=await apiRequest<{reviews:RuntimeReview[]}>("/api/reviews?projectId="+encodeURIComponent(state.projectId));state.reviews=response.reviews;}catch{state.reviews=[];}
 }
 else {state.members=[];state.reviews=[];}
}
function paint(){updateShell();renderGate();const root=document.querySelector<HTMLElement>("#runtime-workspace");if(root)root.outerHTML=renderRuntimeWorkspace();}
export async function initRuntime(){
 try{
  const health=await apiRequest<{authMode:"local"|"supabase";media:{ffmpeg:boolean;ffprobe:boolean}}>("/api/health");
  state.authMode=health.authMode;state.ffmpeg=health.media.ffmpeg;state.ffprobe=health.media.ffprobe;
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
 if(form.id==="ev-project-form"){event.preventDefault();const name=String(new FormData(form).get("name")||"").trim();if(!name)return;void apiRequest<{project:RuntimeProject}>("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})}).then(async result=>{state.projectId=result.project.id;await refresh();paint();}).catch(error=>alert(error.message||error));}
 if(form.id==="ev-member-form"){event.preventDefault();const data=new FormData(form);void apiRequest("/api/projects/"+state.projectId+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(data.get("email")),role:String(data.get("role"))})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
 if(form.id==="ev-review-form"){event.preventDefault();const data=new FormData(form),timecode=String(data.get("timecode")||"");void apiRequest("/api/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:state.projectId,decision:String(data.get("decision")),body:String(data.get("body")),timecodeSeconds:timecode?Number(timecode):null})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
});
document.addEventListener("change",event=>{
 const target=event.target as HTMLInputElement;
 if(target.id==="ev-project-select"){state.projectId=target.value;void refresh().then(paint).catch(error=>alert(error.message||error));return;}
 if(target.id==="ev-upload"&&target.files){const files=Array.from(target.files);void (async()=>{for(const file of files){try{await apiRequest("/api/assets",{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-file-name":encodeURIComponent(file.name),"x-project-id":state.projectId},body:file});}catch(error){alert(file.name+": "+(error instanceof Error?error.message:"Upload failed"));}}await refresh();paint();})();}
});
document.addEventListener("click",event=>{
 const target=event.target as HTMLElement;
 const action=target.closest<HTMLElement>("[data-ev-action]");
 if(action?.dataset.evAction==="refresh"){void refresh().then(paint).catch(error=>alert(error.message||error));return;}
 if(action?.dataset.evAction==="logout"){void apiRequest("/api/auth/logout",{method:"POST"}).catch(()=>{});clearApiAccessToken();state.user=null;state.status="auth-required";state.jobs=[];state.assets=[];state.projects=[];paint();return;}
 const job=target.closest<HTMLElement>("[data-ev-job]");
 if(job){const assetId=job.dataset.evAsset||"",jobType=job.dataset.evJob||"";void apiRequest("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({jobType,sourceAssetId:assetId,projectId:state.projectId||undefined})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const remove=target.closest<HTMLElement>("[data-ev-remove-member]");
 if(remove){void apiRequest("/api/projects/"+state.projectId+"/members/"+remove.dataset.evRemoveMember,{method:"DELETE"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const review=target.closest<HTMLElement>("[data-ev-review-status]");
 if(review){void apiRequest("/api/reviews/"+review.dataset.evReviewId,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({status:review.dataset.evReviewStatus})}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));return;}
 const cancel=target.closest<HTMLElement>("[data-ev-cancel]");
 if(cancel){void apiRequest("/api/jobs/"+cancel.dataset.evCancel+"/cancel",{method:"POST"}).then(async()=>{await refresh();paint();}).catch(error=>alert(error.message||error));}
});
