const fail=(code,message)=>Object.assign(new Error(message),{code});
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const safeInt=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const bps=(value)=>safeInt(value,0,9500);
const ceilDiv=(a,b)=>{if(b<=0n)throw new Error("Division denominator must be positive.");return (a+b-1n)/b;};

function normalizePolicy(policy){
 if(!policy||typeof policy!=="object"||Array.isArray(policy))return null;
 const required=["currency","creditValueMinor","minorUnitsPerMajor","targetMarginBps","paymentFeeBps","retryReserveBps","infrastructureReserveBps","fixedPaymentFeeMinor","pricingVersion"];
 for(const key of required)if(!own(policy,key))return null;
 if(typeof policy.currency!=="string"||!/^[A-Z]{3}$/.test(policy.currency)||!safeInt(policy.creditValueMinor,1,1000000000)||
    ![1,10,100,1000,10000].includes(policy.minorUnitsPerMajor)||
    !bps(policy.targetMarginBps)||!bps(policy.paymentFeeBps)||
    !bps(policy.retryReserveBps)||!bps(policy.infrastructureReserveBps)||
    !safeInt(policy.fixedPaymentFeeMinor,0,1000000000)||
    typeof policy.pricingVersion!=="string"||!/^[A-Za-z0-9._-]{1,64}$/.test(policy.pricingVersion))return null;
 if(policy.targetMarginBps+policy.paymentFeeBps>=9500)return null;
 return Object.freeze({...policy});
}

export function resolveCustomerCreditPolicy(env=process.env){
 const names={
  currency:"CUSTOMER_CREDIT_CURRENCY",
  creditValueMinor:"CUSTOMER_CREDIT_VALUE_MINOR",
  minorUnitsPerMajor:"CUSTOMER_CREDIT_MINOR_UNITS_PER_MAJOR",
  targetMarginBps:"CUSTOMER_CREDIT_TARGET_MARGIN_BPS",
  paymentFeeBps:"CUSTOMER_CREDIT_PAYMENT_FEE_BPS",
  retryReserveBps:"CUSTOMER_CREDIT_RETRY_RESERVE_BPS",
  infrastructureReserveBps:"CUSTOMER_CREDIT_INFRA_RESERVE_BPS",
  fixedPaymentFeeMinor:"CUSTOMER_CREDIT_FIXED_PAYMENT_FEE_MINOR",
  pricingVersion:"CUSTOMER_CREDIT_PRICING_VERSION"
 };
 const parsed={};
 for(const [field,key] of Object.entries(names)){
  const raw=env?.[key];
  if(raw===undefined||raw===null||String(raw).trim()==="")return Object.freeze({configured:false,missing:[key]});
  if(field==="pricingVersion")parsed[field]=String(raw).trim();
  else if(field==="currency")parsed[field]=String(raw).trim().toUpperCase();
  else if(!/^[0-9]+$/.test(String(raw)))return Object.freeze({configured:false,invalid:[key]});
  else parsed[field]=Number(raw);
 }
 const policy=normalizePolicy(parsed);
 return policy?Object.freeze({configured:true,policy}):Object.freeze({configured:false,invalid:["CUSTOMER_CREDIT_POLICY"]});
}

export function parseVideoModelQualityEvidence(raw){
 if(typeof raw!=="string"||!raw.trim())return Object.freeze({configured:false,records:Object.freeze([]),rejectedCount:0});
 let parsed;
 try{parsed=JSON.parse(raw);}catch{return Object.freeze({configured:false,records:Object.freeze([]),rejectedCount:1});}
 if(!Array.isArray(parsed)||parsed.length>100)return Object.freeze({configured:false,records:Object.freeze([]),rejectedCount:1});
 const records=[],seen=new Set();let rejectedCount=0;
 for(const item of parsed){
  if(!item||typeof item!=="object"||Array.isArray(item)||
     typeof item.provider!=="string"||!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item.provider)||
     typeof item.model!=="string"||!item.model.trim()||item.model.length>160||
     item.verified!==true||!safeInt(item.sampleCount,25,1000000)||
     typeof item.qualityScore!=="number"||!Number.isFinite(item.qualityScore)||item.qualityScore<0||item.qualityScore>1||
     typeof item.p95LatencyMs!=="number"||!safeInt(item.p95LatencyMs,1,86400000)||
     typeof item.evaluationVersion!=="string"||!/^[A-Za-z0-9._-]{1,100}$/.test(item.evaluationVersion)){
   rejectedCount++;continue;
  }
  const provider=item.provider.toLowerCase(),model=item.model.trim(),key=provider+"\\0"+model;
  if(seen.has(key)){rejectedCount++;continue;}
  seen.add(key);
  records.push(Object.freeze({provider,model,verified:true,sampleCount:item.sampleCount,
   qualityScore:item.qualityScore,p95LatencyMs:item.p95LatencyMs,evaluationVersion:item.evaluationVersion}));
 }
 return Object.freeze({configured:records.length>0,records:Object.freeze(records),rejectedCount});
}

