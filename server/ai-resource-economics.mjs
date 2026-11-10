const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY=/^[A-Z]{3}$/;
const RESOURCE_UNITS=Object.freeze({
 ffmpeg_second:"second",gpu_second:"second",cpu_second:"second",
 storage_gb_day:"gb_day",egress_gb:"gb"
});
const OPERATIONS=new Set(["text","image","video","render","upscale","audio","embedding","other"]);
const QUALITY_SOURCES=new Set(["human_review","approved_evaluator"]);
const first=(...values)=>values.find(value=>value!==undefined&&value!==null&&value!=="");
function invalid(code,message){return Object.assign(new Error(message),{code});}
function finite(value,label,{integer=false,min=0,max=Number.MAX_SAFE_INTEGER}={}){
 const number=Number(value);
 if(!Number.isFinite(number)||number<min||number>max||(integer&&!Number.isSafeInteger(number)))throw invalid("RESOURCE_VALUE_INVALID",label+" is invalid.");
 return number;
}
export function normalizeResourceUsage(input={}){
 const resourceType=String(input.resourceType||"");
 const expectedUnit=RESOURCE_UNITS[resourceType];
 const provider=String(input.provider||"executive-visuals-worker").trim().toLowerCase();
 const model=String(input.model||input.jobType||"worker-operation").trim();
 const operationId=String(first(input.operationId,input.jobId)||"").trim();
 const quantity=finite(input.quantity,"Measured resource quantity",{min:Number.MIN_VALUE,max:1e15});
 const unit=String(input.unit||expectedUnit||"");
 const currency=first(input.currency);
 const cost=input.providerCostMinor==null||input.providerCostMinor===""?null:finite(input.providerCostMinor,"Provider-reported resource cost",{integer:true});
 const idempotencyKey=String(input.idempotencyKey||"").trim();
 if(!expectedUnit||unit!==expectedUnit)throw invalid("RESOURCE_UNIT_INVALID","Resource type and unit do not match the supported measurement contract.");
 if(provider.length<2||provider.length>80||!model||model.length>160||!operationId||operationId.length>180)
  throw invalid("RESOURCE_IDENTITY_INVALID","Provider, model/job type and operation identifier are required.");
 if(currency!==undefined&&!CURRENCY.test(String(currency).toUpperCase()))throw invalid("RESOURCE_CURRENCY_INVALID","Resource currency must be an ISO 4217 code.");
 if(cost!==null&&currency===undefined)throw invalid("RESOURCE_CURRENCY_REQUIRED","Provider-reported resource cost requires a currency.");
 if(idempotencyKey.length<8||idempotencyKey.length>180)throw invalid("RESOURCE_IDEMPOTENCY_INVALID","Resource event idempotency key must contain 8 to 180 characters.");
 for(const [label,value] of [["ownerId",input.ownerId],["projectId",input.projectId],["jobId",input.jobId]])
  if(value!=null&&value!==""&&!UUID.test(String(value)))throw invalid("RESOURCE_ATTRIBUTION_INVALID",label+" must be a valid UUID.");
 const occurredAt=String(first(input.occurredAt,input.measuredAt,new Date().toISOString()));
 if(!Number.isFinite(Date.parse(occurredAt)))throw invalid("RESOURCE_TIMESTAMP_INVALID","Resource event timestamp is invalid.");
 return {
  occurredAt,provider,model,operationId,resourceType,quantity,unit,
  currency:currency===undefined?null:String(currency).toUpperCase(),
  providerCostMinor:cost,ownerId:input.ownerId||null,projectId:input.projectId||null,
  jobId:input.jobId||null,idempotencyKey
 };
}
export function normalizeModelPerformance(input={}){
 const provider=String(input.provider||"").trim().toLowerCase();
 const model=String(input.model||"").trim();
 const operation=String(input.operation||"");
 const usageEventId=String(input.usageEventId||"");
 const latencyMs=finite(input.latencyMs,"Model latency",{integer:true,min:1,max:86_400_000});
 const qualityScore=finite(input.qualityScore,"Model quality score",{min:0,max:1});
 const qualitySource=String(input.qualitySource||"");
 const evaluationVersion=String(input.evaluationVersion||"").trim();
 const idempotencyKey=String(input.idempotencyKey||"").trim();
 if(provider.length<2||provider.length>80||!model||model.length>160||!OPERATIONS.has(operation)||!UUID.test(usageEventId))
  throw invalid("MODEL_PERFORMANCE_IDENTITY_INVALID","Provider, model, supported operation and linked usage event are required.");
 if(!QUALITY_SOURCES.has(qualitySource)||!evaluationVersion||evaluationVersion.length>120)
  throw invalid("MODEL_PERFORMANCE_PROVENANCE_INVALID","Quality source and evaluation version are required.");
 if(idempotencyKey.length<8||idempotencyKey.length>180)throw invalid("MODEL_PERFORMANCE_IDEMPOTENCY_INVALID","Performance idempotency key must contain 8 to 180 characters.");
 return {provider,model,operation,usageEventId,latencyMs,qualityScore,qualitySource,evaluationVersion,idempotencyKey};
}
/** Pure deterministic ranking helper used to verify shadow-route responses. It never invokes a provider. */
export function rankShadowModelCandidates(candidates=[],limits={}){
 const maxCost=finite(limits.maxCostMinor,"Maximum cost",{integer:true,min:1});
 const maxLatency=finite(limits.maxLatencyMs,"Maximum latency",{integer:true,min:1});
 const minQuality=finite(limits.minQualityScore,"Minimum quality",{min:0,max:1});
 return candidates.map(candidate=>{
  const samples=Number(candidate.samples||0),cost=Number(candidate.avgCostMinor),latency=Number(candidate.p95LatencyMs),quality=Number(candidate.avgQualityScore);
  const eligible=Number.isSafeInteger(samples)&&samples>=20&&Number.isFinite(cost)&&cost>=0&&Number.isFinite(latency)&&latency>0&&Number.isFinite(quality)&&
   cost<=maxCost&&latency<=maxLatency&&quality>=minQuality;
  const score=eligible?quality*0.6+(1-cost/maxCost)*0.25+(1-latency/maxLatency)*0.15:null;
  return {...candidate,eligible,score};
 }).sort((a,b)=>(Number(b.eligible)-Number(a.eligible))||(Number(b.score??-1)-Number(a.score??-1))||
  (Number(a.avgCostMinor)-Number(b.avgCostMinor))||(Number(a.p95LatencyMs)-Number(b.p95LatencyMs))||
  String(a.provider).localeCompare(String(b.provider))||String(a.model).localeCompare(String(b.model)));
}
export function normalizeShadowRoutingRequest(input={}){
 const operation=String(input.operation||"");
 const currency=String(input.currency||"").toUpperCase();
 const maxCostMinor=finite(input.maxCostMinor,"Maximum cost",{integer:true,min:1});
 const maxLatencyMs=finite(input.maxLatencyMs,"Maximum latency",{integer:true,min:1,max:86_400_000});
 const minQualityScore=finite(input.minQualityScore,"Minimum quality",{min:0,max:1});
 const idempotencyKey=String(input.idempotencyKey||"").trim();
 if(!OPERATIONS.has(operation)||!CURRENCY.test(currency))throw invalid("MODEL_ROUTE_REQUEST_INVALID","A supported operation and ISO currency are required.");
 if(idempotencyKey.length<8||idempotencyKey.length>180)throw invalid("MODEL_ROUTE_IDEMPOTENCY_INVALID","Shadow routing idempotency key must contain 8 to 180 characters.");
 return {operation,currency,maxCostMinor,maxLatencyMs,minQualityScore,idempotencyKey};
}
export const RESOURCE_TYPES=Object.freeze(Object.keys(RESOURCE_UNITS));
