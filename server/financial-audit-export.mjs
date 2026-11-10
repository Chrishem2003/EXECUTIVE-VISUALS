import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { canonicalFinancialAuditJson, verifyFinancialAuditChain } from "./financial-audit-ledger.mjs";

const digest=value=>createHash("sha256").update(canonicalFinancialAuditJson(value),"utf8").digest("hex");
const keyText=value=>typeof value==="string"?value.replace(/\\n/g,"\n").trim():value;
export function exportFinancialAuditBundle({ownerId,events=[],head={sequence:0,headHash:"0".repeat(64)},exportedAt=new Date().toISOString(),signingPrivateKey=null}={}){
 if(typeof ownerId!=="string"||!ownerId.trim())throw Object.assign(new Error("A verified audit owner is required."),{code:"FINANCIAL_AUDIT_EXPORT_OWNER_INVALID"});
 if(!Array.isArray(events)||events.length>5000)throw Object.assign(new Error("Audit exports are limited to 5,000 events per bundle."),{code:"FINANCIAL_AUDIT_EXPORT_LIMIT"});
 const normalized=events.map(row=>({eventEnvelope:row.event_envelope||row.eventEnvelope,eventHash:row.event_hash||row.eventHash,sequence_number:row.sequence_number,previous_hash:row.previous_hash,idempotency_key:row.idempotency_key}));
 const verification=verifyFinancialAuditChain(normalized,{ownerId,expectedHead:head.headHash||"0".repeat(64)});
 const complete=Number(head.sequence||0)===normalized.length;
 const unsigned={
  format:"executive-visuals.financial-audit-export",
  formatVersion:1,
  ownerId,
  exportedAt,
  head:{sequence:Number(head.sequence||0),headHash:head.headHash||"0".repeat(64)},
  eventCount:normalized.length,
  events:normalized.map(row=>({eventEnvelope:row.eventEnvelope,eventHash:row.eventHash})),
  verification:{...verification,valid:verification.valid&&complete,complete}
 };
 const manifestSha256=digest(unsigned);
 let signature={status:"unsigned_key_not_configured",algorithm:"Ed25519",publicKeyPem:null,value:null};
 if(signingPrivateKey){
  const privateKey=keyText(signingPrivateKey);
  const publicKey=createPublicKey(privateKey);
  if(publicKey.asymmetricKeyType!=="ed25519")throw Object.assign(new Error("Financial audit signing key must be Ed25519."),{code:"FINANCIAL_AUDIT_SIGNING_KEY_INVALID"});
  const signatureValue=sign(null,Buffer.from(manifestSha256,"hex"),privateKey).toString("base64");
  signature={status:"signed",algorithm:"Ed25519",publicKeyPem:publicKey.export({type:"spki",format:"pem"}).toString(),value:signatureValue};
 }
 return {...unsigned,manifestSha256,signature};
}
export function verifyFinancialAuditExport(bundle,{trustedPublicKeyPem=null}={}){
 if(!bundle||bundle.format!=="executive-visuals.financial-audit-export"||bundle.formatVersion!==1)throw Object.assign(new Error("Unsupported financial audit export format."),{code:"FINANCIAL_AUDIT_EXPORT_FORMAT_INVALID"});
 const {manifestSha256,signature,...unsigned}=bundle;
 const computed=digest(unsigned);
 const manifestValid=typeof manifestSha256==="string"&&computed===manifestSha256;
 const events=(bundle.events||[]).map(row=>({eventEnvelope:row.eventEnvelope,eventHash:row.eventHash}));
 const chain=verifyFinancialAuditChain(events,{ownerId:bundle.ownerId,expectedHead:bundle.head?.headHash});
 const complete=Number(bundle.head?.sequence||0)===events.length;
 let signatureStatus="unsigned";
 if(signature?.status==="signed"){
  const suppliedKey=trustedPublicKeyPem?keyText(trustedPublicKeyPem):signature.publicKeyPem;
  const keyMatches=!trustedPublicKeyPem||keyText(trustedPublicKeyPem)===keyText(signature.publicKeyPem);
  let valid=false;
  try{valid=verify(null,Buffer.from(manifestSha256||"","hex"),createPublicKey(suppliedKey),Buffer.from(signature.value||"","base64"));}catch{}
  signatureStatus=valid&&keyMatches?(trustedPublicKeyPem?"trusted_key_verified":"valid_untrusted_embedded_key"):"invalid";
 }
 return {valid:manifestValid&&chain.valid&&complete&&signatureStatus!=="invalid",manifestValid,chainValid:chain.valid,complete,signatureStatus,manifestSha256:computed,eventCount:events.length,head:bundle.head,firstBroken:chain.firstBroken,limitations:["An embedded public key proves signature consistency, not signer identity; supply an independently trusted public key to establish signer trust.","Unsigned bundles provide integrity checks but no signer authentication.","This export cannot prove that the source database was not wholly replaced before export without a previously trusted external checkpoint."]};
}