/**
 * Converts a provider cost estimate into a customer-credit quote.
 * This is a preview only: it never reads or mutates a balance, reserves credits,
 * authorizes a provider job or treats a forecast as an invoice.
 */
export function quoteCustomerCredits(providerQuote,rawPolicy){
 const policy=normalizePolicy(rawPolicy);
 if(!providerQuote||providerQuote.available!==true||providerQuote.estimated!==true||
    typeof providerQuote.currency!=="string"||!/^[A-Z]{3}$/.test(providerQuote.currency)||
    typeof providerQuote.amount!=="number"||!Number.isFinite(providerQuote.amount)||providerQuote.amount<0){
  return Object.freeze({available:false,reason:"A current, source-attributed provider estimate is required before customer credits can be quoted.",billable:false});
 }
 if(!policy)return Object.freeze({available:false,reason:"Customer credit pricing is not configured with a verified currency, credit value, fees, reserves and margin target.",billable:false});
 if(policy.currency!==providerQuote.currency)return Object.freeze({available:false,reason:"The customer credit policy currency does not match the provider quote; no FX conversion is configured.",billable:false});
 const scaledAmount=Math.round(providerQuote.amount*1e6);
 if(!Number.isSafeInteger(scaledAmount))return Object.freeze({available:false,reason:"The provider estimate exceeds supported monetary precision.",billable:false});
 const major=BigInt(scaledAmount);
 const minor=ceilDiv(major*BigInt(policy.minorUnitsPerMajor),1000000n);
 const retry=ceilDiv(minor*BigInt(policy.retryReserveBps),10000n);
 const infrastructure=ceilDiv(minor*BigInt(policy.infrastructureReserveBps),10000n);
 const fullyLoaded=minor+retry+infrastructure;
 const denominator=10000n-BigInt(policy.targetMarginBps+policy.paymentFeeBps);
 const revenue=ceilDiv((fullyLoaded+BigInt(policy.fixedPaymentFeeMinor))*10000n,denominator);
 let credits=ceilDiv(revenue,BigInt(policy.creditValueMinor));
 let customerPrice=0n,paymentFee=0n,contribution=0n;
 let marginSatisfied=false;
 for(let attempt=0;attempt<100;attempt++){
  customerPrice=credits*BigInt(policy.creditValueMinor);
  paymentFee=ceilDiv(customerPrice*BigInt(policy.paymentFeeBps),10000n)+BigInt(policy.fixedPaymentFeeMinor);
  contribution=customerPrice-paymentFee-fullyLoaded;
  if(contribution*10000n>=customerPrice*BigInt(policy.targetMarginBps)){marginSatisfied=true;break;}
  credits++;
 }
 if(!marginSatisfied)return Object.freeze({available:false,reason:"Credit denomination cannot satisfy the configured minimum margin within safe rounding bounds.",billable:false});
 const grossMarginBps=customerPrice>0n?Number((contribution*10000n)/customerPrice):0;
 for(const value of [minor,retry,infrastructure,fullyLoaded,revenue,credits,customerPrice,paymentFee,contribution]){
  if(value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))return Object.freeze({available:false,reason:"The quote exceeds supported monetary or credit bounds.",billable:false});
 }
 return Object.freeze({
  available:true,billable:false,authorizationRequired:true,
  currency:providerQuote.currency,providerCostMinor:Number(minor),
  retryReserveMinor:Number(retry),infrastructureReserveMinor:Number(infrastructure),
  fullyLoadedCostMinor:Number(fullyLoaded),minimumRevenueMinor:Number(revenue),
  creditValueMinor:policy.creditValueMinor,minorUnitsPerMajor:policy.minorUnitsPerMajor,customerCredits:Number(credits),
  customerPriceMinor:Number(customerPrice),estimatedPaymentFeeMinor:Number(paymentFee),
  estimatedContributionMinor:Number(contribution),estimatedMarginBps:grossMarginBps,
  pricingVersion:policy.pricingVersion,
  providerPricing:providerQuote.pricing||null,
  disclaimer:"Indicative customer-credit quote only. It does not reserve credits or authorize generation. Reconcile actual provider usage, retries, fees, taxes and invoices before settlement."
 });
}

/**
 * Checks server-loaded entitlement snapshots against a production request.
 * A missing or stale entitlement is fail-closed; this function does not grant
 * credits or infer permissions from a client-supplied plan name.
 */
