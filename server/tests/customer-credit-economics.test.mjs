import test from "node:test";
import assert from "node:assert/strict";
import {compareCommercialProductionCandidates,evaluateProductionEntitlement,quoteCustomerCredits,resolveCustomerCreditPolicy} from "../customer-credit-economics.mjs";

const policy={currency:"USD",creditValueMinor:1,minorUnitsPerMajor:100,targetMarginBps:6000,paymentFeeBps:300,retryReserveBps:500,infrastructureReserveBps:300,fixedPaymentFeeMinor:30,pricingVersion:"test-v1"};
const providerQuote={available:true,estimated:true,currency:"USD",amount:2.35,pricing:{sourceUrl:"https://provider.example/pricing"}};

test("converts a provider estimate to a rounded-up customer credit quote with reserves and margin",()=>{
 const quote=quoteCustomerCredits(providerQuote,policy);
 assert.equal(quote.available,true);
 assert.equal(quote.billable,false);
 assert.equal(quote.authorizationRequired,true);
 assert.equal(quote.providerCostMinor,235);
 assert.equal(quote.retryReserveMinor,12);
 assert.equal(quote.infrastructureReserveMinor,8);
 assert.equal(quote.fullyLoadedCostMinor,255);
 assert.ok(quote.customerCredits>quote.providerCostMinor);
 assert.ok(quote.estimatedMarginBps>=6000);
 assert.equal(quote.pricingVersion,"test-v1");
});

test("fails closed when provider rates or customer credit pricing are unavailable",()=>{
 assert.equal(quoteCustomerCredits({...providerQuote,available:false},policy).available,false);
 assert.equal(quoteCustomerCredits(providerQuote,null).available,false);
 assert.match(quoteCustomerCredits(providerQuote,{...policy,currency:"UGX"}).reason,/currency/);
 assert.equal(resolveCustomerCreditPolicy({}).configured,false);
 assert.equal(resolveCustomerCreditPolicy({
  CUSTOMER_CREDIT_CURRENCY:"USD",
  CUSTOMER_CREDIT_VALUE_MINOR:"1",CUSTOMER_CREDIT_MINOR_UNITS_PER_MAJOR:"100",
  CUSTOMER_CREDIT_TARGET_MARGIN_BPS:"6000",CUSTOMER_CREDIT_PAYMENT_FEE_BPS:"300",
  CUSTOMER_CREDIT_RETRY_RESERVE_BPS:"500",CUSTOMER_CREDIT_INFRA_RESERVE_BPS:"300",
  CUSTOMER_CREDIT_FIXED_PAYMENT_FEE_MINOR:"30",CUSTOMER_CREDIT_PRICING_VERSION:"v1"
 }).configured,true);
});

test("rejects impossible margin, malformed money and unsafe quantities",()=>{
 assert.equal(quoteCustomerCredits(providerQuote,{...policy,targetMarginBps:9500}).available,false);
 assert.equal(quoteCustomerCredits({...providerQuote,amount:NaN},policy).available,false);
 assert.equal(quoteCustomerCredits(providerQuote,{...policy,creditValueMinor:0}).available,false);
});

test("subscription entitlement checks are server-snapshot based and fail closed",()=>{
 const subscription={status:"active",plan_code:"studio",plan_version:1,entitlements_snapshot:{ai_generation:true,max_video_seconds:30,allowed_resolutions:["720p"]}};
 assert.equal(evaluateProductionEntitlement({subscription,request:{durationSeconds:20,resolution:"720p"},creditBalance:100}).allowed,true);
 assert.equal(evaluateProductionEntitlement({subscription:{...subscription,status:"past_due"},request:{durationSeconds:5}}).code,"SUBSCRIPTION_REQUIRED");
 assert.equal(evaluateProductionEntitlement({subscription:{...subscription,entitlements_snapshot:{ai_generation:false}},request:{durationSeconds:5}}).code,"AI_GENERATION_NOT_INCLUDED");
 assert.equal(evaluateProductionEntitlement({subscription,request:{durationSeconds:31,resolution:"720p"}}).code,"PLAN_DURATION_LIMIT");
 assert.equal(evaluateProductionEntitlement({subscription,request:{durationSeconds:5,resolution:"4k"}}).code,"PLAN_RESOLUTION_LIMIT");
});

test("candidate recommendation requires measured quality evidence and never auto-routes",()=>{
 const result=compareCommercialProductionCandidates({candidates:[
  {id:"cheap-unproven",provider:"p",model:"a",creditQuote:{available:true,customerCredits:30},qualityEvidence:{verified:true,sampleCount:3,qualityScore:0.99,evaluationVersion:"e1"}},
  {id:"qualified",provider:"p",model:"b",creditQuote:{available:true,customerCredits:50},qualityEvidence:{verified:true,sampleCount:50,qualityScore:0.95,evaluationVersion:"e2"}},
  {id:"best-quality-costlier",provider:"p",model:"c",creditQuote:{available:true,customerCredits:60},qualityEvidence:{verified:true,sampleCount:60,qualityScore:0.98,evaluationVersion:"e3"}}
 ]});
 assert.equal(result.mode,"recommendation_only");
 assert.equal(result.automaticRouting,false);
 assert.equal(result.recommended.id,"qualified");
 assert.equal(result.candidates.find(x=>x.id==="cheap-unproven").eligible,false);
});

test("no model is recommended without sufficient independent evaluation evidence",()=>{
 const result=compareCommercialProductionCandidates({candidates:[
  {id:"a",creditQuote:{available:true,customerCredits:10}},
  {id:"b",creditQuote:{available:true,customerCredits:20}}
 ]});
 assert.equal(result.recommended,null);
});
