import { apiRequest } from "../core/api";

type Overview={users:number;projects:number;assets:number;jobs:number;jobsByStatus:Record<string,number>;usage30d:{operations:number;estimatedCostMicros:number};generatedAt:string;runtime:{authMode:string;dataPersistence:string;persistentDataRequired:boolean}};
type UserRow={id:string;email:string;authSource:string;createdAt:string;projects:number;jobs:number;usage30d:number};
type JobRow={id:string;email:string;jobType:string;status:string;progress:number;attempts:number;createdAt:string;updatedAt:string;completedAt:string|null};
type ProviderRow={id:string;provider:string;status:string;enabled:boolean;configured:boolean;remote:boolean;model:string|null;reason:string;capabilities:string[]};
type AuditRow={id:number;ownerId:string;email:string;eventType:string;subjectType:string;subjectId:string;createdAt:string};
const state:{loading:boolean;error:string;overview:Overview|null;users:UserRow[];jobs:JobRow[];providers:ProviderRow[];audit:AuditRow[];updatedAt:string}={loading:false,error:"Administrator data has not been loaded.",overview:null,users:[],jobs:[],providers:[],audit:[],updatedAt:""};
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const date=(value:string|null|undefined)=>{if(!value)return "—";const d=new Date(value);return Number.isNaN(d.getTime())?"—":d.toLocaleString();};
const money=(value:number)=>{const n=Number(value||0)/1_000_000;return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);};
function statusClass(value:string){return ["ready","succeeded","completed","active"].includes(value)?"good":["failed","disabled","needs_configuration","remote_opt_in_required"].includes(value)?"warn":"neutral";}
export function renderAdminOperationsWorkspace(){
 const o=state.overview;
 const metric=(label:string,value:string|number,detail:string)=>'<article class="admin-ops-metric"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong><span>'+esc(detail)+'</span></article>';
 return '<div class="admin-ops-head"><div><div class="eyebrow">RESTRICTED · PLATFORM OPERATIONS</div><h1>Administrator control centre</h1><p>Live operational visibility for accounts, workloads, model providers and audit activity. Sensitive provider credentials are never returned to this screen.</p></div><button class="secondary" data-admin-ops-refresh '+(state.loading?'disabled':'')+'>↻ '+(state.loading?'Refreshing':'Refresh live data')+'</button></div>'+
 (state.error?'<div class="notice '+(state.overview?'':'warning')+'">'+esc(state.error)+'</div>':'')+
 '<section class="admin-ops-metrics">'+metric("Accounts",o?.users??"—","Registered application users")+metric("Projects",o?.projects??"—","Persistent project records")+metric("Private assets",o?.assets??"—","Asset metadata records")+metric("Jobs",o?.jobs??"—","All recorded processing jobs")+'</section>'+
 '<section class="admin-ops-grid"><article class="panel"><div class="eyebrow">WORKER HEALTH</div><h2>Job queue by state</h2><div class="admin-ops-status-grid">'+Object.entries(o?.jobsByStatus||{}).map(([key,value])=>'<div><span>'+esc(key.replaceAll("_"," "))+'</span><b>'+Number(value).toLocaleString()+'</b></div>').join("")+'</div><p class="muted">Counts are read from the application job ledger. This view does not modify or retry jobs.</p></article>'+
 '<article class="panel"><div class="eyebrow">AI USAGE · LAST 30 DAYS</div><h2>'+Number(o?.usage30d.operations||0).toLocaleString()+' operations</h2><div class="admin-ops-cost">'+money(o?.usage30d.estimatedCostMicros||0)+'</div><p class="muted">Estimated provider cost from recorded usage events; not an invoice or settled charge.</p></article></section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">MODEL CONNECTIVITY</div><h2>AI provider readiness</h2></div><span class="muted">Status only · credentials remain server-side</span></div>'+
 (state.providers.length?'<div class="admin-ops-provider-grid">'+state.providers.map(p=>'<article class="admin-ops-provider"><div><b>'+esc(p.provider||p.id)+'</b><span class="readiness-pill '+statusClass(p.status)+'">'+esc(p.status.replaceAll("_"," "))+'</span></div><small>'+esc(p.model||"No model selected")+'</small><p>'+esc(p.reason||"No additional status details.")+'</p><div class="admin-ops-tags"><span>'+ (p.enabled?"Enabled":"Disabled")+'</span><span>'+ (p.configured?"Configured":"Not configured")+'</span><span>'+ (p.remote?"Remote":"Local / unknown")+'</span></div></article>').join("")+'</div>':'<div class="empty">No provider status has been returned.</div>')+'</section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">ACCOUNT DIRECTORY</div><h2>Recent application users</h2></div><span class="muted">'+state.users.length+' shown</span></div>'+
 (state.users.length?'<div class="admin-ops-table-wrap"><table class="admin-ops-table"><thead><tr><th>Account</th><th>Auth</th><th>Projects</th><th>Jobs</th><th>Usage · 30d</th><th>Created</th></tr></thead><tbody>'+state.users.map(u=>'<tr><td><b>'+esc(u.email)+'</b><small>'+esc(u.id)+'</small></td><td>'+esc(u.authSource)+'</td><td>'+u.projects+'</td><td>'+u.jobs+'</td><td>'+u.usage30d+'</td><td>'+esc(date(u.createdAt))+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty">No application users found.</div>')+'</section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">EXECUTION MONITOR</div><h2>Recent processing jobs</h2></div><span class="muted">'+state.jobs.length+' shown</span></div>'+
 (state.jobs.length?'<div class="admin-ops-table-wrap"><table class="admin-ops-table"><thead><tr><th>Job</th><th>Account</th><th>Type</th><th>Status</th><th>Progress</th><th>Attempts</th><th>Created</th></tr></thead><tbody>'+state.jobs.map(j=>'<tr><td><code>'+esc(j.id.slice(0,12))+'</code></td><td>'+esc(j.email)+'</td><td>'+esc(j.jobType)+'</td><td><span class="readiness-pill '+statusClass(j.status)+'">'+esc(j.status)+'</span></td><td>'+Math.max(0,Math.min(100,Number(j.progress)||0))+'%</td><td>'+j.attempts+'</td><td>'+esc(date(j.createdAt))+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty">No processing jobs found.</div>')+'</section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">GOVERNANCE</div><h2>Recent audit activity</h2></div><span class="muted">'+state.audit.length+' shown</span></div>'+
 (state.audit.length?'<div class="admin-ops-audit">'+state.audit.map(e=>'<article><b>'+esc(e.eventType.replaceAll("_"," "))+'</b><small>'+esc(e.email)+' · '+esc(e.subjectType)+' '+esc(e.subjectId)+'</small><time>'+esc(date(e.createdAt))+'</time></article>').join("")+'</div>':'<div class="empty">No audit activity recorded.</div>')+'</section>'+
 '<footer class="admin-ops-footer">Last refreshed: '+esc(state.updatedAt||"Not yet")+'. Runtime: '+esc(o?.runtime.authMode||"unknown")+'. Storage: '+esc(o?.runtime.dataPersistence||"unknown")+'. '+(o?.runtime.persistentDataRequired?"Persistent storage is required by configuration.":"Persistent storage is not enforced by configuration.")+'</footer>'+
 '<div class="admin-ops-links"><button class="secondary" data-tab="finance">Open financial command centre</button><button class="secondary" data-tab="readiness">Open release readiness</button><button class="secondary" data-tab="engines">Open creative engines</button></div>';
}
export async function loadAdminOperationsWorkspace(){
 state.loading=true;state.error="";paint();
 try{
  const [overview,users,jobs,providers,audit]=await Promise.all([
   apiRequest<{overview:Overview}>("/api/admin/operations/overview"),
   apiRequest<{users:UserRow[]}>("/api/admin/operations/users?limit=100"),
   apiRequest<{jobs:JobRow[]}>("/api/admin/operations/jobs?limit=100"),
   apiRequest<{providers:ProviderRow[]}>("/api/admin/operations/providers"),
   apiRequest<{events:AuditRow[]}>("/api/admin/operations/audit?limit=100")
  ]);
  state.overview=overview.overview;state.users=users.users;state.jobs=jobs.jobs;state.providers=providers.providers;state.audit=audit.events;state.updatedAt=new Date().toISOString();state.error="";
 }catch(error){state.error=error instanceof Error?error.message:"Administrator data could not be loaded. Check the administrator allowlist and sign-in.";state.overview=null;}
 finally{state.loading=false;paint();}
}
function paint(){const view=document.querySelector<HTMLElement>("#view");if(view?.dataset.adminOperations==="true")view.innerHTML=renderAdminOperationsWorkspace();}
export function initAdminOperationsWorkspace(){
 document.addEventListener("click",event=>{if((event.target as HTMLElement).closest("[data-admin-ops-refresh]"))void loadAdminOperationsWorkspace();});
}