export function evaluateProductionEntitlement({subscription,request,creditBalance}={}){
 const blocked=(code,reason)=>Object.freeze({allowed:false,code,reason});
 if(!subscription||!["active","trialing"].includes(subscription.status))
  return blocked("SUBSCRIPTION_REQUIRED","An active subscription or explicitly enabled trial is required for paid production.");
 const snapshot=subscription.entitlements_snapshot;
 if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))
  return blocked("ENTITLEMENT_SNAPSHOT_MISSING","The server subscription has no valid entitlement snapshot.");
 if(snapshot.ai_generation!==true)
  return blocked("AI_GENERATION_NOT_INCLUDED","This subscription does not include AI generation access.");
 const duration=Number(request?.durationSeconds);
 if(!Number.isInteger(duration)||duration<1||duration>180)
  return blocked("PRODUCTION_DURATION_INVALID","Production duration must be between 1 and 180 seconds.");
 if(Number.isInteger(snapshot.max_video_seconds)&&duration>snapshot.max_video_seconds)
  return blocked("PLAN_DURATION_LIMIT","This production exceeds the plan's maximum video duration.");
 const resolution=String(request?.resolution||"provider_default");
 if(Array.isArray(snapshot.allowed_resolutions)&&!snapshot.allowed_resolutions.includes(resolution))
  return blocked("PLAN_RESOLUTION_LIMIT","The selected resolution is not included in this plan.");
 if(creditBalance!==undefined&&(!safeInt(creditBalance,0,1000000000)))
  return blocked("CREDIT_BALANCE_INVALID","The server credit balance is unavailable or invalid.");
 return Object.freeze({allowed:true,planCode:String(subscription.plan_code||""),planVersion:Number(subscription.plan_version)||null,
  availableCredits:creditBalance??null,requiresAtomicReservation:true});
}

/**
 * Compare production candidates by customer credits, but only recommend a route
 * when independent, versioned quality evidence meets the configured sample and
 * quality gates. Cost alone must never silently select a lower-quality model.
 */
export function compareCommercialProductionCandidates({candidates,minQualityScore=0.9,minSamples=25,maxLatencyMs=30000}={}){
 if(!Array.isArray(candidates)||candidates.length<2||candidates.length>20)
  throw fail("COMMERCIAL_CANDIDATE_COUNT_INVALID","Provide between 2 and 20 production candidates.");
 if(typeof minQualityScore!=="number"||!Number.isFinite(minQualityScore)||minQualityScore<0||minQualityScore>1||
    !safeInt(minSamples,1,100000)||!safeInt(maxLatencyMs,1,86400000))
  throw fail("COMMERCIAL_QUALITY_GATE_INVALID","Quality thresholds are invalid.");
 const rows=candidates.map(candidate=>{
  const quote=candidate?.creditQuote;
  const evidence=candidate?.qualityEvidence;
  const evidenceReady=Boolean(evidence&&evidence.verified===true&&typeof evidence.evaluationVersion==="string"&&
    evidence.evaluationVersion.trim()&&safeInt(evidence.sampleCount,1,1000000)&&
    typeof evidence.qualityScore==="number"&&Number.isFinite(evidence.qualityScore)&&evidence.qualityScore>=minQualityScore&&evidence.sampleCount>=minSamples&&safeInt(evidence.p95LatencyMs,1,86400000));
  return Object.freeze({id:String(candidate?.id||""),provider:String(candidate?.provider||""),model:String(candidate?.model||""),
   customerCredits:quote?.available===true&&safeInt(quote.customerCredits,1,1000000000)?quote.customerCredits:null,
   evidenceReady,qualityScore:evidence?.qualityScore??null,evaluationVersion:evidence?.evaluationVersion??null,
   p95LatencyMs:evidence?.p95LatencyMs??null,eligible:evidenceReady&&evidence.p95LatencyMs<=maxLatencyMs&&quote?.available===true&&safeInt(quote.customerCredits,1,1000000000)});
 });
 if(rows.some(row=>!row.id)||new Set(rows.map(row=>row.id)).size!==rows.length)
  throw fail("COMMERCIAL_CANDIDATE_ID_INVALID","Every production candidate needs a unique identifier.");
 const eligible=rows.filter(row=>row.eligible).sort((a,b)=>a.customerCredits-b.customerCredits||b.qualityScore-a.qualityScore||a.p95LatencyMs-b.p95LatencyMs);
 return Object.freeze({mode:"recommendation_only",automaticRouting:false,recommended:eligible[0]||null,
  candidates:Object.freeze(rows),reason:eligible.length?"Lowest-credit candidate with qualifying independent quality evidence.":"No candidate has enough verified quality evidence; choose manually or collect more evaluations."});
}
