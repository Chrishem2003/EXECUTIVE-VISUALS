import test from "node:test";
import assert from "node:assert/strict";
import {calculateCreditPriceFloor,calculateSubscriptionCreditCeiling} from "../credit-unit-economics.mjs";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";
const owner="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",billingEnabled:true,fetchImpl});}

test("credit price floor includes provider, measured infrastructure, retry and payment fee VAT",()=>{
 const result=calculateCreditPriceFloor({currency:"USD",providerCostMinor:150,infrastructureCostMinor:20,retryAllowanceMinor:10,creditUnits:100,paymentFeeBps:300,feeVatBps:1500,targetMarginBps:5000});
 assert.equal(result.directCostMinor,180);
 assert.ok(result.minimumPriceMinor>360);
 assert.ok(result.processingFeeMinor>0);
 assert.ok(result.contributionMinor>=result.minimumPriceMinor*0.5-1);
 assert.equal(result.customerChargeCreated,false);
});
test("credit price floor rejects missing provider cost, mixed currency and unreachable margin",()=>{
 assert.throws(()=>calculateCreditPriceFloor({currency:"USD",infrastructureCostMinor:10,retryAllowanceMinor:0,creditUnits:10,paymentFeeBps:300,feeVatBps:1500,targetMarginBps:5000}),{code:"CREDIT_PRICING_INPUT_REQUIRED"});
 assert.throws(()=>calculateCreditPriceFloor({currency:"US",providerCostMinor:10,infrastructureCostMinor:0,retryAllowanceMinor:0,creditUnits:1,paymentFeeBps:0,feeVatBps:0,targetMarginBps:0}),{code:"CREDIT_PRICING_CURRENCY_REQUIRED"});
 assert.throws(()=>calculateCreditPriceFloor({currency:"USD",providerCostMinor:10,infrastructureCostMinor:0,retryAllowanceMinor:0,creditUnits:1,paymentFeeBps:5000,feeVatBps:3000,targetMarginBps:5000}),{code:"CREDIT_PRICING_MARGIN_UNREACHABLE"});
});
test("subscription allowance ceiling uses explicit blended unit cost and never mutates entitlements",()=>{
 const result=calculateSubscriptionCreditCeiling({currency:"USD",monthlyPriceMinor:2900,fixedServiceCostMinor:100,variableCostPerCreditMinor:2,paymentFeeBps:300,feeVatBps:1500,targetMarginBps:5000});
 assert.ok(result.maximumIncludedCredits>0);
 assert.ok(result.projectedMarginBps>=5000);
 assert.equal(result.subscriptionEntitlementChanged,false);
});
test("credit pricing scenario API is finance-admin only and returns a non-binding calculation",async()=>{
 const denied=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Unauthorized request must stop before pricing.");});
 const blocked=await denied.handle({method:"POST",path:"/api/admin/finance/credit-pricing/scenario",ownerId:owner,body:{currency:"USD"}});
 assert.equal(blocked.status,403);
 const service=api(async url=>{if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);throw new Error("No persistence is expected.");});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/credit-pricing/scenario",ownerId:owner,body:{currency:"USD",providerCostMinor:150,infrastructureCostMinor:20,retryAllowanceMinor:10,creditUnits:100,paymentFeeBps:300,feeVatBps:1500,targetMarginBps:5000}});
 assert.equal(result.status,200);
 assert.equal(result.body.pricing.customerChargeCreated,false);
 assert.ok(result.body.pricing.minimumPriceMinor>0);
});
