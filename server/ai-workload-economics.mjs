const CURRENCY=/^[A-Z]{3}$/;
const RATE_FIELDS=Object.freeze({
 inputTokens:"inputMinorPerMillionTokens",
 outputTokens:"outputMinorPerMillionTokens",
 images:"imageMinorPerImage",
 videoSeconds:"videoMinorPerSecond",
 renderSeconds:"renderMinorPerSecond",
 gpuSeconds:"gpuMinorPerSecond",
 cpuSeconds:"cpuMinorPerSecond",
 storageGbDays:"storageMinorPerGbDay",
 egressGb:"egressMinorPerGb"
});
const MAX_QUANTITY=1e12;
function fail(code,message){throw Object.assign(new Error(message),{code});}
function number(value,label,{integer=false,min=0,max=Number.MAX_SAFE_INTEGER,optional=false}={}){
 if(optional&& (value===undefined||value===null||value===""))return null;
 const n=Number(value);
 if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isSafeInteger(n)))fail("WORKLOAD_ECONOMICS_VALUE_INVALID",label+" is invalid.");
 return n;
}
function minorCeil(numerator,denominator){
 const n=BigInt(numerator),d=BigInt(denominator);
 return Number((n+d-1n)/d);
}
function rateCard(input={}){
 const provider=String(input.provider||"").trim().toLowerCase();
 const model=String(input.model||"").trim();
 const currency=String(input.currency||"").trim().toUpperCase();
 const version=String(input.version||"").trim();
 if(provider.length<2||provider.length>80||!model||model.length>160||!CURRENCY.test(currency)||!version||version.length>80)
  fail("WORKLOAD_RATE_CARD_INVALID","Provider, model, ISO currency and rate-card version are required.");
 const rates={};
 for(const field of Object.values(RATE_FIELDS)){
  const value=number(input[field],field,{integer:true,optional:true});
  if(value!==null)rates[field]=value;
 }
 if(!Object.keys(rates).length)fail("WORKLOAD_RATE_CARD_EMPTY","At least one explicit provider rate is required.");
 return {provider,model,currency,version,rates};
}
function workload(input={}){
 const operation=String(input.operation||"");
 const allowed=["text","image","video","render","upscale","audio","embedding","other"];
 if(!allowed.includes(operation))fail("WORKLOAD_OPERATION_INVALID","Choose a supported creative workload operation.");
 const quantities={};
 for(const field of Object.keys(RATE_FIELDS)){
  const value=number(input[field],field,{min:0,max:MAX_QUANTITY,optional:true});
  if(value!==null&&value>0)quantities[field]=value;
 }
 if(!Object.keys(quantities).length)fail("WORKLOAD_QUANTITY_REQUIRED","At least one positive measured or planned workload quantity is required.");
 const successfulOutputs=number(input.successfulOutputs??1,"successfulOutputs",{integer:true,min:1,max:1_000_000});
 return {operation,quantities,successfulOutputs};
}
function costLines(card,job){
 const lines=[];
 for(const [quantityField,rateField] of Object.entries(RATE_FIELDS)){
  const quantity=job.quantities[quantityField],rate=card.rates[rateField];
  if(quantity===undefined)continue;
  if(rate===undefined)fail("WORKLOAD_RATE_MISSING","Rate card "+card.provider+"/"+card.model+" is missing "+rateField+".");
  let amount;
  if(quantityField==="inputTokens"||quantityField==="outputTokens"){
   const tokens=number(quantity,quantityField,{integer:true,min:0,max:MAX_QUANTITY});
   amount=minorCeil(BigInt(tokens)*BigInt(rate),1_000_000n);
  }else{
   // Decimal quantities are scaled to six places before integer arithmetic.
   const micros=BigInt(Math.ceil(quantity*1_000_000));
   amount=minorCeil(micros*BigInt(rate),1_000_000n);
  }
  if(!Number.isSafeInteger(amount))fail("WORKLOAD_COST_OVERFLOW","Estimated cost exceeds the safe integer range.");
  lines.push({driver:quantityField,quantity,rateMinor:rate,amountMinor:amount});
 }
 const total=lines.reduce((sum,line)=>sum+line.amountMinor,0);
 if(!Number.isSafeInteger(total))fail("WORKLOAD_COST_OVERFLOW","Estimated total exceeds the safe integer range.");
 return {lines,total};
}
function pricing(costMinor,assumptions={}){
 const targetMarginBps=number(assumptions.targetMarginBps??6000,"targetMarginBps",{integer:true,min:1000,max:9000});
 const paymentFeeBps=number(assumptions.paymentFeeBps??300,"paymentFeeBps",{integer:true,min:0,max:2000});
 const fixedPaymentFeeMinor=number(assumptions.fixedPaymentFeeMinor??0,"fixedPaymentFeeMinor",{integer:true,min:0});
 const supportReserveBps=number(assumptions.supportReserveBps??500,"supportReserveBps",{integer:true,min:0,max:5000});
 if(targetMarginBps+paymentFeeBps>=9500)fail("WORKLOAD_PRICING_ASSUMPTIONS_INVALID","Target margin plus payment fee must remain below 95%.");
 const reservedCost=costMinor+minorCeil(BigInt(costMinor)*BigInt(supportReserveBps),10000n);
 const denominator=10000-targetMarginBps-paymentFeeBps;
 const floorPrice=minorCeil(BigInt(reservedCost+fixedPaymentFeeMinor)*10000n,BigInt(denominator));
 return {targetMarginBps,paymentFeeBps,fixedPaymentFeeMinor,supportReserveBps,reservedCostMinor:reservedCost,minimumPriceMinor:floorPrice};
}
function range(cost,uncertaintyBps){
 const low=Math.max(0,cost-minorCeil(BigInt(cost)*BigInt(uncertaintyBps),10000n));
 const high=cost+minorCeil(BigInt(cost)*BigInt(uncertaintyBps),10000n);
 return {lowMinor:low,baseMinor:cost,highMinor:high};
}
export function estimateWorkloadEconomics(input={}){
 const card=rateCard(input.rateCard),job=workload(input.workload);
 const requestedCurrency=String(input.workload.currency||card.currency).trim().toUpperCase();
 if(!CURRENCY.test(requestedCurrency)||card.currency!==requestedCurrency)fail("WORKLOAD_CURRENCY_MISMATCH","Workload and rate-card currencies must match an ISO currency code.");
 const uncertaintyBps=number(input.uncertaintyBps??1500,"uncertaintyBps",{integer:true,min:0,max:5000});
 const costs=costLines(card,job),costRange=range(costs.total,uncertaintyBps);
 const assumptions=input.pricing||{};
 const basePricing=pricing(costRange.baseMinor,assumptions);
 const highPricing=pricing(costRange.highMinor,assumptions);
 const lowPricing=pricing(costRange.lowMinor,assumptions);
 return {
  estimateVersion:"1.0",estimateType:"forecast_not_actual",
  provider:card.provider,model:card.model,currency:card.currency,rateCardVersion:card.version,
  operation:job.operation,successfulOutputs:job.successfulOutputs,
  costLines:costs.lines,costRange,
  unitCostMinor:minorCeil(BigInt(costRange.baseMinor),BigInt(job.successfulOutputs)),
  pricing:{...basePricing,lowCostMinimumPriceMinor:lowPricing.minimumPriceMinor,highCostMinimumPriceMinor:highPricing.minimumPriceMinor},
  assumptions:{uncertaintyBps,source:"explicit_rate_card_and_planned_quantities"},
  limitations:[
   "Forecast only; it is not a provider quote, invoice, actual ledger posting or guaranteed charge.",
   "Rate cards must be maintained from current provider contracts and invoices; no vendor prices are hardcoded.",
   "Taxes, refunds, discounts, storage retention policy and FX are excluded unless explicitly modelled in the rate card.",
   "Resource quantities and successful output counts are planning inputs; replace them with measured telemetry after execution."
  ]
 };
}
export function compareWorkloadCandidates(input={}){
 const cards=Array.isArray(input.rateCards)?input.rateCards:[];
 if(cards.length<2||cards.length>30)fail("WORKLOAD_CANDIDATE_COUNT_INVALID","Provide between 2 and 30 model rate cards.");
 const limits=input.limits||{};
 const currencies=new Set(cards.map(candidate=>String(candidate?.rateCard?.currency||"").trim().toUpperCase()));
 if(currencies.size!==1||currencies.has(""))fail("WORKLOAD_CANDIDATE_CURRENCY_MISMATCH","All candidate rate cards must use the same ISO currency for a valid cost comparison.");
 const maxCostMinor=number(limits.maxCostMinor,"maxCostMinor",{integer:true,min:1});
 const maxLatencyMs=number(limits.maxLatencyMs,"maxLatencyMs",{integer:true,min:1,max:86_400_000});
 const minQualityScore=number(limits.minQualityScore,"minQualityScore",{min:0,max:1});
 const rows=cards.map(candidate=>{
  const estimate=estimateWorkloadEconomics({rateCard:candidate.rateCard,workload:input.workload,pricing:input.pricing,uncertaintyBps:input.uncertaintyBps});
  const samples=number(candidate.samples??0,"samples",{integer:true,min:0,max:1_000_000_000});
  const qualityScore=number(candidate.qualityScore??0,"qualityScore",{min:0,max:1});
  const p95LatencyMs=number(candidate.p95LatencyMs??0,"p95LatencyMs",{integer:true,min:0,max:86_400_000});
  const evidenceVersion=String(candidate.evaluationVersion||"").trim();
  const evidenceReady=samples>=20&&evidenceVersion.length>0&&p95LatencyMs>0;
  const eligible=evidenceReady&&estimate.costRange.highMinor<=maxCostMinor&&p95LatencyMs<=maxLatencyMs&&qualityScore>=minQualityScore;
  return {provider:estimate.provider,model:estimate.model,currency:estimate.currency,estimatedCostMinor:estimate.costRange.baseMinor,worstCaseCostMinor:estimate.costRange.highMinor,minimumPriceMinor:estimate.pricing.minimumPriceMinor,qualityScore,samples,p95LatencyMs,evaluationVersion:evidenceVersion,evidenceReady,eligible};
 }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||(a.worstCaseCostMinor-b.worstCaseCostMinor)||(b.qualityScore-a.qualityScore)||(a.p95LatencyMs-b.p95LatencyMs)||a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));
 const recommended=rows.find(row=>row.eligible)||null;
 return {mode:"shadow_only",automaticRouting:false,recommended,reason:recommended?"Lowest forecast worst-case cost among candidates meeting measured quality, sample and latency gates.":"No candidate has sufficient evaluation evidence and satisfies all cost, quality and latency limits.",candidates:rows,limitations:["Recommendation does not invoke a provider or change production routing.","At least 20 measured evaluation samples and a versioned evaluation set are required.","Use task-specific quality thresholds and re-run evaluations after model, prompt or provider changes."]};
}
