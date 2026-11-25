import test from "node:test";
import assert from "node:assert/strict";
import {buildCustomerGenerationCreditQuote} from "../customer-generation-credit-quote.mjs";
import {createCustomerCreditQuotePolicy} from "../neon-customer-credit-policy.mjs";

const providerEstimate={
 available:true,estimated:true,provider:"fal",model:"fal-ai/example-video",
 currency:"USD",amount:1.37,
 pricing:{sourceUrl:"https://fal.ai/pricing",observedAt:"2026-11-23T10:00:00.000Z",expiresAt:"2026-12-01T00:00:00.000Z"}
};

test("converts verified USD provider estimates using the server-owned customer pricing policy",()=>{
 const calls=[];
 const quote=buildCustomerGenerationCreditQuote({
  providerEstimate,
  quoteCustomerCredits:input=>{calls.push(input);return 196;}
 });
 assert.deepEqual(calls,[{currency:"USD",amountMicros:1_370_000}]);
 assert.equal(quote.available,true);
 assert.equal(quote.credits,196);
 assert.equal(quote.unit,"customer_credits");
 assert.equal(quote.reservationRequired,true);
 assert.equal(quote.requestsSubmitted,false);
 assert.equal(quote.pricingSource,"https://fal.ai/pricing");
 assert.equal(Object.isFrozen(quote),true);
});

test("does not guess credits when provider pricing or customer policy is unavailable",()=>{
 assert.equal(buildCustomerGenerationCreditQuote({providerEstimate:{available:false}}).available,false);
 assert.equal(buildCustomerGenerationCreditQuote({providerEstimate}).available,false);
 assert.equal(buildCustomerGenerationCreditQuote({providerEstimate:{...providerEstimate,currency:"EUR"},quoteCustomerCredits:()=>100}).available,false);
 assert.equal(buildCustomerGenerationCreditQuote({providerEstimate:{...providerEstimate,amount:0},quoteCustomerCredits:()=>100}).available,false);
});

test("rejects unsafe customer credit policy output",()=>{
 assert.throws(()=>buildCustomerGenerationCreditQuote({providerEstimate,quoteCustomerCredits:()=>0}),e=>e.code==="VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
 assert.throws(()=>buildCustomerGenerationCreditQuote({providerEstimate,quoteCustomerCredits:()=>1.5}),e=>e.code==="VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
});

test("does not permit provider estimates outside safe integer micro precision",()=>{
 const result=buildCustomerGenerationCreditQuote({
  providerEstimate:{...providerEstimate,amount:Number.MAX_VALUE},
  quoteCustomerCredits:()=>100
 });
 assert.equal(result.available,false);
});

test("attaches a server-generated monetary customer-price quote separately from customer credits",()=>{
 const quoteCustomerCredits=createCustomerCreditQuotePolicy({env:{
  NEON_CUSTOMER_CREDITS_PER_USD:"100",
  NEON_CUSTOMER_TARGET_MARGIN_BPS:"3000",
  NEON_CUSTOMER_PAYMENT_FEE_BPS:"300",
  NEON_CUSTOMER_SUPPORT_RESERVE_BPS:"500"
 }});
 const result=buildCustomerGenerationCreditQuote({providerEstimate,quoteCustomerCredits});
 assert.equal(result.available,true);
 assert.equal(result.customerPriceEvidence.status,"verified_quote");
 assert.equal(result.customerPriceEvidence.currency,"USD");
 assert.ok(result.customerPriceEvidence.customerPriceMicros>1_370_000);
 assert.match(result.customerPriceEvidence.evidenceReference,/^customer-price-quote:/);
 assert.match(result.customerPriceEvidence.evidenceSha256,/^[a-f0-9]{64}$/);
});
