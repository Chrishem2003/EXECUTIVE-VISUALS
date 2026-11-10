import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialAuditEvent,verifyFinancialAuditChain,canonicalFinancialAuditJson} from "../financial-audit-ledger.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const actor="22222222-2222-4222-8222-222222222222";
const at="2026-11-10T12:00:00.000Z";
function chain(){
 const first=createFinancialAuditEvent({ownerId:owner,actorId:actor,eventType:"close_period.created",payload:{period:"2026-10",currency:"UGX"},idempotencyKey:"close-created-2026-10",occurredAt:at,sequence:1});
 const second=createFinancialAuditEvent({ownerId:owner,actorId:actor,eventType:"close_task.assigned",payload:{taskId:"cash",assignee:actor},idempotencyKey:"close-task-cash-assign",occurredAt:at,sequence:2,previousHash:first.eventHash});
 return [first,second];
}
test("canonical serialization sorts object keys and preserves array order",()=>{
 assert.equal(canonicalFinancialAuditJson({z:1,a:{y:2,x:3}}),'{"a":{"x":3,"y":2},"z":1}');
 assert.notEqual(canonicalFinancialAuditJson({items:[1,2]}),canonicalFinancialAuditJson({items:[2,1]}));
});
test("valid event chain verifies sequence, predecessor hashes and event digests",()=>{
 const events=chain();const result=verifyFinancialAuditChain(events.map(e=>({eventEnvelope:Object.fromEntries(Object.entries(e).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),eventHash:e.eventHash})),{ownerId:owner});
 assert.equal(result.valid,true);assert.equal(result.verifiedCount,2);assert.equal(result.headSequence,2);assert.equal(result.headHash,events[1].eventHash);
});
test("modified payload is detected at the first altered event",()=>{
 const events=chain();const rows=events.map(e=>({eventEnvelope:Object.fromEntries(Object.entries(e).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),eventHash:e.eventHash}));
 rows[0].eventEnvelope.payload.period="2026-09";
 const result=verifyFinancialAuditChain(rows,{ownerId:owner});
 assert.equal(result.valid,false);assert.equal(result.firstBroken.sequence,1);assert.equal(result.firstBroken.reason,"event_hash_mismatch");
});
test("deleted, reordered or forked entries are detected",()=>{
 const events=chain();const rows=events.map(e=>({eventEnvelope:Object.fromEntries(Object.entries(e).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),eventHash:e.eventHash}));
 assert.equal(verifyFinancialAuditChain([rows[1]],{ownerId:owner}).firstBroken.reason,"sequence_gap");
 assert.equal(verifyFinancialAuditChain(rows,{ownerId:"33333333-3333-4333-8333-333333333333"}).firstBroken.reason,"owner_scope_mismatch");
 const fork=createFinancialAuditEvent({ownerId:owner,actorId:actor,eventType:"evidence.attached",payload:{evidenceId:"e-1"},idempotencyKey:"forked-event-key",occurredAt:at,sequence:2,previousHash:"f".repeat(64)});
 assert.equal(verifyFinancialAuditChain([rows[0],{eventEnvelope:Object.fromEntries(Object.entries(fork).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),eventHash:fork.eventHash}],{ownerId:owner}).firstBroken.reason,"previous_hash_mismatch");
});
test("trusted head detects a completely recomputed replacement chain",()=>{
 const events=chain();const rows=events.map(e=>({eventEnvelope:Object.fromEntries(Object.entries(e).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),eventHash:e.eventHash}));
 assert.equal(verifyFinancialAuditChain(rows,{ownerId:owner,expectedHead:"a".repeat(64)}).firstBroken.reason,"trusted_head_mismatch");
});
test("event creation rejects unsafe payloads, unsupported event types and invalid idempotency",()=>{
 assert.throws(()=>createFinancialAuditEvent({ownerId:owner,eventType:"ledger.delete",idempotencyKey:"valid-key-001",occurredAt:at,sequence:1}),{code:"FINANCIAL_AUDIT_EVENT_TYPE_INVALID"});
 assert.throws(()=>createFinancialAuditEvent({ownerId:owner,eventType:"close_period.created",idempotencyKey:"short",occurredAt:at,sequence:1}),{code:"FINANCIAL_AUDIT_IDEMPOTENCY_INVALID"});
 assert.throws(()=>createFinancialAuditEvent({ownerId:owner,eventType:"close_period.created",idempotencyKey:"valid-key-001",occurredAt:at,sequence:1,payload:{amount:1.25}}),{code:"FINANCIAL_AUDIT_NUMBER_INVALID"});
 assert.throws(()=>createFinancialAuditEvent({ownerId:owner,eventType:"close_period.created",idempotencyKey:"valid-key-001",occurredAt:at,sequence:1,payload:JSON.parse('{"__proto__":{"polluted":true}}')}),{code:"FINANCIAL_AUDIT_KEY_INVALID"});
});
test("repeated idempotency keys are detected during verification",()=>{
 const first=chain()[0];const duplicate=createFinancialAuditEvent({ownerId:owner,actorId:actor,eventType:"close_task.assigned",payload:{taskId:"other"},idempotencyKey:first.idempotencyKey,occurredAt:at,sequence:2,previousHash:first.eventHash});
 const rows=[first,duplicate].map(e=>({eventEnvelope:Object.fromEntries(Object.entries(e).filter(([k])=>!["eventHash","canonicalEvent"].includes(k))),eventHash:e.eventHash}));
 assert.equal(verifyFinancialAuditChain(rows,{ownerId:owner}).firstBroken.reason,"duplicate_idempotency_key");
});
