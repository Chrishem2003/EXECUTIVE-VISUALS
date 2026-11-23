import test from "node:test";
import assert from "node:assert/strict";
import {applyCustomerCreditDispatchGate} from "../customer-credit-dispatch-gate.mjs";

const ready={
 status:"ready_for_approval",readyForApproval:true,requestsSubmitted:false,
 shots:[{shotId:"shot-1"},{shotId:"shot-2"}],
 pricing:{status:"verified_estimate",quote:{available:true,estimated:true,currency:"USD",amount:1.25,
  customerCreditQuote:{unit:"customer_credits",totalCredits:150,perShot:[{shotId:"shot-1",credits:100},{shotId:"shot-2",credits:50}]}}}
};

test("only verified staging dispatch unlocks storyboard budget approval",()=>{
 const result=applyCustomerCreditDispatchGate(ready,{stagingDispatchReady:true});
 assert.equal(result.status,"ready_for_approval");
 assert.equal(result.readyForApproval,true);
 assert.deepEqual(result.customerCreditDispatch,{
  available:true,backend:"neon-staging",reservation:"atomic_at_submission",
  settlement:"authoritative_provider_usage",requestsSubmitted:false
 });
 assert.equal(result.pricing.quote.customerCreditQuote.totalCredits,150);
 assert.match(result.reason,/reserved atomically/);
 assert.equal(result.requestsSubmitted,false);
});

test("production without verified staging dispatch stays blocked and reserves nothing",()=>{
 const result=applyCustomerCreditDispatchGate(ready);
 assert.equal(result.status,"customer_credit_settlement_pending");
 assert.equal(result.readyForApproval,false);
 assert.equal(result.customerCreditDispatch.available,false);
 assert.equal(result.customerCreditDispatch.reservation,"not_reserved");
 assert.match(result.reason,/Production cloud dispatch remains closed/);
});

test("missing, malformed or inconsistent per-shot credit quotes fail closed",()=>{
 for(const customerCreditQuote of [
  undefined,
  {unit:"customer_credits",totalCredits:100,perShot:[{shotId:"shot-1",credits:100}]},
  {unit:"customer_credits",totalCredits:150,perShot:[{shotId:"shot-1",credits:100},{shotId:"shot-2",credits:0}]},
  {unit:"provider_credits",totalCredits:150,perShot:[{shotId:"shot-1",credits:100},{shotId:"shot-2",credits:50}]}
 ]){
  const result=applyCustomerCreditDispatchGate({
   ...ready,pricing:{...ready.pricing,quote:{...ready.pricing.quote,customerCreditQuote}}
  },{stagingDispatchReady:true});
  assert.equal(result.status,"pricing_unverified");
  assert.equal(result.readyForApproval,false);
  assert.equal(result.customerCreditDispatch.available,false);
 }
});

test("a blocked provider preflight cannot be upgraded by a staging flag",()=>{
 const result=applyCustomerCreditDispatchGate({...ready,status:"blocked",readyForApproval:false},{stagingDispatchReady:true});
 assert.equal(result.status,"pricing_unverified");
 assert.equal(result.readyForApproval,false);
});

test("gate is immutable and does not mutate the original preflight snapshot",()=>{
 const before=JSON.stringify(ready);
 const result=applyCustomerCreditDispatchGate(ready,{stagingDispatchReady:true});
 assert.equal(JSON.stringify(ready),before);
 assert.notEqual(result,ready);
});
