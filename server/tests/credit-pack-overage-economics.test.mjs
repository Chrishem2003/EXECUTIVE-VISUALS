import test from "node:test";
import assert from "node:assert/strict";
import {calculateCreditPackOverageEconomics} from "../credit-pack-overage-economics.mjs";

const policy={paymentFeeBps:300,supportReserveBps:500,targetMarginBps:6500,fixedPaymentFeeMicros:0};
const evidence={status:"verified_measured",currency:"USD",periodMonth:"2026-11-01",sampleJobs:8,
 providerCostPerCustomerCreditMinor:2,evidence:{rateCardVersion:"invoice-attribution-derived-v1"}};
const product=(overrides={})=>({product_code:"creator-pack-1000",name:"Creator 1,000 credits",product_type:"credit_pack",
 amount_minor:5000,currency:"USD",credit_units:1000,active:false,...overrides});

test("calculates top-up contribution only from verified same-currency invoice cost",()=>{
 const result=calculateCreditPackOverageEconomics({products:[product()],costEvidence:evidence,pricingPolicy:policy});
 const row=result.products[0];
 assert.equal(result.status,"measured_scenario_only");
 assert.equal(row.status,"measured_scenario_only");
 assert.equal(row.providerCostMinor,2000);
 assert.equal(row.paymentFeeMinor,150);
 assert.equal(row.supportReserveMinor,250);
 assert.equal(row.contributionMinor,2600);
 assert.equal(row.contributionMarginBps,5200);
 assert.equal(row.marginAssessment,"below_target_before_other_costs");
 assert.equal(row.checkoutEligible,false);
 assert.equal(row.customerChargeCreated,false);
});

test("blocks UGX credit packs against USD actual-cost evidence without inventing FX",()=>{
 const result=calculateCreditPackOverageEconomics({products:[product({currency:"UGX",amount_minor:50000})],costEvidence:evidence,pricingPolicy:policy});
 assert.equal(result.status,"partially_blocked");
 assert.equal(result.products[0].status,"blocked_currency_mismatch");
 assert.equal(result.products[0].costCurrency,"USD");
 assert.equal(result.products[0].providerCostMinor,null);
 assert.equal(result.products[0].contributionMinor,null);
 assert.match(result.limitations.join(" "),/No foreign-exchange conversion/);
});

test("blocks cost calculations until invoice evidence is complete and verified",()=>{
 const result=calculateCreditPackOverageEconomics({products:[product()],costEvidence:{...evidence,status:"insufficient_sample"},pricingPolicy:policy});
 assert.equal(result.status,"blocked_invoice_evidence");
 assert.equal(result.products[0].status,"blocked_invoice_evidence");
 assert.equal(result.products[0].providerCostMinor,null);
});

test("keeps inactive draft products scenario-only and does not enable checkout",()=>{
 const result=calculateCreditPackOverageEconomics({products:[product({active:false})],costEvidence:evidence,pricingPolicy:policy});
 assert.equal(result.products[0].active,false);
 assert.equal(result.products[0].checkoutEligible,false);
 assert.equal(result.products[0].customerChargeCreated,false);
});

test("rejects malformed product, currency and pricing assumptions",()=>{
 assert.throws(()=>calculateCreditPackOverageEconomics({products:[product({currency:"US"})],costEvidence:evidence,pricingPolicy:policy}),
  {code:"CREDIT_PACK_ECONOMICS_PRODUCT_INVALID"});
 assert.throws(()=>calculateCreditPackOverageEconomics({products:[product({credit_units:0})],costEvidence:evidence,pricingPolicy:policy}),
  {code:"CREDIT_PACK_ECONOMICS_PRODUCT_INVALID"});
 assert.throws(()=>calculateCreditPackOverageEconomics({products:[product()],costEvidence:evidence,pricingPolicy:{...policy,targetMarginBps:9500}}),
  {code:"CREDIT_PACK_ECONOMICS_INPUT_INVALID"});
});

test("does not create an implied price or charge when no credit-pack products exist",()=>{
 const result=calculateCreditPackOverageEconomics({products:[],costEvidence:evidence,pricingPolicy:policy});
 assert.equal(result.status,"no_credit_pack_products");
 assert.deepEqual(result.products,[]);
});
