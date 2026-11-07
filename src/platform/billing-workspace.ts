import { apiRequest } from "../core/api";

type Plan={id:string;code:string;name:string;description:string;amountMinor:number|null;currency:string;interval:string;creditsPerPeriod:number;limits:Record<string,unknown>;features:string[];active?:boolean;subscriptionCheckoutAvailable?:boolean};
type Ledger={id:string;amount:number;type:string;description:string;createdAt:string;expiresAt?:string|null};
type Overview={accountStatus:string;balance:number;plan:Plan|null;subscription:{id:string;status:string;provider:string;currentPeriodStart:string;currentPeriodEnd:string;cancelAtPeriodEnd:boolean}|null;usage30d:{operations:number;estimatedCostMicros:number};ledger:Ledger[]};
type PaymentOrder={txRef:string;status:string;amountMinor:number;currency:string;credits:number;verifiedAt:string|null;createdAt:string;planName:string;interval:string};
type DodoOrder={orderId:string;status:string;sessionId:string|null;createdAt:string;planName:string;interval:string};
const state:{overview:Overview|null;plans:Plan[];message:string;loading:boolean;paymentOrder:PaymentOrder|null;dodoOrder:DodoOrder|null;checkoutEnabled:boolean;subscriptionCheckoutEnabled:boolean}={overview:null,plans:[],message:"Loading billing information…",loading:false,paymentOrder:null,dodoOrder:null,checkoutEnabled:false,subscriptionCheckoutEnabled:false};
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const date=(v:string)=>new Date(v).toLocaleDateString();
const ZERO_DECIMAL_CURRENCIES=new Set(["UGX","RWF","TZS","JPY","KRW","XAF","XOF","XPF","BIF","DJF","GNF","KMF","PYG","VND","VUV"]);
const THREE_DECIMAL_CURRENCIES=new Set(["BHD","IQD","JOD","KWD","LYD","OMR","TND"]);
const money=(minor:number|null,currency:string)=>minor===null?"Not priced":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(minor/(10**(ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())?0:THREE_DECIMAL_CURRENCIES.has(currency.toUpperCase())?3:2)));
function planCard(plan:Plan,current:boolean,checkoutEnabled:boolean){const canBuy=checkoutEnabled&&plan.interval==="one_time"&&plan.amountMinor!==null&&plan.amountMinor>0;const canSubscribe=plan.subscriptionCheckoutAvailable===true&&["month","year"].includes(plan.interval);const action=current?'<span class="billing-current">Current plan</span>':canBuy?'<button class="primary" data-billing-checkout="'+esc(plan.id)+'">Buy credits securely</button>':canSubscribe?'<button class="primary" data-billing-subscribe="'+esc(plan.id)+'">Subscribe securely</button>':'<button class="secondary" disabled title="'+(plan.interval==="one_time"?"Checkout is not configured yet":"Subscription checkout is awaiting merchant approval and configuration")+'">'+(plan.interval==="one_time"?"Checkout unavailable":"Subscription unavailable")+'</button>';return '<article class="billing-plan '+(current?"is-current":"")+'"><div class="eyebrow">'+esc(plan.code.toUpperCase())+'</div><h3>'+esc(plan.name)+'</h3><div class="billing-price">'+money(plan.amountMinor,plan.currency)+' <small>/ '+esc(plan.interval)+'</small></div><p>'+esc(plan.description)+'</p><div class="billing-credit">'+Number(plan.creditsPerPeriod).toLocaleString()+' credits per period</div><ul>'+plan.features.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul>'+action+'</article>';}
export function renderBillingWorkspace(){
 if(window.location.pathname==="/billing/return"){
  if(new URLSearchParams(window.location.search).get("provider")==="dodo"){
   const order=state.dodoOrder;const status=order?.status||"checking";
   const heading=status==="active"?"Subscription activated":status==="failed"||status==="expired"?"Subscription not activated":state.message?"Subscription status unavailable":"Subscription processing";
   const detail=status==="active"?"Dodo's signed webhook has activated your subscription and the current period's credits have been granted.":status==="failed"||status==="expired"?"The subscription was not activated. No subscription credits were granted.":state.message?"The subscription order could not be verified. Check billing before trying again.":"We are waiting for Dodo's signed subscription webhook. The browser redirect is not proof of activation.";
   return '<div class="page-head"><div><div class="eyebrow">SECURE SUBSCRIPTION RETURN</div><h1>'+heading+'</h1><p>'+detail+'</p></div><button class="secondary" data-billing-refresh>↻ Check status</button></div>'+
    (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+'<section class="panel"><div class="eyebrow">SUBSCRIPTION ORDER</div><h2>'+esc(order?.planName||"Your subscription")+'</h2><div class="runtime-summary"><div><small>Status</small><b>'+esc(status.toUpperCase())+'</b></div><div><small>Billing interval</small><b>'+esc(order?.interval||"—")+'</b></div><div><small>Order reference</small><b>'+esc(order?.orderId||new URLSearchParams(window.location.search).get("order_id")||"—")+'</b></div></div><p class="muted">Access and credits are granted only after the signed Dodo webhook has been verified and processed by the server.</p><a class="primary" href="/">Return to studio</a></section>';
  }
  const order=state.paymentOrder;
  const status=order?.status||"checking";
  const heading=status==="paid"?"Payment confirmed":status==="failed"||status==="expired"?"Payment not completed":state.message?"Payment status unavailable":"Payment processing";
  const detail=status==="paid"?"Your payment has been verified by the server. Your credits are available in your account.":status==="failed"||status==="expired"?"This payment was not completed. No credits were granted.":state.message?"The payment reference could not be verified. Check your billing history before attempting another payment.":"We are waiting for verified confirmation from Flutterwave. Do not pay again while this status is pending.";
  return '<div class="page-head"><div><div class="eyebrow">SECURE PAYMENT RETURN</div><h1>'+heading+'</h1><p>'+detail+'</p></div><button class="secondary" data-billing-refresh>↻ Check status</button></div>'+
   (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+'<section class="panel"><div class="eyebrow">PAYMENT ORDER</div><h2>'+esc(order?.planName||"Your order")+'</h2><div class="runtime-summary"><div><small>Payment status</small><b>'+esc(status.toUpperCase())+'</b></div><div><small>Amount</small><b>'+ (order?money(order.amountMinor,order.currency):"—")+'</b></div><div><small>Credits</small><b>'+ (order?order.credits.toLocaleString():"—")+'</b></div><div><small>Reference</small><b>'+esc(order?.txRef||new URLSearchParams(window.location.search).get("tx_ref")||"—")+'</b></div></div><p class="muted">The browser redirect is not proof of payment. Executive Visuals grants value only after the signed webhook and server-side transaction verification succeed.</p><a class="primary" href="/">Return to studio</a></section>';
 }
 const b=state.overview;
 if(!b)return '<div class="page-head"><div><div class="eyebrow">ACCOUNT & USAGE</div><h1>Plan & billing</h1><p>Subscription status, included credits and usage records.</p></div><button class="secondary" data-billing-refresh>Refresh</button></div><div class="notice">'+esc(state.message)+'</div>';
 return '<div class="page-head"><div><div class="eyebrow">ACCOUNT & USAGE</div><h1>Plan & billing</h1><p>Know your allowance and generation usage before spending. Paid checkout remains disabled until a payment provider is verified.</p></div><button class="secondary" data-billing-refresh>Refresh</button></div>'+
 (state.message?'<div class="notice">'+esc(state.message)+'</div>':'')+
 '<div class="runtime-summary"><div><small>Available credits</small><b>'+b.balance.toLocaleString()+'</b></div><div><small>Current plan</small><b>'+esc(b.plan?.name||"None")+'</b></div><div><small>Operations · 30 days</small><b>'+b.usage30d.operations.toLocaleString()+'</b></div><div><small>Account status</small><b>'+esc(b.accountStatus)+'</b></div></div>'+
 (b.subscription?'<section class="panel"><div class="runtime-section-heading"><div><div class="eyebrow">CURRENT SUBSCRIPTION</div><h2>'+esc(b.plan?.name||"Subscription")+'</h2></div><span class="status">'+esc(b.subscription.status.toUpperCase())+'</span></div><p>Provider: '+esc(b.subscription.provider)+' · Current period: '+date(b.subscription.currentPeriodStart)+' – '+date(b.subscription.currentPeriodEnd)+'</p><p>Credits expire according to their ledger expiry dates. Cancel at period end: '+(b.subscription.cancelAtPeriodEnd?"Yes":"No")+'</p></section>':'<div class="notice">No active paid subscription. Your account is using the Free plan.</div>')+
 '<div class="section-title"><div class="eyebrow">AVAILABLE PLANS</div><h2>Choose the right production capacity</h2></div><p class="muted">Prices and entitlements are managed by the platform administrator. A plan being displayed does not mean payment collection is active.</p><div class="billing-plan-grid">'+state.plans.map(p=>planCard(p,p.id===b.plan?.id,state.checkoutEnabled)).join("")+'</div>'+
 '<div class="section-title"><div class="eyebrow">CREDIT ACTIVITY</div><h2>Recent credit ledger</h2></div><section class="panel">'+(b.ledger.length?'<div class="billing-ledger">'+b.ledger.map(x=>'<div class="billing-ledger-row"><div><b>'+esc(x.description||x.type)+'</b><small>'+esc(x.type.replaceAll("_"," "))+' · '+date(x.createdAt)+(x.expiresAt?" · expires "+date(x.expiresAt):"")+'</small></div><strong class="'+(x.amount>0?"credit-positive":"credit-negative")+'">'+(x.amount>0?"+":"")+x.amount.toLocaleString()+'</strong></div>').join("")+'</div>':'<div class="empty">No credit transactions yet.</div>')+'</section>'+
 '<div class="notice">'+(state.checkoutEnabled?"One-time credit top-ups can be purchased when an eligible credit pack is available. Recurring subscription checkout and renewal are not enabled.":"Payment processing is not active. No payment details are collected.")+'</div>';
}
let initialized=false;
export async function refreshBillingReturn(){
 const txRef=new URLSearchParams(window.location.search).get("tx_ref")||"";
 if(!/^ev_[a-f0-9]{32}$/.test(txRef)){state.paymentOrder=null;state.message="No valid payment reference was supplied.";paint();return;}
 state.loading=true;
 try{const result=await apiRequest<{order:PaymentOrder}>("/api/billing/orders/"+txRef);state.paymentOrder=result.order;state.message="";}
 catch(error){state.paymentOrder=null;state.message=error instanceof Error?error.message:"Payment status could not be checked.";}
 finally{state.loading=false;paint();}
}
export async function refreshBillingWorkspace(){
 state.loading=true;
 try{
  const [overview,plans]=await Promise.all([
   apiRequest<{billing:Overview;payment:{checkoutEnabled:boolean}}>("/api/billing/overview"),
   apiRequest<{plans:Plan[]}>("/api/billing/plans")
  ]);
  state.overview=overview.billing;state.checkoutEnabled=overview.payment?.checkoutEnabled===true;state.plans=plans.plans;state.message="";
 }catch(error){state.message=error instanceof Error?error.message:"Billing information could not be loaded.";}
 finally{state.loading=false;paint();}
}
function paint(){const view=document.querySelector<HTMLElement>("#view");if(view?.dataset.billingView==="true")view.innerHTML=renderBillingWorkspace();}
export function initBillingWorkspace(){
 if(!initialized){initialized=true;document.addEventListener("click",event=>{const target=event.target as HTMLElement;if(target.closest("[data-billing-refresh]")){void(window.location.pathname==="/billing/return"?refreshBillingReturn():refreshBillingWorkspace());return;}const checkout=target.closest<HTMLElement>("[data-billing-checkout]");if(checkout){const planId=checkout.dataset.billingCheckout||"";checkout.setAttribute("disabled","true");state.message="Creating a secure checkout session…";paint();void apiRequest<{checkout:{checkoutUrl:string}}>("/api/billing/checkout",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({planId})}).then(result=>{const url=new URL(result.checkout.checkoutUrl);if(url.protocol!=="https:"||!(url.hostname==="flutterwave.com"||url.hostname.endsWith(".flutterwave.com")))throw new Error("The payment provider returned an untrusted checkout URL.");window.location.assign(url.toString());}).catch(error=>{state.message=error instanceof Error?error.message:"Checkout could not be created.";paint();});}});}
 if(window.location.pathname==="/billing/return")void refreshBillingReturn();else void refreshBillingWorkspace();
}
export function billingWorkspaceEnabled(){return true;}
