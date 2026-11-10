import { createHash, randomUUID } from "node:crypto";

const GENESIS="0".repeat(64);
const VERSION=1;
const ALLOWED=new Set([
 "close_period.created","close_task.assigned","close_task.started","close_task.submitted","close_task.approved","close_task.rejected","close_task.completed","close_period.submitted","close_period.approved","close_period.locked",
 "close_task.waived","reconciliation.reviewed","close_approval.recorded",
 "close_period.reopened","evidence.attached","evidence.retention_changed"
]);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const plain=(v)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
function normalize(value,depth=0){
 if(depth>12)fail("FINANCIAL_AUDIT_PAYLOAD_DEPTH","Audit payload exceeds the maximum nesting depth.");
 if(value===null||typeof value==="string"||typeof value==="boolean")return value;
 if(typeof value==="number"){if(!Number.isSafeInteger(value))fail("FINANCIAL_AUDIT_NUMBER_INVALID","Audit payload numbers must be safe integers; encode decimals as strings.");return value;}
 if(Array.isArray(value)){if(value.length>200)fail("FINANCIAL_AUDIT_ARRAY_LIMIT","Audit payload arrays are limited to 200 entries.");return value.map(v=>normalize(v,depth+1));}
 if(plain(value)){
  const keys=Object.keys(value);if(keys.length>100)fail("FINANCIAL_AUDIT_OBJECT_LIMIT","Audit payload objects are limited to 100 properties.");
  const out={};for(const key of keys.sort()){if(["__proto__","prototype","constructor"].includes(key))fail("FINANCIAL_AUDIT_KEY_INVALID","Unsafe audit payload property.");out[key]=normalize(value[key],depth+1);}return out;
 }
 fail("FINANCIAL_AUDIT_PAYLOAD_INVALID","Audit payload must contain only JSON-safe values.");
}
export function canonicalFinancialAuditJson(value){return JSON.stringify(normalize(value));}
export function createFinancialAuditEvent({ownerId,actorId=ownerId,eventType,payload={},idempotencyKey,occurredAt=new Date().toISOString(),sequence,previousHash=GENESIS,eventId=randomUUID()}={}){
 if(typeof ownerId!=="string"||!ownerId.trim())fail("FINANCIAL_AUDIT_OWNER_REQUIRED","A financial audit owner is required.");
 if(typeof actorId!=="string"||!actorId.trim())fail("FINANCIAL_AUDIT_ACTOR_REQUIRED","A financial audit actor is required.");
 if(!ALLOWED.has(eventType))fail("FINANCIAL_AUDIT_EVENT_TYPE_INVALID","Unsupported financial audit event type.");
 if(typeof idempotencyKey!=="string"||idempotencyKey.trim().length<8||idempotencyKey.length>160||!/^[A-Za-z0-9:_-]+$/.test(idempotencyKey))fail("FINANCIAL_AUDIT_IDEMPOTENCY_INVALID","Provide an 8–160 character idempotency key using letters, numbers, colon, underscore or hyphen.");
 if(!Number.isSafeInteger(sequence)||sequence<1)fail("FINANCIAL_AUDIT_SEQUENCE_INVALID","Audit sequence must be a positive safe integer.");
 if(!/^[a-f0-9]{64}$/.test(previousHash))fail("FINANCIAL_AUDIT_PREVIOUS_HASH_INVALID","Previous audit hash must be a SHA-256 digest.");
 const time=Date.parse(occurredAt);if(!Number.isFinite(time)||new Date(time).toISOString()!==occurredAt)fail("FINANCIAL_AUDIT_TIMESTAMP_INVALID","Audit timestamp must be a canonical ISO-8601 UTC timestamp.");
 const event={canonicalizationVersion:VERSION,hashAlgorithm:"SHA-256",eventId,sequence,ownerId,actorId,eventType,occurredAt,payload:normalize(payload),idempotencyKey,previousHash};
 const canonical=canonicalFinancialAuditJson(event);
 if(Buffer.byteLength(canonical,"utf8")>16384)fail("FINANCIAL_AUDIT_EVENT_TOO_LARGE","A financial audit event cannot exceed 16 KiB.");
 const eventHash=createHash("sha256").update(canonical,"utf8").digest("hex");
 return {...event,eventHash,canonicalEvent:canonical};
}
export function verifyFinancialAuditChain(rows,{ownerId=null,expectedHead=null}={}){
 if(!Array.isArray(rows))fail("FINANCIAL_AUDIT_ROWS_INVALID","Audit chain rows must be an array.");
 let previous=GENESIS,expectedSequence=1,firstBroken=null;
 const seen=new Set(),verified=[];
 for(const row of rows){
  const event=row.eventEnvelope||row.event_envelope||row;
  const sequence=Number(event.sequence??row.sequence_number);
  const suppliedHash=String(row.eventHash??row.event_hash??"").toLowerCase();
  const previousHash=String(event.previousHash??row.previous_hash??"").toLowerCase();
  const idempotency=String(event.idempotencyKey??row.idempotency_key??"");
  const canonical=canonicalFinancialAuditJson(event);
  const computed=createHash("sha256").update(canonical,"utf8").digest("hex");
  let reason=null;
  if(!Number.isSafeInteger(sequence)||sequence!==expectedSequence)reason="sequence_gap";
  else if(ownerId&&event.ownerId!==ownerId)reason="owner_scope_mismatch";
  else if(previousHash!==previous)reason="previous_hash_mismatch";
  else if(!/^[a-f0-9]{64}$/.test(suppliedHash)||computed!==suppliedHash)reason="event_hash_mismatch";
  else if(seen.has(idempotency))reason="duplicate_idempotency_key";
  if(reason){firstBroken={sequence:Number.isFinite(sequence)?sequence:expectedSequence,reason};break;}
  seen.add(idempotency);verified.push({sequence,eventId:event.eventId,eventType:event.eventType,eventHash:suppliedHash});previous=suppliedHash;expectedSequence++;
 }
 if(!firstBroken&&expectedHead&&expectedHead!==previous)firstBroken={sequence:expectedSequence-1,reason:"trusted_head_mismatch"};
 return {valid:!firstBroken,verifiedCount:verified.length,firstBroken,headSequence:expectedSequence-1,headHash:previous,genesisHash:GENESIS,canonicalizationVersion:VERSION,hashAlgorithm:"SHA-256",limitations:["Verification proves consistency of the supplied chain only; a trusted independently retained checkpoint is needed to detect full-history replacement.","This verifier does not independently authenticate actor identities or external evidence files."]};
}
export const FINANCIAL_AUDIT_EVENT_TYPES=[...ALLOWED];
