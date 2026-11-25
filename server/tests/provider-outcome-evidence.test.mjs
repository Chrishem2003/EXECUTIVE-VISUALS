import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyProviderOutcomeEvidence } from "../provider-outcome-evidence.mjs";

const secret="test-only-provider-adapter-secret-with-32-bytes-minimum";
const expected={provider:"runway",providerAccountId:"acct-01",providerTaskId:"task-01",jobId:"job-01",model:"seedance-2.5",route:"runway-dev"};
function envelope(overrides={}){
 const value={
  evidenceId:"evt-01",provider:"runway",providerAccountId:"acct-01",
  providerTaskId:"task-01",jobId:"job-01",model:"seedance-2.5",route:"runway-dev",
  outcome:"charged",finalState:"succeeded",currency:"USD",amountMinor:340,
  billableSeconds:5,inputReferenceCount:0,audioEnabled:true,
  sourceReference:"provider-usage-export:line-01",
  observedAt:"2026-11-25T12:00:00.000Z",...overrides
 };
 const canonical=(v)=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?"["+v.map(canonical).join(",")+"]":"{"+Object.keys(v).filter(k=>k!=="signature").sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";
 value.signature=createHmac("sha256",secret).update(canonical(value)).digest("hex");
 return value;
}
const options=(value,extra={})=>({envelope:value,secret,expected,now:Date.parse("2026-11-25T12:01:00.000Z"),...extra});

test("accepts authenticated charged outcome bound to the server task identity",()=>{
 const result=verifyProviderOutcomeEvidence(options(envelope()));
 assert.equal(result.settlementEligible,true);
 assert.equal(result.releaseEligible,false);
 assert.equal(result.amountMinor,340);
 assert.equal(result.idempotencyKey,"provider-outcome:runway:task-01:evt-01");
});

test("accepts authenticated no-charge evidence only when amount and billable usage are zero",()=>{
 const result=verifyProviderOutcomeEvidence(options(envelope({outcome:"no_charge",amountMinor:0,billableSeconds:0,finalState:"cancelled"})));
 assert.equal(result.releaseEligible,true);
 assert.equal(result.settlementEligible,false);
});

test("unknown provider outcome remains reconciliation-only",()=>{
 const result=verifyProviderOutcomeEvidence(options(envelope({outcome:"unknown",amountMinor:null,billableSeconds:0,finalState:"failed"})));
 assert.equal(result.reconciliationRequired,true);
 assert.equal(result.releaseEligible,false);
 assert.equal(result.settlementEligible,false);
});

test("rejects tampered evidence",()=>{
 const value=envelope();value.amountMinor=1;
 assert.throws(()=>verifyProviderOutcomeEvidence(options(value)),{code:"PROVIDER_OUTCOME_SIGNATURE_INVALID"});
});

test("rejects caller-supplied identity that differs from the persisted task",()=>{
 assert.throws(()=>verifyProviderOutcomeEvidence(options(envelope(),{expected:{...expected,providerTaskId:"another-task"}})),{code:"PROVIDER_OUTCOME_IDENTITY_MISMATCH"});
});

test("rejects unverified no-charge claims with nonzero billing",()=>{
 assert.throws(()=>verifyProviderOutcomeEvidence(options(envelope({outcome:"no_charge",amountMinor:0,billableSeconds:1,finalState:"cancelled"}))),{code:"PROVIDER_OUTCOME_NO_CHARGE_INVALID"});
});

test("rejects stale or future-dated evidence",()=>{
 assert.throws(()=>verifyProviderOutcomeEvidence(options(envelope(),{now:Date.parse("2027-02-01T00:00:00.000Z")})),{code:"PROVIDER_OUTCOME_EVIDENCE_STALE"});
 assert.throws(()=>verifyProviderOutcomeEvidence(options(envelope(),{now:Date.parse("2026-11-25T11:00:00.000Z")})),{code:"PROVIDER_OUTCOME_EVIDENCE_STALE"});
});

test("rejects short verifier secrets",()=>{
 assert.throws(()=>verifyProviderOutcomeEvidence({...options(envelope()),secret:"short"}),{code:"PROVIDER_OUTCOME_VERIFIER_NOT_CONFIGURED"});
});
