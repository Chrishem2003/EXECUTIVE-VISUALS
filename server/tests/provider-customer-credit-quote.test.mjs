import test from "node:test";
import assert from "node:assert/strict";
import {quoteProviderVideoCustomerCredits} from "../provider-customer-credit-quote.mjs";

const estimate={estimateType:"provider_cost_forecast_not_actual",provider:"runway",model:"seedance-2.5",
 currency:"USD",rateCardVersion:"2026-11-v1",estimatedProviderCostMinor:408};

test("converts a verified USD forecast to customer credits using integer micro-units",()=>{
 const result=quoteProviderVideoCustomerCredits({
  providerEstimate:estimate,creditsPerUsd:100,
  quoteCustomerCredits:({currency,amountMicros})=>{
   assert.equal(currency,"USD");
   assert.equal(amountMicros,4_080_000);
   return 583;
  }
 });
 assert.equal(result.providerCostMinor,408);
 assert.equal(result.customerCredits,583);
 assert.equal(result.creditEquivalentRetailValueMicros,5_830_000);
 assert.ok(result.estimatedPreFeeContributionMarginBps>=3000);
 assert.equal(result.billable,false);
 assert.equal(result.reservesCredits,false);
 assert.equal(result.usesActualInvoice,false);
});

test("rejects estimates that are not positive USD provider-cost forecasts",()=>{
 for(const providerEstimate of [
  {...estimate,currency:"EUR"},
  {...estimate,estimatedProviderCostMinor:0},
  {...estimate,estimatedProviderCostMinor:1.5},
  {...estimate,estimateType:"provider_invoice_actual"}
 ])assert.throws(()=>quoteProviderVideoCustomerCredits({
  providerEstimate,creditsPerUsd:100,quoteCustomerCredits:()=>10
 }),{code:"PROVIDER_CUSTOMER_QUOTE_COST_INVALID"});
});

test("fails closed when customer pricing is not configured or returns invalid credits",()=>{
 assert.throws(()=>quoteProviderVideoCustomerCredits({providerEstimate:estimate,creditsPerUsd:0}),{
  code:"PROVIDER_CUSTOMER_QUOTE_POLICY_UNAVAILABLE"
 });
 assert.throws(()=>quoteProviderVideoCustomerCredits({
  providerEstimate:estimate,creditsPerUsd:100,quoteCustomerCredits:()=>0
 }),{code:"PROVIDER_CUSTOMER_QUOTE_CREDITS_INVALID"});
});
