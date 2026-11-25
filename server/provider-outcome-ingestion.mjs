import { timingSafeEqual } from "node:crypto";
import { verifyProviderOutcomeEvidence } from "./provider-outcome-evidence.mjs";

const SCHEMA="executive_visuals";
const fail=(code,message,status=400)=>{throw Object.assign(new Error(message),{code,status});};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseObject(value,label){
 let parsed=value;
 if(typeof value==="string"){try{parsed=JSON.parse(value);}catch{fail("PROVIDER_OUTCOME_CONFIG_INVALID",label+" must be valid JSON.",503);}}
 if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))fail("PROVIDER_OUTCOME_CONFIG_INVALID",label+" must be a JSON object.",503);
 return parsed;
}
function requiredSecret(value,label){
 if(typeof value!=="string"||Buffer.byteLength(value,"utf8")<32)fail("PROVIDER_OUTCOME_INGESTION_NOT_CONFIGURED",label+" must contain at least 32 bytes.",503);
 return value;
}
function constantTimeEqual(left,right){
 const a=Buffer.from(String(left||""),"utf8"),b=Buffer.from(String(right||""),"utf8");
 return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
}
function normalizeBase(value){
 let parsed;try{parsed=new URL(value);}catch{fail("PROVIDER_OUTCOME_CONFIG_INVALID","Supabase URL must be an absolute URL.",503);}
 const local=["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname.toLowerCase());
 if((parsed.protocol!=="https:"&&!(local&&parsed.protocol==="http:"))||parsed.username||parsed.password||parsed.search||parsed.hash)
  fail("PROVIDER_OUTCOME_CONFIG_INVALID","Supabase URL must use HTTPS and contain no credentials, query or fragment.",503);
 return parsed.origin;
}
function minorToMicros(amountMinor,currency){
 if(amountMinor===null)return null;
 if(currency!=="USD")fail("PROVIDER_OUTCOME_CURRENCY_UNSUPPORTED","Provider outcome ingestion currently accepts USD evidence only; other currency exponent conversions are not configured.",422);
 const micros=amountMinor*10_000;
 if(!Number.isSafeInteger(micros))fail("PROVIDER_OUTCOME_AMOUNT_INVALID","Provider actual cost exceeds safe USD micro-unit precision.");
 return micros;
}
function safeConfigMap(value,label){
 const parsed=parseObject(value,label),result={};
 for(const [provider,item] of Object.entries(parsed)){
  if(!["runway","fal"].includes(provider)||typeof item!=="string"||!item.trim()||item.trim().length>180)
   fail("PROVIDER_OUTCOME_CONFIG_INVALID",label+" contains an unsupported provider or invalid value.",503);
  result[provider]=item.trim();
 }
 return Object.freeze(result);
}

/**
 * Server-to-server evidence ingestion. The bearer token authorizes the worker
 * channel; the independent adapter HMAC authenticates the provider evidence.
 * The task identity and expected account/route are loaded from trusted server
 * state, never accepted from the caller as an expected identity.
 */
export function createProviderOutcomeIngestion({
 supabaseUrl=process.env.SUPABASE_URL,
 serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVER_KEY,
 ingestToken=process.env.PROVIDER_OUTCOME_INGEST_TOKEN,
 verificationSecret=process.env.PROVIDER_OUTCOME_EVIDENCE_HMAC_SECRET,
 providerAccountIds=process.env.PROVIDER_OUTCOME_PROVIDER_ACCOUNT_IDS_JSON,
 providerRoutes=process.env.PROVIDER_OUTCOME_PROVIDER_ROUTES_JSON,
 adapterId=process.env.PROVIDER_OUTCOME_ADAPTER_ID,
 adapterVersion=process.env.PROVIDER_OUTCOME_ADAPTER_VERSION,
 maxAgeMs=Number(process.env.PROVIDER_OUTCOME_MAX_AGE_MS||30*24*60*60*1000),
 fetchImpl=globalThis.fetch,
 now=()=>Date.now(),
 timeoutMs=15000
}={}){
 const missing=[];
 if(!supabaseUrl||!serviceRoleKey)missing.push("Supabase server credentials");
 if(!ingestToken||Buffer.byteLength(String(ingestToken),"utf8")<32)missing.push("PROVIDER_OUTCOME_INGEST_TOKEN (32+ bytes)");
 if(!verificationSecret||Buffer.byteLength(String(verificationSecret),"utf8")<32)missing.push("PROVIDER_OUTCOME_EVIDENCE_HMAC_SECRET (32+ bytes)");
 if(!providerAccountIds)missing.push("PROVIDER_OUTCOME_PROVIDER_ACCOUNT_IDS_JSON");
 if(!providerRoutes)missing.push("PROVIDER_OUTCOME_PROVIDER_ROUTES_JSON");
 if(!adapterId||!adapterVersion)missing.push("provider adapter identity/version");
 if(missing.length)fail("PROVIDER_OUTCOME_INGESTION_NOT_CONFIGURED","Provider outcome ingestion is disabled: "+missing.join(", ")+".",503);
 if(typeof fetchImpl!=="function")fail("PROVIDER_OUTCOME_CONFIG_INVALID","Provider outcome ingestion requires fetch.",503);
 if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<60_000||maxAgeMs>90*24*60*60*1000)fail("PROVIDER_OUTCOME_CONFIG_INVALID","Provider outcome evidence max age must be between one minute and 90 days.",503);
 if(typeof adapterId!=="string"||!/^[A-Za-z0-9._:-]{1,100}$/.test(adapterId)||typeof adapterVersion!=="string"||!/^[A-Za-z0-9._:-]{1,80}$/.test(adapterVersion))
  fail("PROVIDER_OUTCOME_CONFIG_INVALID","Provider adapter identity/version is invalid.",503);
 const base=normalizeBase(supabaseUrl),accounts=safeConfigMap(providerAccountIds,"PROVIDER_OUTCOME_PROVIDER_ACCOUNT_IDS_JSON");
 const routes=safeConfigMap(providerRoutes,"PROVIDER_OUTCOME_PROVIDER_ROUTES_JSON");
 const key=String(serviceRoleKey),token=requiredSecret(String(ingestToken),"PROVIDER_OUTCOME_INGEST_TOKEN");
 const hmacSecret=requiredSecret(String(verificationSecret),"PROVIDER_OUTCOME_EVIDENCE_HMAC_SECRET");

 async function request(path,{method="GET",body}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:key,authorization:"Bearer "+key,accept:"application/json","accept-profile":SCHEMA,"content-profile":SCHEMA};
   if(body!==undefined)headers["content-type"]="application/json";
   const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
   const raw=await response.text();let data=null;
   if(raw){try{data=JSON.parse(raw);}catch{fail("PROVIDER_OUTCOME_REPOSITORY_INVALID_RESPONSE","Provider outcome repository returned non-JSON data.",502);}}
   if(!response.ok){
    const code=typeof data?.code==="string"&&/^[A-Z0-9_]{1,100}$/.test(data.code)?data.code:"PROVIDER_OUTCOME_REPOSITORY_FAILED";
    fail(code,"Provider outcome repository rejected the operation (HTTP "+response.status+").",response.status>=500?503:409);
   }
   return data;
  }catch(error){
   if(error?.name==="AbortError")fail("PROVIDER_OUTCOME_REPOSITORY_TIMEOUT","Provider outcome repository request timed out.",503);
   throw error;
  }finally{clearTimeout(timer);}
 }

 async function ingest({authorization,envelope}={}){
  const supplied=String(authorization||"").replace(/^Bearer\s+/i,"");
  if(!constantTimeEqual(supplied,token))fail("PROVIDER_OUTCOME_INGEST_UNAUTHORIZED","A valid server-to-server ingestion token is required.",401);
  if(!envelope||typeof envelope!=="object"||Array.isArray(envelope))fail("PROVIDER_OUTCOME_ENVELOPE_INVALID","A provider outcome envelope is required.");
  const taskId=String(envelope.taskId||"");
  if(!UUID.test(taskId))fail("PROVIDER_OUTCOME_TASK_ID_INVALID","A valid durable task ID is required.");
  const rows=await request("video_generation_tasks?select=id,job_id,provider,provider_task_id,model,state,estimated_cost_micros,currency&id=eq."+encodeURIComponent(taskId)+"&limit=1");
  if(!Array.isArray(rows)||rows.length!==1)fail("PROVIDER_OUTCOME_TASK_NOT_FOUND","The durable provider task was not found.",404);
  const task=rows[0],provider=String(task.provider||"").toLowerCase();
  if(!["runway","fal"].includes(provider)||!task.provider_task_id||!task.job_id||!task.model)
   fail("PROVIDER_OUTCOME_TASK_NOT_SUBMITTED","The durable task does not have a complete submitted provider identity.",409);
  const expectedAccount=accounts[provider],expectedRoute=routes[provider];
  if(!expectedAccount||!expectedRoute)fail("PROVIDER_OUTCOME_ADAPTER_NOT_CONFIGURED","The expected provider account and route are not configured for this provider.",503);
  const expected={provider,providerAccountId:expectedAccount,providerTaskId:task.provider_task_id,jobId:task.job_id,model:task.model,route:expectedRoute};
  const verified=verifyProviderOutcomeEvidence({envelope,secret:hmacSecret,expected,maxAgeMs,now:now()});
  if(verified.finalState!==task.state)
   fail("PROVIDER_OUTCOME_IDENTITY_MISMATCH","Provider terminal state does not match the durable task state.",409);
  if(verified.currency!==String(task.currency||"").toUpperCase())
   fail("PROVIDER_OUTCOME_CURRENCY_MISMATCH","Provider evidence currency does not match the approved task currency.",409);
  const actualCostMicros=minorToMicros(verified.amountMinor,verified.currency);
  const args={
   p_task_id:task.id,p_provider:verified.provider,p_provider_task_id:verified.providerTaskId,
   p_provider_account_id:verified.providerAccountId,p_model:verified.model,p_route:verified.route,
   p_evidence_id:verified.evidenceId,p_outcome:verified.outcome,p_final_state:verified.finalState,
   p_currency:verified.currency,p_actual_cost_micros:actualCostMicros,
   p_billable_seconds:verified.billableSeconds,p_input_reference_count:verified.inputReferenceCount,
   p_audio_enabled:verified.audioEnabled,p_source_reference:verified.sourceReference,
   p_observed_at:verified.observedAt,p_signature_algorithm:verified.signatureAlgorithm,
   p_evidence_digest:verified.evidenceDigest,p_adapter_id:adapterId,p_adapter_version:adapterVersion
  };
  const saved=await request("rpc/record_provider_outcome_evidence",{method:"POST",body:args});
  if(!Array.isArray(saved)||saved.length!==1)fail("PROVIDER_OUTCOME_PERSISTENCE_UNCONFIRMED","Provider outcome evidence was not durably confirmed.",503);
  const row=saved[0];
  return Object.freeze({
   accepted:true,evidenceRowId:row.evidence_row_id,replayed:row.replayed===true,
   provider:verified.provider,providerTaskId:verified.providerTaskId,outcome:verified.outcome,
   finalState:verified.finalState,currency:verified.currency,actualCostMicros:row.actual_cost_micros,
   estimatedCostMicros:row.estimated_cost_micros,varianceMicros:row.variance_micros,
   customerCreditsChanged:false,providerRequestsSubmitted:false
  });
 }
 return Object.freeze({enabled:true,ingest});
}
