const CURRENCY=/^[A-Z]{3}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const integer=(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={})=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("WORKLOAD_VARIANCE_INPUT_INVALID",label+" must be a safe integer in range.");
 return value;
};
const requiredText=(value,label,max=240)=>{
 if(typeof value!=="string"||!value.trim()||value.trim().length>max)fail("WORKLOAD_VARIANCE_INPUT_INVALID",label+" is required.");
 return value.trim();
};
const bps=(numerator,denominator)=>{
 if(denominator===0)return null;
 const n=BigInt(numerator)*10000n,d=BigInt(denominator);
 const sign=n<0n?-1n:1n,abs=n<0n?-n:n;
 const rounded=(abs+d/2n)/d;
 const result=Number(sign*rounded);
 if(!Number.isSafeInteger(result))fail("WORKLOAD_VARIANCE_OVERFLOW","Variance percentage exceeds the safe integer range.");
 return result;
};
export function analyzeWorkloadCostVariance(input={}){
 const estimate=input.estimate||{};
 if(estimate.estimateType!=="forecast_not_actual")fail("WORKLOAD_VARIANCE_ESTIMATE_INVALID","A Batch 27 forecast result is required; actuals cannot be compared with an untyped estimate.");
 const currency=String(estimate.currency||"").toUpperCase();
 if(!CURRENCY.test(currency))fail("WORKLOAD_VARIANCE_CURRENCY_INVALID","Forecast currency must be a three-letter ISO currency code.");
 const forecast=estimate.costRange||{};
 const forecastMinor=integer(forecast.baseMinor,"forecast base cost");
 const lowMinor=integer(forecast.lowMinor,"forecast low cost");
 const highMinor=integer(forecast.highMinor,"forecast high cost");
 if(lowMinor>forecastMinor||forecastMinor>highMinor)fail("WORKLOAD_VARIANCE_RANGE_INVALID","Forecast low, base and high costs must be ordered.");
 const acceptedOutputs=integer(input.acceptedOutputs,"acceptedOutputs",{min:1,max:1_000_000_000});
 const rejectedOutputs=integer(input.rejectedOutputs??0,"rejectedOutputs",{min:0,max:1_000_000_000});
 const actuals=input.actuals;
 if(!Array.isArray(actuals)||actuals.length<1||actuals.length>500)fail("WORKLOAD_VARIANCE_ACTUALS_REQUIRED","Provide between 1 and 500 verified actual cost lines.");
 const seen=new Set();
 const lines=actuals.map((line,index)=>{
  const sourceId=requiredText(line?.sourceId,"actual sourceId",160);
  if(seen.has(sourceId))fail("WORKLOAD_VARIANCE_DUPLICATE_SOURCE","Actual source identifiers must be unique.");
  seen.add(sourceId);
  const sourceType=requiredText(line?.sourceType,"actual sourceType",40);
  if(!["provider_invoice","usage_meter","infrastructure_meter"].includes(sourceType))fail("WORKLOAD_VARIANCE_SOURCE_TYPE_INVALID","Actual sourceType must be provider_invoice, usage_meter or infrastructure_meter.");
  const lineCurrency=String(line?.currency||"").toUpperCase();
  if(lineCurrency!==currency)fail("WORKLOAD_VARIANCE_CURRENCY_MISMATCH","Every actual line must use the forecast currency; FX conversion is not performed.");
  const amountMinor=integer(line?.amountMinor,"actual amountMinor");
  const evidenceReference=requiredText(line?.evidenceReference,"actual evidenceReference");
  const evidenceSha256=String(line?.evidenceSha256||"").toLowerCase();
  if(!HASH.test(evidenceSha256))fail("WORKLOAD_VARIANCE_EVIDENCE_INVALID","Every actual line requires a SHA-256 evidence digest.");
  const observedAt=requiredText(line?.observedAt,"actual observedAt",40);
  if(!Number.isFinite(Date.parse(observedAt)))fail("WORKLOAD_VARIANCE_DATE_INVALID","Actual observedAt must be a valid timestamp.");
  return {index,sourceId,sourceType,amountMinor,currency,evidenceReference,evidenceSha256,observedAt};
 });
 const actualMinor=lines.reduce((sum,line)=>sum+line.amountMinor,0);
 if(!Number.isSafeInteger(actualMinor))fail("WORKLOAD_VARIANCE_OVERFLOW","Actual cost total exceeds the safe integer range.");
 const varianceMinor=actualMinor-forecastMinor;
 const varianceBps=bps(varianceMinor,forecastMinor);
 const classification=actualMinor<lowMinor?"below_forecast_range":actualMinor>highMinor?"above_forecast_range":"within_forecast_range";
 const totalOutputs=acceptedOutputs+rejectedOutputs;
 if(!Number.isSafeInteger(totalOutputs))fail("WORKLOAD_VARIANCE_OVERFLOW","Output count exceeds the safe integer range.");
 return {
  analysisVersion:"1.0",
  analysisType:"verified_actual_vs_forecast",
  estimateVersion:String(estimate.estimateVersion||"unknown"),
  rateCardVersion:String(estimate.rateCardVersion||"unknown"),
  provider:String(estimate.provider||"unknown"),
  model:String(estimate.model||"unknown"),
  operation:String(estimate.operation||"unknown"),
  currency,
  forecast:{lowMinor,baseMinor:forecastMinor,highMinor},
  actual:{totalMinor:actualMinor,lineCount:lines.length,lines},
  variance:{amountMinor:varianceMinor,basisPoints:varianceBps,classification,direction:varianceMinor>0?"unfavourable":varianceMinor<0?"favourable":"on_forecast"},
  outputs:{accepted:acceptedOutputs,rejected:rejectedOutputs,totalAttempts:totalOutputs,acceptanceRateBps:bps(acceptedOutputs,totalOutputs),forecastUnitCostMinor:Math.ceil(forecastMinor/acceptedOutputs),actualUnitCostMinor:Math.ceil(actualMinor/acceptedOutputs)},
  safeguards:[
   "Actual amounts are compared only in the forecast currency; no foreign-exchange conversion is applied.",
   "Every actual line must carry a unique source identifier and SHA-256 evidence digest.",
   "This analysis does not post a ledger entry, issue an invoice, change a plan or route a provider.",
   "Evidence digests establish file identity only when independently recomputed from the underlying source bytes."
  ]
 };
}
