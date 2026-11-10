import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {createFinancialAuditEvent} from "../financial-audit-ledger.mjs";
import {exportFinancialAuditBundle,verifyFinancialAuditExport} from "../financial-audit-export.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const actor="22222222-2222-4222-8222-222222222222";
const at="2026-11-10T12:00:00.000Z";
function records(){
 const a=createFinancialAuditEvent({ownerId:owner,actorId:actor,eventType:"close_period.created",payload:{period:"2026-10"},idempotencyKey:"export-period-2026-10",occurredAt:at,sequence:1});
 const b=createFinancialAuditEvent({ownerId:owner,actorId:actor,eventType:"close_approval.recorded",payload:{decision:"approved"},idempotencyKey:"export-approval-2026-10",occurredAt:at,sequence:2,previousHash:a.eventHash});
 return {events:[{event_envelope:Object.fromEntries(Object.entries(a).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),event_hash:a.eventHash},{event_envelope:Object.fromEntries(Object.entries(b).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),event_hash:b.eventHash}],head:{sequence:2,headHash:b.eventHash}};
}
test("unsigned export preserves a complete verifiable chain and clearly declares missing signature",()=>{
 const {events,head}=records();const bundle=exportFinancialAuditBundle({ownerId:owner,events,head,exportedAt:at});
 const result=verifyFinancialAuditExport(bundle);
 assert.equal(bundle.signature.status,"unsigned_key_not_configured");
 assert.equal(bundle.eventCount,2);
 assert.equal(result.valid,true);
 assert.equal(result.manifestValid,true);
 assert.equal(result.chainValid,true);
 assert.equal(result.complete,true);
 assert.equal(result.signatureStatus,"unsigned");
});
test("Ed25519-signed export verifies with the independently trusted public key",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const {events,head}=records();
 const bundle=exportFinancialAuditBundle({ownerId:owner,events,head,exportedAt:at,signingPrivateKey:privateKey.export({type:"pkcs8",format:"pem"})});
 const trusted=publicKey.export({type:"spki",format:"pem"}).toString();
 const result=verifyFinancialAuditExport(bundle,{trustedPublicKeyPem:trusted});
 assert.equal(bundle.signature.status,"signed");
 assert.equal(result.valid,true);
 assert.equal(result.signatureStatus,"trusted_key_verified");
});
test("tampered events and manifest metadata invalidate the export",()=>{
 const {events,head}=records();const bundle=exportFinancialAuditBundle({ownerId:owner,events,head,exportedAt:at});
 const tampered=structuredClone(bundle);tampered.events[0].eventEnvelope.payload.period="2026-09";
 const result=verifyFinancialAuditExport(tampered);
 assert.equal(result.valid,false);
 assert.equal(result.manifestValid,false);
});
test("a signed bundle with an untrusted substituted key is rejected",()=>{
 const pair=generateKeyPairSync("ed25519"),other=generateKeyPairSync("ed25519");
 const {events,head}=records();
 const bundle=exportFinancialAuditBundle({ownerId:owner,events,head,exportedAt:at,signingPrivateKey:pair.privateKey.export({type:"pkcs8",format:"pem"})});
 const wrong=other.publicKey.export({type:"spki",format:"pem"}).toString();
 const result=verifyFinancialAuditExport(bundle,{trustedPublicKeyPem:wrong});
 assert.equal(result.valid,false);
 assert.equal(result.signatureStatus,"invalid");
});
test("incomplete export is not represented as a complete verified chain",()=>{
 const {events,head}=records();
 const bundle=exportFinancialAuditBundle({ownerId:owner,events:events.slice(0,1),head,exportedAt:at});
 const result=verifyFinancialAuditExport(bundle);
 assert.equal(result.valid,false);
 assert.equal(result.complete,false);
});
test("exports reject excessive rows and invalid signing key types",()=>{
 const {events,head}=records();
 assert.throws(()=>exportFinancialAuditBundle({ownerId:owner,events:Array(5001).fill(events[0]),head}),{code:"FINANCIAL_AUDIT_EXPORT_LIMIT"});
 assert.throws(()=>exportFinancialAuditBundle({ownerId:owner,events,head,signingPrivateKey:"not-a-key"}));
});
