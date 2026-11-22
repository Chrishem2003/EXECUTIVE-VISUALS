const PLAN_CODE=/^[a-z][a-z0-9_-]{1,63}$/;
const PROVIDERS=new Set(["paddle","pesapal"]);
const MAX_PLANS=1000,MAX_PRICES=5000,MAX_JSON_BYTES=16*1024;
const fail=(code,message)=>Object.assign(new Error(message),{code,status:422});
const text=value=>typeof value==="string"?value.trim():"";
function record(value){return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function integer(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={}){
 if(!Number.isSafeInteger(value)||value<min||value>max)throw fail("SUBSCRIPTION_CATALOGUE_INVALID",label+" must be a bounded integer.");
 return value;
}
function jsonSnapshot(value,label){
 if(!record(value))throw fail("SUBSCRIPTION_CATALOGUE_INVALID",label+" must be a JSON object.");
 let encoded;
 try{encoded=JSON.stringify(value);}catch{throw fail("SUBSCRIPTION_CATALOGUE_INVALID",label+" is not serializable.");}
 if(Buffer.byteLength(encoded,"utf8")>MAX_JSON_BYTES)throw fail("SUBSCRIPTION_CATALOGUE_INVALID",label+" exceeds the size limit.");
 const copy=JSON.parse(encoded);
 const freeze=node=>{
  if(node&&typeof node==="object"&&!Object.isFrozen(node)){for(const child of Object.values(node))freeze(child);Object.freeze(node);}
  return node;
 };
 return freeze(copy);
}
function timestamp(value,label,{optional=false}={}){
 if((value===null||value===undefined||value==="")&&optional)return null;
 const ms=typeof value==="string"||value instanceof Date?Date.parse(value):NaN;
 if(!Number.isFinite(ms))throw fail("SUBSCRIPTION_CATALOGUE_INVALID",label+" must be a valid timestamp.");
 return ms;
}
function normalizePlan(row,nowMs){
 const id=text(row.id);
 const code=text(row.plan_code??row.planCode).toLowerCase();
 const name=text(row.name??row.display_name);
 const description=text(row.description);
 const version=integer(Number(row.version??row.plan_version??row.planVersion),"plan version",{min:1,max:1_000_000});
 const status=text(row.status).toLowerCase();
 const interval=text(row.billing_interval??row.billingInterval).toLowerCase();
 const isPublic=row.is_public??row.isPublic;
 if(!id||id.length>128||!PLAN_CODE.test(code)||!name||name.length>100||description.length>1000||!["none","monthly","yearly"].includes(interval)||typeof isPublic!=="boolean"||!["active","inactive","archived"].includes(status))
  throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Plan identity, visibility, status or billing interval is invalid.");
 const effectiveFrom=timestamp(row.effective_from??row.effectiveFrom,"plan effective_from",{optional:true});
 const effectiveUntil=timestamp(row.effective_until??row.effectiveUntil,"plan effective_until",{optional:true});
 if(effectiveFrom!==null&&effectiveUntil!==null&&effectiveUntil<=effectiveFrom)
  throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Plan effective_until must be later than effective_from.");
 const credits=integer(Number(row.included_credits??row.includedCredits??0),"included credits",{max:1_000_000_000});
 const baseAmountRaw=row.amount_minor??row.amountMinor;
 const baseAmountMinor=baseAmountRaw===undefined||baseAmountRaw===null?null:integer(baseAmountRaw,"base plan amount",{min:interval==="none"?0:1,max:9_000_000_000_000});
 const baseCurrency=text(row.currency).toUpperCase();
 if(baseCurrency&&!/^[A-Z]{3}$/.test(baseCurrency))throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Base plan currency must be an ISO currency code.");
 const entitlements=jsonSnapshot(row.entitlements??row.entitlements_snapshot??row.entitlementsSnapshot,"plan entitlements");
 const eligible=status==="active"&&isPublic&&(effectiveFrom===null||effectiveFrom<=nowMs)&&(effectiveUntil===null||effectiveUntil>nowMs);
 return {id,planCode:code,name,description,version,billingInterval:interval,includedCredits:credits,baseAmountMinor,baseCurrency,
  creditAllowancePublished:row.credit_allowance_published===true&&credits>0,
  entitlements,effectiveFrom,effectiveUntil,eligible};
}
function normalizePrice(row){
 const provider=text(row.provider).toLowerCase(),currency=text(row.currency).toUpperCase();
 const amountMinor=integer(row.amount_minor??row.amountMinor,"provider amount",{min:1,max:9_000_000_000_000});
 const active=row.active===true;
 if(!PROVIDERS.has(provider)||!/^[A-Z]{3}$/.test(currency))throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Provider price currency or provider is invalid.");
 const priceId=text(row.provider_price_id??row.providerPriceId);
 const planId=text(row.plan_id??row.planId);
 if(!planId||planId.length>128)throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Provider price must reference a valid plan ID.");
 if(provider==="paddle"&&(!/^pri_[A-Za-z0-9]+$/.test(priceId)||!["USD","EUR","GBP"].includes(currency)))
  throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Paddle prices require a valid price ID and USD, EUR or GBP currency.");
 if(provider==="pesapal"&&(priceId!==""||currency!=="UGX"))
  throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Pesapal prices require UGX and no provider price ID.");
 return {planId,provider,currency,amountMinor,active,hasProviderPriceId:Boolean(priceId)};
}

/**
 * Builds a read-only customer catalogue from trusted database rows. It does
 * not accept browser prices, credit grants or entitlement claims and never
 * enables checkout by itself.
 */
export function buildPublicSubscriptionCatalogue({plans,providerPrices,now=()=>new Date()}={}){
 if(!Array.isArray(plans)||plans.length>MAX_PLANS||!Array.isArray(providerPrices)||providerPrices.length>MAX_PRICES)
  throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Bounded plan and provider-price arrays are required.");
 const clock=now(),nowMs=clock instanceof Date?clock.getTime():Date.parse(clock);
 if(!Number.isFinite(nowMs))throw fail("SUBSCRIPTION_CATALOGUE_INVALID","Catalogue clock is invalid.");
 const normalizedPlans=plans.map(row=>normalizePlan(row,nowMs));
 const seen=new Set();
 for(const plan of normalizedPlans){
  const key=plan.planCode+":"+plan.version;
  if(seen.has(key))throw fail("SUBSCRIPTION_CATALOGUE_DUPLICATE","A plan version appears more than once.");
  seen.add(key);
 }
 const normalizedPrices=providerPrices.map(normalizePrice);
 const priceKeys=new Set();
 for(const price of normalizedPrices){
  const key=price.planId+":"+price.provider;
  if(priceKeys.has(key))throw fail("SUBSCRIPTION_CATALOGUE_DUPLICATE","A plan has more than one provider price for the same provider.");
  priceKeys.add(key);
 }
 return Object.freeze(normalizedPlans.filter(plan=>plan.eligible).map(plan=>{
  const prices=normalizedPrices.filter(price=>plan.billingInterval!=="none"&&price.planId===plan.id&&price.active)
   .map(price=>Object.freeze({provider:price.provider,currency:price.currency,amountMinor:price.amountMinor}));
  return Object.freeze({
   planCode:plan.planCode,name:plan.name,description:plan.description,version:plan.version,
   billingInterval:plan.billingInterval,
   amount_minor:plan.baseAmountMinor,
   currency:plan.baseCurrency||null,
   includedCredits:plan.creditAllowancePublished?plan.includedCredits:null,
   creditAllowancePublished:plan.creditAllowancePublished,
   entitlements:plan.entitlements,
   prices:Object.freeze(prices),
   checkoutProviders:Object.freeze(prices.map(price=>price.provider))
  });
 }));
}
