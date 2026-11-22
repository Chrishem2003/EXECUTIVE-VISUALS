import test from "node:test";
import assert from "node:assert/strict";
import {
 createSubscriptionAllowanceApprovalPacket,evaluateSubscriptionAllowanceApprovals
} from "../subscription-allowance-approval.mjs";

const finance="11111111-1111-4111-8111-111111111111";
const product="22222222-2222-4222-8222-222222222222";
const evidence={
 status:"verified_measured",approved:false,source:"immutable posted invoice attribution",
 rateCardVersion:"invoice-attribution-derived-v1",sampleJobs:8,sampleCredits:8000,totalProviderCostMinor:800,evidenceDigest:"a".repeat(64),
 periodStart:"2026-10-01T00:00:00.000Z",periodEnd:"2026-11-01T00:00:00.000Z"
};
const base={
 plan:{planCode:"starter_creator",name:"Starter Creator",currency:"USD",monthlyPriceMinor:900},
 planVersion:3,allowanceCredits:80,providerCostPerCustomerCreditMinor:2,costEvidence:evidence,
 targetGrossMarginBps:7000,paymentFeeBps:350,refundReserveBps:200,
 fixedPaymentFeeMinor:30,supportReserveMinor:20,infrastructureReserveMinor:30
};
const approval=(stage,role,actorId,status="approved",proposalHash)=>{
 return {stage,role,actorId,status,proposalHash};
};

test("creates a deterministic, exact-plan approval packet without publishing or granting credits",()=>{
 const first=createSubscriptionAllowanceApprovalPacket(base);
 const second=createSubscriptionAllowanceApprovalPacket(base);
 assert.equal(first.proposalHash,second.proposalHash);
 assert.equal(first.status,"awaiting_dual_approval");
 assert.equal(first.publishable,false);
 assert.equal(first.proposal.includedCredits,80);
 assert.deepEqual(first.requiredApprovals.map(x=>[x.stage,x.role]),[
  ["finance","billing_admin"],["product","platform_admin"]
 ]);
});

test("requires at least five verified invoice-backed jobs and rejects browser-like unverified evidence",()=>{
 for(const costEvidence of [
  {...evidence,sampleJobs:4},
  {...evidence,evidenceDigest:"invalid"},
  {...evidence,sampleCredits:0},
  {...evidence,status:"forecast"},
  {...evidence,approved:true},
  {...evidence,source:""},
  {...evidence,periodEnd:evidence.periodStart}
 ]){
  assert.throws(()=>createSubscriptionAllowanceApprovalPacket({...base,costEvidence}),
   {code:"SUBSCRIPTION_ALLOWANCE_COST_EVIDENCE_INVALID"});
 }
});

test("requires both finance and product approvals for the same exact proposal hash",()=>{
 const packet=createSubscriptionAllowanceApprovalPacket(base);
 const one=evaluateSubscriptionAllowanceApprovals(packet,[
  approval("finance","billing_admin",finance,"approved",packet.proposalHash)
 ]);
 assert.equal(one.status,"awaiting_dual_approval");
 assert.equal(one.eligibleToPublish,false);
 const both=evaluateSubscriptionAllowanceApprovals(packet,[
  approval("finance","billing_admin",finance,"approved",packet.proposalHash),
  approval("product","platform_admin",product,"approved",packet.proposalHash)
 ]);
 assert.equal(both.status,"approved");
 assert.equal(both.eligibleToPublish,true);
 assert.equal(both.publishable,false);
});

test("rejects same-person dual approval and wrong-role or browser-supplied approval records",()=>{
 const packet=createSubscriptionAllowanceApprovalPacket(base);
 const same=evaluateSubscriptionAllowanceApprovals(packet,[
  approval("finance","billing_admin",finance,"approved",packet.proposalHash),
  approval("product","platform_admin",finance,"approved",packet.proposalHash)
 ]);
 assert.equal(same.status,"separation_of_duties_failed");
 assert.equal(same.eligibleToPublish,false);
 const wrong=evaluateSubscriptionAllowanceApprovals(packet,[
  approval("finance","platform_admin",finance,"approved",packet.proposalHash),
  approval("product","billing_admin",product,"approved",packet.proposalHash)
 ]);
 assert.equal(wrong.status,"awaiting_dual_approval");
 assert.equal(wrong.eligibleToPublish,false);
});

test("a rejection blocks approval and approvals for another hash do not count",()=>{
 const packet=createSubscriptionAllowanceApprovalPacket(base);
 const rejected=evaluateSubscriptionAllowanceApprovals(packet,[
  approval("finance","billing_admin",finance,"rejected",packet.proposalHash),
  approval("product","platform_admin",product,"approved",packet.proposalHash)
 ]);
 assert.equal(rejected.status,"rejected");
 const stale=evaluateSubscriptionAllowanceApprovals(packet,[
  approval("finance","billing_admin",finance,"approved","a".repeat(64)),
  approval("product","platform_admin",product,"approved","a".repeat(64))
 ]);
 assert.equal(stale.status,"awaiting_dual_approval");
 assert.equal(stale.eligibleToPublish,false);
});

test("any changed plan price, version, allowance or cost measurement requires a new approval hash",()=>{
 const original=createSubscriptionAllowanceApprovalPacket(base);
 const changes=[
  {...base,plan:{...base.plan,monthlyPriceMinor:1200}},
  {...base,planVersion:4},
  {...base,allowanceCredits:81},
  {...base,providerCostPerCustomerCreditMinor:3},
  {...base,costEvidence:{...evidence,rateCardVersion:"new-invoice-method-v2"}}
 ];
 for(const changed of changes){
  assert.notEqual(createSubscriptionAllowanceApprovalPacket(changed).proposalHash,original.proposalHash);
 }
});

test("rejects malformed plan, financial assumptions and allowance inputs",()=>{
 assert.throws(()=>createSubscriptionAllowanceApprovalPacket({...base,allowanceCredits:0}),
  {code:"SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID"});
 assert.throws(()=>createSubscriptionAllowanceApprovalPacket({...base,plan:{...base.plan,currency:"UGX"}}),
  {code:"SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID"});
 assert.throws(()=>createSubscriptionAllowanceApprovalPacket({...base,paymentFeeBps:9900,refundReserveBps:200}),
  {code:"SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID"});
});
