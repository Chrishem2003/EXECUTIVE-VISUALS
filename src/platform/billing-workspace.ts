import { apiRequest } from "../core/api";

type Plan={id:string;code:string;name:string;description:string;amountMinor:number|null;currency:string;interval:string;creditsPerPeriod:number;limits:Record<string,unknown>;features:string[];active?:boolean};
type Ledger={id:string;amount:number;type:string;description:string;createdAt:string;expiresAt?:string|null};
type Overview={accountStatus:string;balance:number;plan:Plan|null;subscription:{id:string;status:string;provider:string;currentPeriodStart:string;currentPeriodEnd:string;cancelAtPeriodEnd:boolean}|null;usage30d:{operations:number;estimatedCostMicros:number};ledger:Ledger[]};
const state:{overview:Overview|null;plans:Plan[];message:string;loading:boolean}={overview:null,plans:[],message:"Loading billing information…",loading:false};
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const date=(v:string)=>new Date(v).toLocaleDateString();
const money=(minor:number|null,currency:string)=>minor===null?"Not priced":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(minor/100);
function planCard(plan:Plan,current:boolean){return '<article class="billing-plan '+(current?"is-current":"")+'"><div class="eyebrow">'+esc(plan.code.toUpperCase())+'</div><h3>'+esc(plan.name)+'</h3><div class="billing-price">'+money(plan.amountMinor,plan.currency)+' <small>/ '+esc(plan.interval)+'</small></div><p>'+esc(plan.description)+'</p><div class="billing-credit">'+Number(plan.creditsPerPeriod).toLocaleString()+' credits per period</div><ul>'+plan.features.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>'+(current?'<span class="billing-current">Current plan</span>':'<button class="secondary" disabled title="Checkout is not connected yet">Checkout not enabled</button>')+'</article>';}
export function renderBillingWorkspace(){
 const b=state.overview;
 if(!b)return '<div class="page-head"><div><div class="eyebrow">ACCOUNT & USAGE</div><h1>Plan & billing</h1><p>Subscription status, included credits and usage records.</p></div><button class="secondary" data-billing-refresh>Refresh</button></div><div class="notice">'+esc(state.message)+'</div>';
 return '<div class="page-head"><div><div class="eyebrow">ACCOUNT & USAGE</div><h1>Plan & billing</h1><p>Know your allowance and generation usage before spending. Paid checkout remains disabled until a payment provider is verified.</p></div><button class="secondary" data-billing-refresh>Refresh</button></div>'+
 '<div class="runtime-summary"><div><small>Available credits</small><b>'+b.balance.toLocaleString()+'</b></div><div><small>Current plan</small><b>'+esc(b.plan?.name||"None")+'</b></div><div><small>Operations · 30 days</small><b>'+b.usage30d.operations.toLocaleString()+'</b></div><div><small>Account status</small><b>'+esc(b.accountStatus)+'</b></div></div>'+
 (b.subscription?'<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">CURRENT SUBSCRIPTION</div><h2>'+esc(b.plan?.name||"Subscription")+'</h2></div><span class="status">'+esc(b.subscription.status.toUpperCase())+'</span></div><p>Provider: '+esc(b.subscription.provider)+' · Current period: '+date(b.subscription.currentPeriodStart)+' – '+date(b.subscription.currentPeriodEnd)+'</p><p>Credits expire according to their ledger expiry dates. Cancel at period end: '+(b.subscription.cancelAtPeriodEnd?"Yes":"No")+'</p></section>':'<div class="notice">No active paid subscription. Your account is using the Free plan.</div>')+
 '<div class="section-title"><div class="eyebrow">AVAILABLE PLANS</div><h2>Choose the right production capacity</h2></div><p class="muted">Prices and entitlements are managed by the platform administrator. A plan being displayed does not mean payment collection is active.</p><div class="billing-plan-grid">'+state.plans.map(p=>planCard(p,p.id===b.plan?.id)).join("")+'</div>'+
 '<div class="section-title"><div class="eyebrow">CREDIT ACTIVITY</div><h2>Recent credit ledger</h2></div><section class="panel">'+(b.ledger.length?'<div class="billing-ledger">'+b.ledger.map(x=>'<div class="billing-ledger-row"><div><b>'+esc(x.description||x.type)+'</b><small>'+esc(x.type.replaceAll("_"," "))+' · '+date(x.createdAt)+(x.expiresAt?" · expires "+date(x.expiresAt):"")+'</small></div><strong class="'+(x.amount>0?"credit-positive":"credit-negative")+'">'+(x.amount>0?"+":"")+x.amount.toLocaleString()+'</strong></div>').join("")+'</div>':'<div class="empty">No credit transactions yet.</div>')+'</section>'+
 '<div class="notice">Payment processing is not active. You cannot purchase or renew a subscription from this screen yet, and no payment details are collected.</div>';
}
let initialized=false;
export async function refreshBillingWorkspace(){
 state.loading=true;
 try{
  const [overview,plans]=await Promise.all([
   apiRequest<{billing:Overview}>("/api/billing/overview"),
   apiRequest<{plans:Plan[]}>("/api/billing/plans")
  ]);
  state.overview=overview.billing;state.plans=plans.plans;state.message="";
 }catch(error){state.message=error instanceof Error?error.message:"Billing information could not be loaded.";}
 finally{state.loading=false;paint();}
}
function paint(){const view=document.querySelector<HTMLElement>("#view");if(view?.dataset.billingView==="true")view.innerHTML=renderBillingWorkspace();}
export function initBillingWorkspace(){
 if(!initialized){initialized=true;document.addEventListener("click",event=>{if((event.target as HTMLElement).closest("[data-billing-refresh]"))void refreshBillingWorkspace();});}
 void refreshBillingWorkspace();
}
export function billingWorkspaceEnabled(){return true;}
