import { apiRequest, ApiError } from "../core/api";

type SecurityEvent={id:number;identifierHash:string;eventType:string;failedAttempts:number;lockLevel:number;lockedUntilMs:number|null;createdAtMs:number};
type EventPage={events:SecurityEvent[];nextBeforeId:number|null;retentionDays:number};
type SecuritySummary={window:string;totals:{totalEvents:number;failedSignIns:number;newLockouts:number;blockedByLockout:number;successfulSignIns:number};suspiciousIdentifiers:{identifierHash:string;attempts15m:number;lockoutEvents24h:number;lastEventAtMs:number}[];detectionPolicy:{attemptThreshold:number;attemptWindowMinutes:number;lockoutThreshold:number;lockoutWindowHours:number};generatedAtMs:number};
let events:SecurityEvent[]=[];
let summary:SecuritySummary|null=null;
let summaryMessage="Security monitoring summary is loading…";
let cursor:number|null=null;
let loading=false;
let message="";
let filter="all";
let initialized=false;
let unlockMessage="";
type Overview={lockedAccounts:number;recentAdminActions:{id:number;action:string;detail:string|null;createdAtMs:number}[]};
let overview:Overview|null=null;
const escapeHtml=(value:unknown)=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]||char));
const label=(value:string)=>value.replaceAll("_"," ").replace(/\b\w/g,char=>char.toUpperCase());
function date(value:number){const parsed=new Date(value);return Number.isNaN(parsed.getTime())?"Unknown":parsed.toLocaleString();}
function eventMarkup(event:SecurityEvent){
 const locked=event.eventType==="account_locked"||event.eventType==="login_blocked_by_lockout";
 return '<article class="security-event"><div class="security-event-main"><span class="security-event-type">'+escapeHtml(label(event.eventType))+'</span><code>'+escapeHtml(event.identifierHash.slice(0,18))+'…</code><small>'+escapeHtml(date(event.createdAtMs))+'</small></div><div class="security-event-meta"><span>Failures <b>'+event.failedAttempts+'</b></span><span>Lock level <b>'+event.lockLevel+'</b></span><span>Lock expiry <b>'+escapeHtml(event.lockedUntilMs?date(event.lockedUntilMs):"—")+'</b></span></div><span class="security-event-status '+(locked?"is-warning":"")+'">'+(locked?"Lockout-related":"Recorded")+'</span></article>';
}
function summaryMarkup(){
 if(!summary)return '<p class="security-message">'+escapeHtml(summaryMessage)+'</p>';
 const t=summary.totals;
 const metrics=[["Events · 24h",t.totalEvents],["Failed sign-ins",t.failedSignIns],["New lockouts",t.newLockouts],["Blocked by lockout",t.blockedByLockout],["Successful sign-ins",t.successfulSignIns]];
 const cards=metrics.map(([label,value])=>'<article><small>'+label+'</small><b>'+value+'</b></article>').join("");
 const alerts=summary.suspiciousIdentifiers.length?summary.suspiciousIdentifiers.map(item=>'<article><code>'+escapeHtml(item.identifierHash.slice(0,18))+'…</code><span>'+item.attempts15m+' attempts / 15 min</span><span>'+item.lockoutEvents24h+' lockout events / 24 h</span><small>Last event '+escapeHtml(date(item.lastEventAtMs))+'</small></article>').join(""):'<p class="security-message">No identifiers crossed the current detection thresholds in the rolling 24-hour window.</p>';
 return '<section class="security-metrics">'+cards+'</section><section class="panel security-alerts"><div><h2>Suspicious activity</h2><p>Rule-based indicators, not proof of account compromise.</p></div>'+alerts+'</section>';
}
async function loadSummary(){
 try{summary=await apiRequest<SecuritySummary>("/api/admin/security-summary");summaryMessage="Security summary loaded.";}
 catch(error){summary=null;summaryMessage=error instanceof ApiError&&error.status===403?"Security summary access denied.":error instanceof ApiError&&error.status===401?"Session expired. Sign in again.":"Security summary could not be loaded.";}
 const host=document.querySelector<HTMLElement>("#security-summary");if(host)host.innerHTML=summaryMarkup();
}
function unlockMarkup(){
 const actions=overview?.recentAdminActions.length?overview.recentAdminActions.map(item=>'<li>'+escapeHtml(label(item.action))+' · '+escapeHtml(label(item.detail||"done"))+' · '+escapeHtml(date(item.createdAtMs))+'</li>').join(""):'<li>No admin actions yet.</li>';
 return '<section class="panel security-unlock"><div><h2>Unlock an account</h2><p>If someone is locked out after too many wrong passwords, enter their email to clear the lock. Every unlock is logged (without the email).</p></div><form id="admin-unlock-form"><input id="admin-unlock-email" type="email" placeholder="person@example.com" autocomplete="off" required><button class="primary" type="submit">Unlock account</button></form><p id="admin-unlock-message" class="security-message" role="status">'+escapeHtml(unlockMessage||(overview?String(overview.lockedAccounts)+" account(s) locked right now.":""))+'</p><div><h2>Add credits</h2><p>Give someone extra credits by their sign-in email. They must have opened the app at least once. Only works when credits are switched on (CREDITS_ENABLED=true).</p></div><form id="admin-credit-form"><input id="admin-credit-email" type="email" placeholder="person@example.com" autocomplete="off" required><input id="admin-credit-amount" type="number" min="1" max="100000" step="1" value="50" required aria-label="Credits to add"><button class="primary" type="submit">Add credits</button></form><p id="admin-credit-message" class="security-message" role="status"></p><details><summary>Recent admin actions</summary><ul>'+actions+'</ul></details></section>';
}
async function loadOverview(){
 try{overview=await apiRequest<Overview>("/api/admin/overview");}catch{overview=null;}
 const host=document.querySelector<HTMLElement>("#security-unlock-host");if(host){host.innerHTML=unlockMarkup();bindUnlock();}
}
function bindCredits(){
 const form=document.querySelector<HTMLFormElement>("#admin-credit-form");
 if(!form||form.dataset.bound)return;form.dataset.bound="true";
 form.addEventListener("submit",async event=>{
  event.preventDefault();
  const email=(document.querySelector<HTMLInputElement>("#admin-credit-email")?.value||"").trim();
  const amount=Number(document.querySelector<HTMLInputElement>("#admin-credit-amount")?.value);
  let text="";
  try{
   const result=await apiRequest<{granted:number}>("/api/admin/credits/grant",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,amount})});
   text="Added "+result.granted+" credits.";
  }catch(error){text=error instanceof Error?error.message:"Could not add credits.";}
  const node=document.querySelector<HTMLElement>("#admin-credit-message");if(node)node.textContent=text;
  window.dispatchEvent(new Event("ev:credits-changed"));
 });
}
function bindUnlock(){
 bindCredits();
 const form=document.querySelector<HTMLFormElement>("#admin-unlock-form");
 if(!form||form.dataset.bound)return;form.dataset.bound="true";
 form.addEventListener("submit",async event=>{
  event.preventDefault();
  const input=document.querySelector<HTMLInputElement>("#admin-unlock-email");const email=(input?.value||"").trim();if(!email)return;
  try{
   const result=await apiRequest<{wasLocked:boolean;cleared:boolean}>("/api/admin/unlock",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})});
   unlockMessage=result.wasLocked?"Unlocked. They can sign in again now.":result.cleared?"Cleared their failed attempts. They were not locked.":"Nothing to clear for that email.";
   if(input)input.value="";
  }catch(error){unlockMessage=error instanceof ApiError&&error.status===403?"Only administrators can unlock accounts.":error instanceof Error?error.message:"Could not unlock.";}
  await loadOverview();
  const node=document.querySelector<HTMLElement>("#admin-unlock-message");if(node)node.textContent=unlockMessage;
 });
}
export function renderSecurityWorkspace(){
 return '<div class="page-head"><div><div class="eyebrow">TRUST & ACCESS · ADMIN ONLY</div><h1>Security operations</h1><p>Review privacy-preserving authentication events and account lockout activity. Raw emails, passwords, tokens and IP addresses are never displayed.</p></div><button class="secondary" id="security-refresh">↻ Refresh events</button></div><div id="security-unlock-host">'+unlockMarkup()+'</div><div id="security-summary">'+summaryMarkup()+'</div><section class="panel security-panel"><div class="security-toolbar"><label>Event type<select id="security-event-filter"><option value="all">All events</option><option value="login_failed">Failed sign-in</option><option value="account_locked">Account locked</option><option value="login_blocked_by_lockout">Blocked by lockout</option><option value="login_succeeded">Successful sign-in</option></select></label><span id="security-event-count">Events are retained for up to 90 days.</span></div><p id="security-message" class="security-message" role="status">'+escapeHtml(message||"Loading security events…")+'</p><div id="security-events" class="security-events">'+(events.length?events.map(eventMarkup).join(""):'<div class="empty">No events loaded.</div>')+'</div><div class="security-footer"><small>Identifiers are pseudonymous digests. Access is enforced by the server-side ADMIN_EMAILS allowlist.</small><button class="secondary" id="security-load-more" '+(!cursor||loading?"disabled":"")+'>Load older events</button></div></section>';
}
async function loadEvents(append=false){
 if(loading)return;
 loading=true;message="Loading security events…";paintMessage();
 const params=new URLSearchParams({limit:"50"});
 if(filter!=="all")params.set("eventType",filter);
 if(append&&cursor)params.set("beforeId",String(cursor));
 try{
  const page=await apiRequest<EventPage>("/api/admin/security-events?"+params.toString());
  events=append?[...events,...page.events]:page.events;
  cursor=page.nextBeforeId;
  message=events.length?String(events.length)+" events loaded · retention "+page.retentionDays+" days.":"No matching authentication events.";
  initialized=true;paint();
 }catch(error){
  events=[];cursor=null;
  if(error instanceof ApiError&&error.status===403)message="Access denied. This workspace is available only to administrators. The site owner adds your sign-in email to ADMIN_EMAILS in the hosting settings.";
  else if(error instanceof ApiError&&error.status===401)message="Your session has expired. Sign in again to continue.";
  else message=error instanceof Error?error.message:"Security events could not be loaded.";
  paint();
 }finally{loading=false;}
}
function paintMessage(){const node=document.querySelector<HTMLElement>("#security-message");if(node)node.textContent=message;}
function paint(){
 const list=document.querySelector<HTMLElement>("#security-events");
 if(list)list.innerHTML=events.length?events.map(eventMarkup).join(""):'<div class="empty">'+escapeHtml(message)+'</div>';
 const status=document.querySelector<HTMLElement>("#security-message");if(status)status.textContent=message;
 const count=document.querySelector<HTMLElement>("#security-event-count");if(count)count.textContent=events.length+" events loaded";
 const more=document.querySelector<HTMLButtonElement>("#security-load-more");if(more)more.disabled=!cursor||loading;
}
export function initSecurityWorkspace(){
 const filterNode=document.querySelector<HTMLSelectElement>("#security-event-filter");
 if(filterNode&&!filterNode.dataset.bound){filterNode.dataset.bound="true";filterNode.addEventListener("change",()=>{filter=filterNode.value;events=[];cursor=null;void loadEvents();void loadSummary();});}
 const refresh=document.querySelector<HTMLButtonElement>("#security-refresh");
 if(refresh&&!refresh.dataset.bound){refresh.dataset.bound="true";refresh.addEventListener("click",()=>{events=[];cursor=null;void loadEvents();});}
 const more=document.querySelector<HTMLButtonElement>("#security-load-more");
 if(more&&!more.dataset.bound){more.dataset.bound="true";more.addEventListener("click",()=>void loadEvents(true));}
 if(!initialized)void loadEvents();
 else paint();
 void loadSummary();
 void loadOverview();
}
