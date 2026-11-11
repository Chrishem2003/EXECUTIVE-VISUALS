import { apiRequest } from "../core/api";

type Overview={users:number;projects:number;assets:number;jobs:number;jobsByStatus:Record<string,number>;queueHealth:{queued:number;running:number;failed24h:number;expiredLeaseJobs:number;missingLeaseJobs:number;oldestQueuedAt:string|null;oldestRunningAt:string|null;oldestQueuedAgeSeconds:number|null;oldestRunningAgeSeconds:number|null;status:"healthy"|"warning"|"critical"};usage30d:{operations:number;estimatedCostMicros:number};generatedAt:string;runtime:{authMode:string;dataPersistence:string;persistentDataRequired:boolean}};
type UserRow={id:string;email:string;authSource:string;createdAt:string;projects:number;jobs:number;usage30d:number};
type JobRow={id:string;email:string;jobType:string;status:string;progress:number;attempts:number;createdAt:string;updatedAt:string;completedAt:string|null;leaseExpiresAt?:string|null;leaseHeartbeatAt?:string|null;leaseState?:"active"|"expired"|"missing"|"not_running"};
type ProviderModelRow={id:string;label:string;readiness?:string;available?:boolean;executionVerified?:boolean;qualityVerified?:boolean;reason?:string;resolutions?:string[];aspectRatios?:string[];inputModes?:string[];minDurationSeconds?:number;maxDurationSeconds?:number};
type ProviderRow={id:string;provider:string;status:string;enabled:boolean;configured:boolean;remote:boolean;model:string|null;reason:string;capabilities:string[];availableModels?:ProviderModelRow[];modelCapabilities?:{startFrame?:boolean;endFrame?:boolean;referenceImages?:boolean;audioModes?:string[];resolutions?:string[];aspectRatios?:string[];minDurationSeconds?:number;maxDurationSeconds?:number}|null;pricing?:{configured:boolean;rejectedCount:number;models:Array<{provider:string;model:string;currency:string;sourceUrl:string;observedAt:string;expiresAt:string}>}|null};
type ProviderSummary={total:number;ready:number;disabled:number;unverified:number;needsConfiguration:number;remoteOptInRequired:number;unavailable:number;models:number;qualityVerifiedModels:number};
type GenerationReadiness={status:"ready"|"blocked";canSubmit:boolean;checks:Record<string,boolean>;blockers:Array<{check:string;message:string}>;videoProvider:{provider:string;model:string|null;status:string;remote:boolean}|null;appDataPersistence:string;appDataPersistenceWarning:string|null;policy:{requestsSubmitted:boolean;providerCredentialsExposed:boolean;chargesInitiated:boolean}};
type AuditRow={id:number;ownerId:string;email:string;eventType:string;subjectType:string;subjectId:string;createdAt:string};
type BillingOps={access:"ready"|"restricted"|"partial";provider:any;reconciliation:any;recovery:any;message:string;actionMessage:string};
let refreshSequence=0;
const state:{allowed:boolean;loading:boolean;error:string;overview:Overview|null;users:UserRow[];jobs:JobRow[];providers:ProviderRow[];providerSummary:ProviderSummary;generationReadiness:GenerationReadiness|null;audit:AuditRow[];userQuery:string;billingOps:BillingOps;updatedAt:string}={allowed:false,loading:false,error:"Checking administrator access…",overview:null,users:[],jobs:[],providers:[],providerSummary:{total:0,ready:0,disabled:0,unverified:0,needsConfiguration:0,remoteOptInRequired:0,unavailable:0,models:0,qualityVerifiedModels:0},generationReadiness:null,audit:[],userQuery:"",billingOps:{access:"restricted",provider:null,reconciliation:null,recovery:null,message:"Billing administrator role has not been checked.",actionMessage:""},updatedAt:""};
export function isAdminOperationsAllowed(){return state.allowed;}
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const date=(value:string|null|undefined)=>{if(!value)return "—";const d=new Date(value);return Number.isNaN(d.getTime())?"—":d.toLocaleString();};
const duration=(value:number|null|undefined)=>{if(value===null||value===undefined||!Number.isFinite(value))return "—";const seconds=Math.max(0,Math.floor(value));if(seconds<60)return seconds+"s";const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+"m";const hours=Math.floor(minutes/60);if(hours<24)return hours+"h "+(minutes%60)+"m";return Math.floor(hours/24)+"d "+(hours%24)+"h";};
const money=(value:number)=>{const n=Number(value||0)/1_000_000;return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);};
function pricingFreshness(expiresAt:string,observedAt:string){const expiry=Date.parse(expiresAt),observed=Date.parse(observedAt);if(!Number.isFinite(observed))return "Observation date not supplied";if(!Number.isFinite(expiry))return "Expiry not supplied";if(expiry<=Date.now())return "Expired";if(expiry<=Date.now()+7*24*60*60*1000)return "Expires within 7 days";return "Current until "+new Date(expiry).toLocaleDateString();}
function renderGenerationReadiness(){
 const readiness=state.generationReadiness;
 if(!readiness)return '<div class="notice warning">Video generation readiness has not been loaded.</div>';
 const checks=Object.entries(readiness.checks).map(([key,ok])=>'<span class="readiness-pill '+(ok?"good":"warn")+'">'+esc(key.replace(/([A-Z])/g," $1").replace(/^./,value=>value.toUpperCase()))+": "+(ok?"passed":"blocked")+'</span>').join("");
 const blockers=readiness.blockers.length?'<ul>'+readiness.blockers.map(item=>'<li>'+esc(item.message)+'</li>').join("")+'</ul>':'<p class="muted">Infrastructure gates are ready. Each generation still requires user authorization, a valid cost estimate and a recorded budget approval.</p>';
 return '<article class="admin-ops-provider admin-ops-generation-readiness"><div><b>Video generation execution gate</b><span class="readiness-pill '+(readiness.canSubmit?"good":"warn")+'">'+(readiness.canSubmit?"Ready for approved submissions":"Blocked · prerequisites missing")+'</span></div><p>'+esc(readiness.videoProvider?readiness.videoProvider.provider+" · "+(readiness.videoProvider.model||"model not selected")+" · "+readiness.videoProvider.status:"No ready video provider")+'</p><div class="admin-ops-tags">'+checks+'</div>'+blockers+(readiness.appDataPersistenceWarning?'<p class="notice warning">'+esc(readiness.appDataPersistenceWarning)+'</p>':'')+'<small>Diagnostic only · no provider request, generation job or charge was submitted.</small></article>';
}
function statusClass(value:string){return ["ready","succeeded","completed","active"].includes(value)?"good":["failed","disabled","needs_configuration","remote_opt_in_required"].includes(value)?"warn":"neutral";}
export function renderAdminOperationsWorkspace(){
 const o=state.overview;
 const metric=(label:string,value:string|number,detail:string)=>'<article class="admin-ops-metric"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong><span>'+esc(detail)+'</span></article>';
 return '<div class="admin-ops-head"><div><div class="eyebrow">RESTRICTED · PLATFORM OPERATIONS</div><h1>Administrator control centre</h1><p>Live operational visibility for accounts, workloads, model providers and audit activity. Sensitive provider credentials are never returned to this screen.</p></div><button class="secondary" data-admin-ops-refresh '+(state.loading?'disabled':'')+'>↻ '+(state.loading?'Refreshing':'Refresh live data')+'</button></div>'+
 (state.error?'<div class="notice '+(state.overview?'':'warning')+'">'+esc(state.error)+'</div>':'')+
 '<section class="admin-ops-metrics">'+metric("Accounts",o?.users??"—","Registered application users")+metric("Projects",o?.projects??"—","Persistent project records")+metric("Private assets",o?.assets??"—","Asset metadata records")+metric("Jobs",o?.jobs??"—","All recorded processing jobs")+'</section>'+
 '<section class="admin-ops-grid"><article class="panel"><div class="eyebrow">WORKER HEALTH</div><h2>Job queue by state</h2><span class="readiness-pill '+(o?.queueHealth?.status==="critical"?"warn":o?.queueHealth?.status==="warning"?"neutral":"good")+'">'+esc(o?.queueHealth?.status||"unknown")+' queue health</span><div class="admin-ops-status-grid">'+Object.entries(o?.jobsByStatus||{}).map(([key,value])=>'<div><span>'+esc(key.replaceAll("_"," "))+'</span><b>'+Number(value).toLocaleString()+'</b></div>').join("")+'</div><div class="admin-ops-status-grid"><div><span>Queued</span><b>'+Number(o?.queueHealth?.queued||0).toLocaleString()+'</b></div><div><span>Running</span><b>'+Number(o?.queueHealth?.running||0).toLocaleString()+'</b></div><div><span>Failed · 24h</span><b>'+Number(o?.queueHealth?.failed24h||0).toLocaleString()+'</b></div><div><span>Expired leases</span><b>'+Number(o?.queueHealth?.expiredLeaseJobs||0).toLocaleString()+'</b></div><div><span>Missing leases</span><b>'+Number(o?.queueHealth?.missingLeaseJobs||0).toLocaleString()+'</b></div></div><p class="muted">Oldest queued: '+esc(duration(o?.queueHealth?.oldestQueuedAgeSeconds))+' ago ('+esc(date(o?.queueHealth?.oldestQueuedAt))+') · oldest running: '+esc(duration(o?.queueHealth?.oldestRunningAgeSeconds))+' ago ('+esc(date(o?.queueHealth?.oldestRunningAt))+')</p><p class="muted">Read-only health snapshot. This view does not retry, cancel or modify jobs.</p></article>'+
 '<article class="panel"><div class="eyebrow">AI USAGE · LAST 30 DAYS</div><h2>'+Number(o?.usage30d.operations||0).toLocaleString()+' operations</h2><div class="admin-ops-cost">'+money(o?.usage30d.estimatedCostMicros||0)+'</div><p class="muted">Estimated provider cost from recorded usage events; not an invoice or settled charge.</p></article></section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">MODEL CONNECTIVITY</div><h2>AI provider readiness</h2></div><span class="muted">Status only · credentials remain server-side</span></div>'+
 (renderGenerationReadiness())+
 '<div class="admin-ops-status-grid">'+[["Ready",state.providerSummary.ready],["Remote opt-in",state.providerSummary.remoteOptInRequired],["Needs configuration",state.providerSummary.needsConfiguration],["Unverified",state.providerSummary.unverified],["Disabled",state.providerSummary.disabled],["Unavailable",state.providerSummary.unavailable],["Models",state.providerSummary.models],["Quality verified",state.providerSummary.qualityVerifiedModels]].map(([label,value])=>'<div><span>'+label+'</span><b>'+Number(value).toLocaleString()+'</b></div>').join("")+'</div>'+
 (state.providers.length?'<div class="admin-ops-provider-grid">'+state.providers.map(p=>'<article class="admin-ops-provider"><div><b>'+esc(p.provider||p.id)+'</b><span class="readiness-pill '+statusClass(p.status)+'">'+esc(p.status.replaceAll("_"," "))+'</span></div><small>'+esc(p.model||"No model selected")+'</small><p>'+esc(p.reason||"No additional status details.")+'</p><div class="admin-ops-tags"><span>'+ (p.enabled?"Enabled":"Disabled")+'</span><span>'+ (p.configured?"Configured":"Not configured")+'</span><span>'+ (p.remote?"Remote":"Local / unknown")+'</span></div>'+(p.capabilities?.length?'<div class="admin-ops-tags">'+p.capabilities.map(cap=>'<span>'+esc(cap)+'</span>').join("")+'</div>':'')+(p.availableModels?.length?'<div class="admin-ops-models"><small>Supported models</small>'+p.availableModels.map(model=>'<div><b>'+esc(model.label||model.id)+'</b><span>'+esc(model.readiness|| (model.qualityVerified?"Quality verified":model.executionVerified?"Execution verified":"Adapter supported"))+'</span>'+(model.resolutions?.length?'<small>Resolutions: '+esc(model.resolutions.join(" · "))+'</small>':'')+(model.aspectRatios?.length?'<small>Aspect ratios: '+esc(model.aspectRatios.join(" · "))+'</small>':'')+(model.inputModes?.length?'<small>Inputs: '+esc(model.inputModes.join(" · "))+'</small>':'')+(model.minDurationSeconds!==undefined||model.maxDurationSeconds!==undefined?'<small>Duration: '+esc(String(model.minDurationSeconds??"—"))+'–'+esc(String(model.maxDurationSeconds??"—"))+' sec</small>':'')+(model.reason?'<small>'+esc(model.reason)+'</small>':'')+'</div>').join("")+'</div>':'')+(p.modelCapabilities?'<small>Video profile: '+esc((p.modelCapabilities.resolutions||[]).join(" / ")||"Provider defaults")+' · '+esc((p.modelCapabilities.aspectRatios||[]).join(" / ")||"Provider aspect ratios")+'</small>':'')+(p.pricing?'<div class="admin-ops-pricing"><b>Pricing catalogue metadata</b><small>'+(p.pricing.configured?"Configured":"Not configured")+' · '+p.pricing.models.length+' model entries · '+p.pricing.rejectedCount+' rejected</small><small>Source and freshness metadata only; this screen does not display a price quote or guarantee provider billing rates.</small>'+(p.pricing.models.length?'<div class="admin-ops-pricing-list">'+p.pricing.models.map(item=>'<div><b>'+esc(item.provider+" · "+item.model)+'</b><span>'+esc(item.currency||"Currency not supplied")+' · '+esc(pricingFreshness(item.expiresAt,item.observedAt))+'</span><small>Observed: '+esc(date(item.observedAt))+' · Expires: '+esc(date(item.expiresAt))+'</small></div>').join("")+'</div>':'<small>No validated model pricing metadata is available.</small>')+'</div>':'')+'</article>').join("")+'</div>':'<div class="empty">No provider status has been returned.</div>')+'</section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">ACCOUNT DIRECTORY</div><h2>Recent application users</h2></div><span class="muted">'+state.users.length+' matching accounts</span></div>'+
 '<form class="admin-ops-user-search" data-admin-user-search><label for="admin-user-query">Find an account by email or ID</label><div><input id="admin-user-query" name="q" type="search" maxlength="120" value="'+esc(state.userQuery)+'" placeholder="Search email address or account ID" '+(state.loading?'disabled':'')+'><button class="secondary" type="submit" '+(state.loading?'disabled':'')+'>Search accounts</button><button class="secondary" type="button" data-admin-user-clear '+(!state.userQuery||state.loading?'disabled':'')+'>Clear search</button></div></form>' +
 (state.users.length?'<div class="admin-ops-table-wrap"><table class="admin-ops-table"><thead><tr><th>Account</th><th>Auth</th><th>Projects</th><th>Jobs</th><th>Usage · 30d</th><th>Created</th></tr></thead><tbody>'+state.users.map(u=>'<tr><td><b>'+esc(u.email)+'</b><small>'+esc(u.id)+'</small></td><td>'+esc(u.authSource)+'</td><td>'+u.projects+'</td><td>'+u.jobs+'</td><td>'+u.usage30d+'</td><td>'+esc(date(u.createdAt))+'</td></tr>').join("")+'</tbody></table></div>':state.userQuery?'<div class="empty">No accounts matched “'+esc(state.userQuery)+'”. Clear the search to view recent accounts.</div>':'<div class="empty">No application users found.</div>')+'</section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">SUBSCRIPTION & BILLING OPERATIONS</div><h2>Billing readiness and recovery</h2></div><button class="secondary" data-tab="billing">Open customer billing</button></div>'+
 (state.billingOps.access==="ready"?'<div class="admin-ops-grid"><article class="admin-ops-provider"><b>Payment provider readiness</b><span class="readiness-pill '+(state.billingOps.provider?.liveRecurringChargesEnabled?"warn":"neutral")+'">'+(state.billingOps.provider?.liveRecurringChargesEnabled?"Recurring enabled":"Recurring charges disabled")+'</span><p>'+esc(state.billingOps.provider?.reason||state.billingOps.provider?.migrationRequired||"Provider readiness loaded.")+'</p><small>API versions: '+esc(state.billingOps.provider?.currentIntegrationApiVersion||"—")+' · plan API '+esc(state.billingOps.provider?.recurringPaymentPlansApiVersion||"—")+'</small></article><article class="admin-ops-provider"><b>Subscription reconciliation</b><strong>'+Number(state.billingOps.reconciliation?.events?.length||0).toLocaleString()+' events awaiting review</strong><p>Automated entitlement changes: '+(state.billingOps.reconciliation?.automatedEntitlementChanges?"enabled":"disabled")+'</p></article><article class="admin-ops-provider"><b>Payment recovery</b><strong>'+Number(state.billingOps.recovery?.summary?.openAttempts||0).toLocaleString()+' open attempts</strong><p>'+Number(state.billingOps.recovery?.summary?.scheduledRetries||0)+' scheduled retries · '+Number(state.billingOps.recovery?.summary?.exhausted||0)+' exhausted</p><small>'+esc(state.billingOps.recovery?.note||"Customer retry remains explicit; automatic charges are disabled.")+'</small></article></div>'+
 (state.billingOps.actionMessage?'<div class="notice">'+esc(state.billingOps.actionMessage)+'</div>':'')+
 (state.billingOps.reconciliation?.events?.length?'<div class="admin-ops-grid">'+state.billingOps.reconciliation.events.map((event:any)=>'<article class="admin-ops-provider"><b>'+esc(event.eventType||"subscription.cancelled")+'</b><small>'+esc(event.customerEmail||"Customer email unavailable")+' · provider plan '+esc(event.providerPlanId??"missing")+' · status '+esc(event.providerStatus||"unknown")+'</small><small>Event '+esc(event.id)+' · received '+esc(date(event.receivedAt))+'</small><form data-admin-subscription-reconcile><input type="hidden" name="eventId" value="'+esc(event.id)+'"><label>Exact local subscription ID<input name="subscriptionId" required minlength="36" maxlength="36" placeholder="UUID from the customer subscription record"></label><label>Review reason<textarea name="reason" required minlength="3" maxlength="500" rows="2" placeholder="Explain how the provider plan and customer identity were matched"></textarea></label><button type="submit" class="secondary">Verify match and reconcile cancellation</button></form><small>Requires a configured provider plan ID, exact customer email match and exactly one current subscription. Ambiguous events remain in review.</small></article>').join("")+'</div>':'<div class="empty">No subscription cancellation events are awaiting review.</div>'):'<div class="notice warning">'+esc(state.billingOps.message||"Billing admin endpoints are unavailable.")+' Billing mutations remain in the protected Financial Command Centre and require the separate Supabase platform_admins role.</div>')+
 '</section>'+

 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">EXECUTION MONITOR</div><h2>Recent processing jobs</h2></div><span class="muted">'+state.jobs.length+' shown</span></div>'+
 (state.jobs.length?'<div class="admin-ops-table-wrap"><table class="admin-ops-table"><thead><tr><th>Job</th><th>Account</th><th>Type</th><th>Status</th><th>Progress</th><th>Attempts</th><th>Created</th></tr></thead><tbody>'+state.jobs.map(j=>'<tr><td><code>'+esc(j.id.slice(0,12))+'</code></td><td>'+esc(j.email)+'</td><td>'+esc(j.jobType)+'</td><td><span class="readiness-pill '+statusClass(j.status)+'">'+esc(j.status)+'</span>'+(j.status==="running"?'<small class="readiness-pill '+(j.leaseState==="active"?"good":"warn")+'">Lease: '+esc(j.leaseState||"unknown")+'</small>'+(j.leaseExpiresAt?'<small class="muted">Expires '+esc(date(j.leaseExpiresAt))+'</small>':''):'')+'</td><td>'+Math.max(0,Math.min(100,Number(j.progress)||0))+'%</td><td>'+j.attempts+'</td><td>'+esc(date(j.createdAt))+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty">No processing jobs found.</div>')+'</section>'+
 '<section class="panel"><div class="admin-ops-section"><div><div class="eyebrow">GOVERNANCE</div><h2>Recent audit activity</h2></div><span class="muted">'+state.audit.length+' shown</span></div>'+
 (state.audit.length?'<div class="admin-ops-audit">'+state.audit.map(e=>'<article><b>'+esc(e.eventType.replaceAll("_"," "))+'</b><small>'+esc(e.email)+' · '+esc(e.subjectType)+' '+esc(e.subjectId)+'</small><time>'+esc(date(e.createdAt))+'</time></article>').join("")+'</div>':'<div class="empty">No audit activity recorded.</div>')+'</section>'+
 '<footer class="admin-ops-footer">Last fully successful refresh: '+esc(state.updatedAt||"Not yet")+'. Runtime: '+esc(o?.runtime.authMode||"unknown")+'. Storage: '+esc(o?.runtime.dataPersistence||"unknown")+'. '+(o?.runtime.persistentDataRequired?"Persistent storage is required by configuration.":"Persistent storage is not enforced by configuration.")+'</footer>'+
 '<div class="admin-ops-links"><button class="secondary" data-tab="finance">Open financial command centre</button><button class="secondary" data-tab="readiness">Open release readiness</button><button class="secondary" data-tab="engines">Open creative engines</button></div>';
}
export async function loadAdminOperationsWorkspace(){
 const requestId=++refreshSequence;
 state.loading=true;state.error="";paint();
 try{
  const coreResults=await Promise.allSettled([
   apiRequest<{overview:Overview}>("/api/admin/operations/overview"),
   apiRequest<{users:UserRow[]}>("/api/admin/operations/users?limit=100&q="+encodeURIComponent(state.userQuery)),
   apiRequest<{jobs:JobRow[]}>("/api/admin/operations/jobs?limit=100"),
   apiRequest<{providers:ProviderRow[];summary:ProviderSummary;generationReadiness:GenerationReadiness}>("/api/admin/operations/providers"),
   apiRequest<{events:AuditRow[]}>("/api/admin/operations/audit?limit=100")
  ]);
  const [overviewResult,usersResult,jobsResult,providersResult,auditResult]=coreResults;
  if(requestId!==refreshSequence)return;
  const unavailable:string[]=[];
  if(overviewResult.status==="fulfilled")state.overview=overviewResult.value.overview;else unavailable.push("overview");
  if(usersResult.status==="fulfilled")state.users=usersResult.value.users;else unavailable.push("account directory");
  if(jobsResult.status==="fulfilled")state.jobs=jobsResult.value.jobs;else unavailable.push("job monitor");
  if(providersResult.status==="fulfilled"){state.providers=providersResult.value.providers;state.providerSummary=providersResult.value.summary;state.generationReadiness=providersResult.value.generationReadiness;}else unavailable.push("provider readiness");
  if(auditResult.status==="fulfilled")state.audit=auditResult.value.events;else unavailable.push("audit activity");
  const billingResults=await Promise.allSettled([
   apiRequest<any>("/api/admin/billing/provider-readiness"),
   apiRequest<any>("/api/admin/subscriptions/reconciliation?limit=50"),
   apiRequest<any>("/api/admin/billing/recovery?limit=50")
  ]);
  const [providerBilling,subscriptionReconciliation,billingRecovery]=billingResults;
  if(requestId!==refreshSequence)return;
  const billingUnavailable:string[]=[];
  if(providerBilling.status==="fulfilled")state.billingOps.provider=providerBilling.value;else billingUnavailable.push("provider readiness");
  if(subscriptionReconciliation.status==="fulfilled")state.billingOps.reconciliation=subscriptionReconciliation.value;else billingUnavailable.push("subscription reconciliation");
  if(billingRecovery.status==="fulfilled")state.billingOps.recovery=billingRecovery.value;else billingUnavailable.push("billing recovery");
  const billingAvailable=[state.billingOps.provider,state.billingOps.reconciliation,state.billingOps.recovery].filter(value=>value!==null).length;
  state.billingOps.access=billingAvailable===3&&billingUnavailable.length===0?"ready":billingAvailable>0?"partial":"restricted";
  state.billingOps.message=billingUnavailable.length
   ?"Billing refresh incomplete: "+billingUnavailable.join(", ")+" unavailable. Previously loaded results are retained."
   :billingAvailable===0
    ?"Billing endpoints are disabled or this account lacks the separate Supabase platform_admins billing role."
    :"";
  if(unavailable.length===0&&billingUnavailable.length===0)state.updatedAt=new Date().toISOString();
  const refreshUnavailable=[...unavailable,...billingUnavailable.map(value=>"billing "+value)];
  state.error=refreshUnavailable.length
   ?"Partial refresh: "+refreshUnavailable.join(", ")+" unavailable. Other sections remain available; previously loaded values are retained where a refresh failed."
   :"";
 }catch(error){if(requestId===refreshSequence)state.error=error instanceof Error?error.message:"Administrator data could not be loaded. Check the administrator allowlist and sign-in.";}
 finally{if(requestId===refreshSequence){state.loading=false;paint();}}
}
function paint(){const view=document.querySelector<HTMLElement>("#view");if(view?.dataset.adminOperations==="true")view.innerHTML=renderAdminOperationsWorkspace();}
export function initAdminOperationsWorkspace(){
 document.addEventListener("click",event=>{const target=event.target as HTMLElement;if(target.closest("[data-admin-ops-refresh]"))void loadAdminOperationsWorkspace();if(target.closest("[data-admin-user-clear]")){state.userQuery="";void loadAdminOperationsWorkspace();}});
 document.addEventListener("submit",event=>{
  const target=event.target as HTMLElement;
  const reconcileForm=target.closest<HTMLFormElement>("[data-admin-subscription-reconcile]");
  if(reconcileForm){
   event.preventDefault();
   const values=new FormData(reconcileForm);
   const submitButton=reconcileForm.querySelector<HTMLButtonElement>('button[type="submit"]');
   if(submitButton)submitButton.disabled=true;
   state.billingOps.actionMessage="Checking the signed provider event against the selected subscription…";
   paint();
   void apiRequest<{reconciliation:{resolved:boolean}}>(
    "/api/admin/subscriptions/reconciliation/resolve",
    {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
     eventId:String(values.get("eventId")||""),
     subscriptionId:String(values.get("subscriptionId")||"").trim(),
     reason:String(values.get("reason")||"").trim()
    })}
   ).then(result=>{
    state.billingOps.actionMessage=result.reconciliation?.resolved
     ?"Subscription cancellation reconciled and audit history recorded."
     :"The event remains in review; no subscription access was changed.";
    return loadAdminOperationsWorkspace();
   }).catch(error=>{
    state.billingOps.actionMessage=error instanceof Error?error.message:"Subscription reconciliation could not be completed.";
    if(submitButton)submitButton.disabled=false;
    paint();
   });
   return;
  }
  const form=target.closest<HTMLFormElement>("[data-admin-user-search]");
  if(!form)return;
  event.preventDefault();
  const input=form.elements.namedItem("q");
  state.userQuery=input instanceof HTMLInputElement?input.value.trim().slice(0,120):"";
  void loadAdminOperationsWorkspace();
 });
 void apiRequest<{capabilities:{admin:boolean}}>("/api/me").then(result=>{
  state.allowed=result.capabilities?.admin===true;
  state.error=state.allowed?"Administrator access verified.":"This account is not on the platform administrator allowlist.";
  window.dispatchEvent(new CustomEvent("ev:admin-operations-capability"));
 }).catch(()=>{state.allowed=false;state.error="Sign in with an allowlisted administrator account to access this workspace.";window.dispatchEvent(new CustomEvent("ev:admin-operations-capability"));});
}
