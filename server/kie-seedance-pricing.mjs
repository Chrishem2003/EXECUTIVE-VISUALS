const PRICING_SOURCE="https://kie.ai/seedance-2-0?model=bytedance/seedance-2";
const PRICING_DATE="2026-11-05";
const USD_PER_CREDIT=0.005;
const RATES=Object.freeze({
 "480p":Object.freeze({withoutVideo:0.095,withVideo:0.0575}),
 "720p":Object.freeze({withoutVideo:0.205,withVideo:0.125}),
 "1080p":Object.freeze({withoutVideo:0.51,withVideo:0.31}),
 "4K":Object.freeze({withoutVideo:1.04,withVideo:0.64}),
 "2160p":Object.freeze({withoutVideo:1.04,withVideo:0.64})
});
const fail=(message,code)=>Object.assign(new Error(message),{code});
const round=value=>Number(value.toFixed(6));

export function estimateKieSeedanceCost({model="bytedance/seedance-2",durationSeconds,resolution="720p",referenceVideoSeconds=0}={}){
 if(model!=="bytedance/seedance-2")throw fail("No verified Kie pricing snapshot is configured for this model.","VIDEO_PRICE_UNVERIFIED");
 if(!Number.isInteger(durationSeconds)||durationSeconds<5||durationSeconds>15)throw fail("Kie Seedance 2.0 duration must be between 5 and 15 seconds.","VIDEO_PRICE_DURATION_INVALID");
 const selectedResolution=resolution==="provider_default"?"720p":resolution==="2160p"?"4K":resolution;
 if(!Object.hasOwn(RATES,selectedResolution))throw fail("Kie Seedance 2.0 resolution is not in the verified pricing snapshot.","VIDEO_PRICE_UNSUPPORTED_OPTION");
 if(typeof referenceVideoSeconds!=="number"||!Number.isFinite(referenceVideoSeconds)||referenceVideoSeconds<0||referenceVideoSeconds>15)throw fail("Kie reference video duration must be between zero and fifteen seconds.","VIDEO_PRICE_INPUT_INVALID");
 const withVideo=referenceVideoSeconds>0;
 const rate=RATES[selectedResolution][withVideo?"withVideo":"withoutVideo"];
 const billableSeconds=withVideo?durationSeconds+referenceVideoSeconds:durationSeconds;
 const credits=round(rate/ USD_PER_CREDIT * billableSeconds);
 const amount=round(rate*billableSeconds);
 return Object.freeze({provider:"kie",model,operation:"video",durationSeconds,resolution:selectedResolution,referenceVideoSeconds,
  currency:"USD",amount,credits,basis:withVideo?"provider_list_price_reference_video_seconds_plus_output":"provider_list_price_output_seconds",
  creditUsdValue:USD_PER_CREDIT,pricingSource:PRICING_SOURCE,pricingDate:PRICING_DATE,
  billable:false,settlementEligible:false});
}

export function createKieActualCostResolver({usdPerCredit=process.env.KIE_USD_PER_CREDIT}={}){
 const rate=Number(usdPerCredit);
 if(typeof usdPerCredit!=="string"&&typeof usdPerCredit!=="number"||!Number.isFinite(rate)||rate<=0||rate>0.05)throw fail("Set KIE_USD_PER_CREDIT to the verified effective USD value of one account credit.","KIE_BILLING_RATE_REQUIRED");
 return async({task,providerTaskId,creditsConsumed}={})=>{
  const taskId=String(providerTaskId||task?.taskId||"");
  const credits=Number(creditsConsumed??task?.creditsConsumed??task?.usage?.creditsConsumed);
  if(!/^task_[A-Za-z0-9_-]{6,200}$/.test(taskId)||!Number.isSafeInteger(credits)||credits<=0)throw fail("Kie task-level credit consumption is missing or invalid; settlement is blocked.","KIE_BILLING_USAGE_UNAVAILABLE");
  return Object.freeze({amount:round(credits*rate),currency:"USD",evidenceReference:"kie:task:"+taskId+":credits:"+credits,creditsConsumed:credits,usdPerCredit:rate});
 };
}
