const CURRENCY=/^[A-Z]{3}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const integer=(value,label,min,max)=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("PLATFORM_MARGIN_POLICY_INPUT_INVALID",label+" is outside its permitted integer range.");
 return value;
};
function timestamp(value,label){
 const parsed=Date.parse(value||"");
 if(!Number.isFinite(parsed))fail("PLATFORM_MARGIN_POLICY_EVIDENCE_INVALID",label+" must be a valid timestamp.");
 return parsed;
}

/**
 * Fail-closed owner policy evaluation for a proposed paid generation.
 * Customer credit units are never treated as money: the revenue side must be a
 * separately verified recognized-revenue allocation from subscription/top-up
 * accounting, in the same currency as the provider estimate.
 */
export function evaluatePlatformMarginFloor({
 policy,providerEstimate,customerRevenueEvidence,quoteObservedAt,now=Date.now()
}={}){
 const blocked=(code,reason)=>Object.freeze({readyForDispatch:false,code,reason});
 if(!policy||policy.enabled!==true)return blocked("PLATFORM_MARGIN_POLICY_DISABLED","The platform owner has not enabled a minimum-margin policy.");
 let minimumGrossMarginBps,quoteMaxAgeSeconds,rateCardMaxAgeSeconds,version;
 try{
  minimumGrossMarginBps=integer(policy.minimumGrossMarginBps??policy.minimum_gross_margin_bps,"minimumGrossMarginBps",1,9500);
  quoteMaxAgeSeconds=integer(policy.quoteMaxAgeSeconds??policy.quote_max_age_seconds,"quoteMaxAgeSeconds",60,3600);
  rateCardMaxAgeSeconds=integer(policy.rateCardMaxAgeSeconds??policy.rate_card_max_age_seconds,"rateCardMaxAgeSeconds",3600,3888000);
  version=integer(Number(policy.version),"policy.version",1,Number.MAX_SAFE_INTEGER);
 }catch(error){return blocked(error.code||"PLATFORM_MARGIN_POLICY_INVALID",error.message);}
 if(!Number.isSafeInteger(now)||now<0)return blocked("PLATFORM_MARGIN_POLICY_CLOCK_INVALID","A valid server clock is required.");
 if(!providerEstimate||providerEstimate.available!==true||providerEstimate.estimated!==true)
  return blocked("PLATFORM_MARGIN_PROVIDER_ESTIMATE_UNAVAILABLE","A current verified provider estimate is required.");
 const currency=String(providerEstimate.currency||"").toUpperCase();
 if(!CURRENCY.test(currency))return blocked("PLATFORM_MARGIN_CURRENCY_INVALID","Provider estimate currency is invalid.");
 const amount=providerEstimate.amount;
 if(typeof amount!=="number"||!Number.isFinite(amount)||amount<=0)
  return blocked("PLATFORM_MARGIN_PROVIDER_COST_INVALID","Provider estimate must contain a positive cost.");
 const providerCostMicros=Math.round(amount*1_000_000);
 if(!Number.isSafeInteger(providerCostMicros)||providerCostMicros<1||
    Math.abs(amount*1_000_000-providerCostMicros)>0.00001)
  return blocked("PLATFORM_MARGIN_PROVIDER_COST_INVALID","Provider cost cannot be represented safely in currency micro-units.");
 const pricing=providerEstimate.pricing;
 if(!pricing||typeof pricing.sourceUrl!=="string"||!pricing.sourceUrl.startsWith("https://"))
  return blocked("PLATFORM_MARGIN_RATE_CARD_UNVERIFIED","A source-linked provider rate card is required.");
 let quoteMs,rateObservedMs,rateExpiresMs;
 try{
  quoteMs=timestamp(quoteObservedAt,"quoteObservedAt");
  rateObservedMs=timestamp(pricing.observedAt,"pricing.observedAt");
  rateExpiresMs=timestamp(pricing.expiresAt,"pricing.expiresAt");
 }catch(error){return blocked(error.code||"PLATFORM_MARGIN_EVIDENCE_INVALID",error.message);}
 if(quoteMs>now+30_000||now-quoteMs>quoteMaxAgeSeconds*1000)
  return blocked("PLATFORM_MARGIN_QUOTE_STALE","The customer quote is stale or future-dated; re-quote before dispatch.");
 if(rateObservedMs>now+30_000||now-rateObservedMs>rateCardMaxAgeSeconds*1000||rateExpiresMs<=now)
  return blocked("PLATFORM_MARGIN_RATE_CARD_STALE","The provider rate card is stale or expired; refresh its source before dispatch.");
 const revenue=customerRevenueEvidence;
 if(!revenue||revenue.status!=="verified"||revenue.currency!==currency||
    !Number.isSafeInteger(revenue.recognizedRevenueMicros)||revenue.recognizedRevenueMicros<1||
    !HASH.test(String(revenue.evidenceSha256||"").toLowerCase())||
    typeof revenue.evidenceReference!=="string"||!revenue.evidenceReference.trim()||revenue.evidenceReference.length>240)
  return blocked("PLATFORM_MARGIN_REVENUE_UNVERIFIED","Verified same-currency recognized revenue evidence is required; customer credits are not money.");
 const revenueMicros=revenue.recognizedRevenueMicros;
 const grossProfitMicros=revenueMicros-providerCostMicros;
 const grossMarginBps=Number((BigInt(grossProfitMicros)*10_000n)/BigInt(revenueMicros));
 if(grossProfitMicros<=0||grossMarginBps<minimumGrossMarginBps)
  return Object.freeze({
   readyForDispatch:false,code:"PLATFORM_GROSS_MARGIN_BELOW_FLOOR",
   reason:"This generation quote does not meet the platform owner's minimum gross-margin floor.",
   currency,providerCostMicros,revenueMicros,grossProfitMicros,grossMarginBps,
   minimumGrossMarginBps,policyVersion:version
  });
 return Object.freeze({
  readyForDispatch:true,code:"PLATFORM_GROSS_MARGIN_APPROVED",
  currency,providerCostMicros,revenueMicros,grossProfitMicros,grossMarginBps,
  minimumGrossMarginBps,policyVersion:version,
  revenueEvidenceReference:revenue.evidenceReference,
  revenueEvidenceSha256:String(revenue.evidenceSha256).toLowerCase(),
  providerPricingSource:pricing.sourceUrl,
  quoteObservedAt:new Date(quoteMs).toISOString(),
  rateCardObservedAt:new Date(rateObservedMs).toISOString(),
  rateCardExpiresAt:new Date(rateExpiresMs).toISOString()
 });
}
