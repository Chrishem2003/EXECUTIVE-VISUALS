const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS=/^[a-z0-9][a-z0-9._-]{1,79}$/;
const OPERATIONS=new Set(["text","image","video","render","upscale","audio","embedding","other"]);
const SOURCES=new Set(["provider_response","worker_measurement","invoice_reconciliation","admin_import"]);
const RESOLUTIONS=new Set(["unknown","360p","480p","540p","720p","1080p","1440p","2160p","4k","custom"]);
const DIMENSIONS=Object.freeze([
 "inputAudioTokens","outputAudioTokens","cachedInputTokens","reasoningTokens",
 "inputImageCount","outputImageCount","referenceImageCount","referenceVideoSeconds",
 "generatedVideoSeconds","renderSeconds","upscaleImageCount","framesProcessed",
 "acceptedOutputs","rejectedOutputs","retryCount","attemptCount","latencyMs",
 "cpuSeconds","gpuSeconds","storageGbSeconds","egressBytes"
]);
function invalid(code,message){return Object.assign(new Error(message),{code});}
function numeric(value,key,{integer=false,max=1e15}={}){
 if(value===undefined||value===null||value==="")return 0;
 const n=Number(value);
 if(!Number.isFinite(n)||n<0||n>max||(integer&&!Number.isSafeInteger(n)))throw invalid("WORKLOAD_TELEMETRY_VALUE_INVALID",key+" must be a non-negative "+(integer?"safe integer":"finite number")+".");
 return n;
}
export function normalizeWorkloadTelemetry(input={}){
 const occurredAt=String(input.occurredAt||input.measuredAt||input.timestamp||new Date().toISOString());
 const provider=String(input.provider||"").trim().toLowerCase();
 const model=String(input.model||input.requestedModel||input.jobType||"").trim();
 const operation=String(input.operation||"other").trim().toLowerCase();
 const source=String(input.source||input.evidenceSource||"");
 const operationId=String(input.operationId||input.requestId||input.jobId||"").trim();
 const idempotencyKey=String(input.idempotencyKey||"").trim();
 if(!Number.isFinite(Date.parse(occurredAt)))throw invalid("WORKLOAD_TELEMETRY_TIMESTAMP_INVALID","Telemetry timestamp is invalid.");
 if(!PROVIDERS.test(provider)||!model||model.length>160||!OPERATIONS.has(operation))throw invalid("WORKLOAD_TELEMETRY_IDENTITY_INVALID","Provider, model and supported operation are required.");
 if(!SOURCES.has(source))throw invalid("WORKLOAD_TELEMETRY_SOURCE_INVALID","Telemetry source must identify provider, worker, invoice or admin evidence.");
 if(!operationId||operationId.length>180||idempotencyKey.length<8||idempotencyKey.length>180)throw invalid("WORKLOAD_TELEMETRY_IDEMPOTENCY_INVALID","Operation ID and an 8–180 character idempotency key are required.");
 for(const key of ["ownerId","projectId","jobId"])if(input[key]!=null&&input[key]!==""&&!UUID.test(String(input[key])))throw invalid("WORKLOAD_TELEMETRY_ATTRIBUTION_INVALID",key+" must be a valid UUID.");
 const raw=input.dimensions||{};
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).some(k=>!DIMENSIONS.includes(k)))throw invalid("WORKLOAD_TELEMETRY_DIMENSIONS_INVALID","Telemetry contains an unsupported dimension.");
 const dimensions={};
 for(const key of DIMENSIONS)dimensions[key]=numeric(raw[key],key,{integer:!["referenceVideoSeconds","generatedVideoSeconds","renderSeconds","cpuSeconds","gpuSeconds","storageGbSeconds"].includes(key)});
 const resolution=String(input.resolutionTier||"unknown").toLowerCase();
 if(!RESOLUTIONS.has(resolution))throw invalid("WORKLOAD_TELEMETRY_RESOLUTION_INVALID","Resolution tier is not supported.");
 const currency=input.currency==null||input.currency===""?null:String(input.currency).toUpperCase();
 if(currency!==null&&!/^[A-Z]{3}$/.test(currency))throw invalid("WORKLOAD_TELEMETRY_CURRENCY_INVALID","Currency must be an ISO 4217 code.");
 const providerCostMinor=input.providerCostMinor==null?null:numeric(input.providerCostMinor,"providerCostMinor",{integer:true,max:Number.MAX_SAFE_INTEGER});
 if(providerCostMinor!==null&&!currency)throw invalid("WORKLOAD_TELEMETRY_CURRENCY_REQUIRED","Provider-reported cost requires a currency.");
 const resourceType=String(input.resourceType||"").slice(0,60);
 const resourceUnit=String(input.resourceUnit||input.unit||"").slice(0,30);
 const resourceQuantity=input.resourceQuantity==null?null:numeric(input.resourceQuantity,"resourceQuantity");
 const evidenceReference=String(input.evidenceReference||"").slice(0,240);
 return {occurredAt,provider,model,operation,source,operationId,idempotencyKey,
  ownerId:input.ownerId||null,projectId:input.projectId||null,jobId:input.jobId||null,
  resolutionTier:resolution,currency,providerCostMinor,dimensions,resourceType,resourceUnit,
  resourceQuantity,evidenceReference};
}
