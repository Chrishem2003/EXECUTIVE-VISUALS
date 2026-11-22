const CURRENCY=/^[A-Z]{3}$/;
const HASH=/^[a-f0-9]{64}$/;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const text=(value,label,max=240)=>{
 if(typeof value!=="string"||!value.trim()||value.trim().length>max)fail("JOB_PROFITABILITY_INPUT_INVALID",label+" is required.");
 return value.trim();
};
const integer=(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={})=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("JOB_PROFITABILITY_INPUT_INVALID",label+" must be a safe integer in range.");
 return value;
};
const pct=(numerator,denominator)=>{
 if(denominator===0)return null;
 return Math.round((numerator/denominator)*10000)/100;
};

/**
 * Computes realized job economics from separately verified evidence.
 * Credit units are deliberately not converted into money here: recognizedRevenueMinor
 * must be supplied by the trusted subscription/top-up revenue allocation ledger.
 */
export function calculateVerifiedJobProfitability(input={}){
 const jobId=text(input.jobId,"jobId",180);
 const currency=String(input.currency||"").toUpperCase();
 if(!CURRENCY.test(currency))fail("JOB_PROFITABILITY_CURRENCY_INVALID","A three-letter ISO currency is required.");
 const forecast=input.forecast;
 if(!forecast||forecast.estimateType!=="forecast_not_actual"||forecast.currency!==currency)
  fail("JOB_PROFITABILITY_FORECAST_INVALID","A same-currency typed forecast is required.");
 const forecastCostMinor=integer(forecast.baseCostMinor,"forecast.baseCostMinor");
 const acceptedOutputs=integer(input.acceptedOutputs,"acceptedOutputs",{min:1,max:1_000_000});
 const rejectedOutputs=integer(input.rejectedOutputs??0,"rejectedOutputs",{max:1_000_000});
 const creditsDebited=integer(input.creditsDebited,"creditsDebited",{min:1,max:1_000_000_000});
 const revenue=input.revenue;
 if(!revenue||revenue.status!=="verified"||revenue.currency!==currency)
  fail("JOB_PROFITABILITY_REVENUE_UNVERIFIED","Verified same-currency revenue allocation is required.");
 const recognizedRevenueMinor=integer(revenue.recognizedRevenueMinor,"recognizedRevenueMinor",{min:1});
 const revenueEvidence=text(revenue.evidenceReference,"revenue.evidenceReference",240);
 const revenueHash=String(revenue.evidenceSha256||"").toLowerCase();
 if(!HASH.test(revenueHash))fail("JOB_PROFITABILITY_EVIDENCE_INVALID","Revenue allocation requires a SHA-256 evidence digest.");
 const actualLines=input.actualCostLines;
 if(!Array.isArray(actualLines)||actualLines.length<1||actualLines.length>500)
  fail("JOB_PROFITABILITY_ACTUALS_REQUIRED","At least one verified actual cost line is required.");
 const seen=new Set();
 const lines=actualLines.map((line,index)=>{
  const sourceId=text(line?.sourceId,"actual sourceId",180);
  if(seen.has(sourceId))fail("JOB_PROFITABILITY_DUPLICATE_SOURCE","Actual cost source IDs must be unique.");
  seen.add(sourceId);
  if(!["provider_invoice","provider_usage_export","usage_meter","infrastructure_meter","payment_processor"].includes(line?.sourceType))
   fail("JOB_PROFITABILITY_SOURCE_TYPE_INVALID","Actual cost source type is not supported.");
  if(line.currency!==currency)fail("JOB_PROFITABILITY_CURRENCY_MISMATCH","All actual cost lines must use the job currency; FX is not inferred.");
  const amountMinor=integer(line.amountMinor,"actual amountMinor");
  const evidenceReference=text(line.evidenceReference,"actual evidenceReference",240);
  const evidenceSha256=String(line.evidenceSha256||"").toLowerCase();
  if(!HASH.test(evidenceSha256))fail("JOB_PROFITABILITY_EVIDENCE_INVALID","Every actual cost line requires a SHA-256 evidence digest.");
  return {index,sourceId,sourceType:line.sourceType,amountMinor,evidenceReference,evidenceSha256};
 });
 const actualCostMinor=lines.reduce((sum,line)=>sum+line.amountMinor,0);
 if(!Number.isSafeInteger(actualCostMinor))fail("JOB_PROFITABILITY_OVERFLOW","Actual cost total exceeds safe integer bounds.");
 const contributionMinor=recognizedRevenueMinor-actualCostMinor;
 const forecastVarianceMinor=actualCostMinor-forecastCostMinor;
 const totalAttempts=acceptedOutputs+rejectedOutputs;
 if(!Number.isSafeInteger(totalAttempts))fail("JOB_PROFITABILITY_OVERFLOW","Attempt count exceeds safe integer bounds.");
 return {
  reportVersion:"1.0",reportType:"verified_job_profitability",jobId,currency,
  revenue:{recognizedMinor:recognizedRevenueMinor,evidenceReference:revenueEvidence,evidenceSha256:revenueHash},
  customerUsage:{creditsDebited,acceptedOutputs,rejectedOutputs,totalAttempts,
   acceptanceRatePct:pct(acceptedOutputs,totalAttempts),
   recognizedRevenuePerCreditMinor:Math.round(recognizedRevenueMinor/creditsDebited*100)/100},
  forecast:{costMinor:forecastCostMinor,rateCardVersion:text(forecast.rateCardVersion,"forecast.rateCardVersion",80)},
  actual:{costMinor:actualCostMinor,lineCount:lines.length,lines,
   costPerAcceptedOutputMinor:Math.ceil(actualCostMinor/acceptedOutputs)},
  variance:{amountMinor:forecastVarianceMinor,direction:forecastVarianceMinor>0?"unfavourable":forecastVarianceMinor<0?"favourable":"on_forecast",
   pctOfForecast:pct(forecastVarianceMinor,forecastCostMinor)},
  profitability:{contributionMinor,grossMarginPct:pct(contributionMinor,recognizedRevenueMinor),
   profitable:contributionMinor>0},
  controls:[
   "Credit units are not money; recognized revenue must come from a verified subscription or top-up allocation.",
   "Provider actual costs require source-linked evidence; forecasts never substitute for actuals.",
   "All amounts remain in one currency. No implicit foreign-exchange conversion is performed.",
   "Shared overhead, taxes, refunds and chargebacks are excluded unless separately attributed with verified evidence.",
   "This calculation is analytical only and never writes or reverses a financial ledger entry."
  ]
 };
}
