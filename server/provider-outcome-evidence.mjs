import { createHmac, timingSafeEqual } from "node:crypto";

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const HASH=/^[a-f0-9]{64}$/;
const CURRENCY=/^[A-Z]{3}$/;
const OUTCOMES=new Set(["charged","no_charge","unknown"]);
const STATES=new Set(["succeeded","failed","cancelled"]);
const MAX_SECONDS=7*24*60*60;

function requiredText(value,label,max=180){
 if(typeof value!=="string"||!value.trim()||value.trim().length>max||!IDENTIFIER.test(value.trim()))
  fail("PROVIDER_OUTCOME_FIELD_INVALID",label+" is missing or invalid.");
 return value.trim();
}
function safeInteger(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={}){
 if(!Number.isSafeInteger(value)||value<min||value>max)
  fail("PROVIDER_OUTCOME_FIELD_INVALID",label+" must be a safe integer in range.");
 return value;
}
function canonical(value){
 if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"){
  if(!Number.isSafeInteger(value))fail("PROVIDER_OUTCOME_PAYLOAD_INVALID","Evidence numbers must be safe integers.");
  return String(value);
 }
 if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
 if(value&&typeof value==="object"){
  const keys=Object.keys(value).filter(k=>k!=="signature").sort();
  return "{"+keys.map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
 }
 fail("PROVIDER_OUTCOME_PAYLOAD_INVALID","Evidence must contain JSON-safe values.");
}

/**
 * Verifies an adapter-authenticated provider outcome envelope.
 * The secret must come from server-side provider adapter configuration; never
 * accept it, or a pre-verified boolean, from a customer/API request.
 */
export function verifyProviderOutcomeEvidence({envelope,secret,expected,maxAgeMs=30*24*60*60*1000,now=Date.now()}={}){
 if(!envelope||typeof envelope!=="object"||Array.isArray(envelope))
  fail("PROVIDER_OUTCOME_ENVELOPE_INVALID","A provider outcome envelope is required.");
 if(typeof secret!=="string"||Buffer.byteLength(secret,"utf8")<32)
  fail("PROVIDER_OUTCOME_VERIFIER_NOT_CONFIGURED","Provider outcome verifier secret must contain at least 32 bytes.");
 if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<60_000||maxAgeMs>90*24*60*60*1000)
  fail("PROVIDER_OUTCOME_MAX_AGE_INVALID","Evidence maximum age is outside the permitted range.");
 if(!Number.isSafeInteger(now)||now<0)fail("PROVIDER_OUTCOME_CLOCK_INVALID","A valid verification clock is required.");

 const evidenceId=requiredText(envelope.evidenceId,"evidenceId");
 const provider=requiredText(envelope.provider,"provider",80).toLowerCase();
 const providerAccountId=requiredText(envelope.providerAccountId,"providerAccountId");
 const providerTaskId=requiredText(envelope.providerTaskId,"providerTaskId");
 const jobId=requiredText(envelope.jobId,"jobId");
 const model=requiredText(envelope.model,"model");
 const route=requiredText(envelope.route,"route");
 const sourceReference=requiredText(envelope.sourceReference,"sourceReference");
 const outcome=String(envelope.outcome||"");
 const finalState=String(envelope.finalState||"");
 if(!OUTCOMES.has(outcome)||!STATES.has(finalState))
  fail("PROVIDER_OUTCOME_CLASSIFICATION_INVALID","Provider outcome or terminal state is unsupported.");
 const currency=String(envelope.currency||"").toUpperCase();
 if(!CURRENCY.test(currency))fail("PROVIDER_OUTCOME_CURRENCY_INVALID","A three-letter ISO currency is required.");
 const amountMinor=envelope.amountMinor===null?null:safeInteger(envelope.amountMinor,"amountMinor");
 const billableSeconds=safeInteger(envelope.billableSeconds,"billableSeconds",{max:MAX_SECONDS});
 const inputReferenceCount=safeInteger(envelope.inputReferenceCount,"inputReferenceCount",{max:1000});
 if(typeof envelope.audioEnabled!=="boolean")fail("PROVIDER_OUTCOME_FIELD_INVALID","audioEnabled must be boolean.");
 if(outcome==="charged"&&(amountMinor===null||amountMinor<1))
  fail("PROVIDER_OUTCOME_AMOUNT_INVALID","A charged outcome requires a positive actual amount.");
 if(outcome==="no_charge"&&(amountMinor!==0||billableSeconds!==0))
  fail("PROVIDER_OUTCOME_NO_CHARGE_INVALID","A no-charge outcome must report zero amount and zero billable seconds.");
 if(outcome==="unknown"&&amountMinor!==null)
  fail("PROVIDER_OUTCOME_UNKNOWN_INVALID","An unknown outcome must not claim an actual amount.");
 const observedAt=String(envelope.observedAt||"");
 const observedMs=Date.parse(observedAt);
 if(!Number.isFinite(observedMs)||new Date(observedMs).toISOString()!==observedAt)
  fail("PROVIDER_OUTCOME_TIMESTAMP_INVALID","observedAt must be canonical ISO-8601 UTC.");
 if(observedMs>now+5*60_000||now-observedMs>maxAgeMs)
  fail("PROVIDER_OUTCOME_EVIDENCE_STALE","Provider outcome evidence is outside the permitted freshness window.");

 if(!expected||typeof expected!=="object"||
    String(expected.provider||"").toLowerCase()!==provider||
    expected.providerAccountId!==providerAccountId||
    expected.providerTaskId!==providerTaskId||expected.jobId!==jobId||
    expected.model!==model||expected.route!==route)
  fail("PROVIDER_OUTCOME_IDENTITY_MISMATCH","Evidence does not match the server-recorded provider task identity.");

 const supplied=String(envelope.signature||"").toLowerCase();
 if(!HASH.test(supplied))fail("PROVIDER_OUTCOME_SIGNATURE_INVALID","A SHA-256 HMAC signature is required.");
 const digest=createHmac("sha256",secret).update(canonical(envelope),"utf8").digest("hex");
 const a=Buffer.from(supplied,"hex"),b=Buffer.from(digest,"hex");
 if(a.length!==b.length||!timingSafeEqual(a,b))
  fail("PROVIDER_OUTCOME_SIGNATURE_INVALID","Provider outcome signature verification failed.");

 return Object.freeze({
  evidenceId,provider,providerAccountId,providerTaskId,jobId,model,route,
  outcome,finalState,currency,amountMinor,billableSeconds,inputReferenceCount,
  audioEnabled,sourceReference,observedAt,signatureAlgorithm:"HMAC-SHA256",
  evidenceDigest:digest,
  idempotencyKey:"provider-outcome:"+provider+":"+providerTaskId+":"+evidenceId,
  verifiedNoCharge:outcome==="no_charge",
  chargeConfirmed:outcome==="charged",
  reconciliationRequired:outcome==="unknown"
 });
}
