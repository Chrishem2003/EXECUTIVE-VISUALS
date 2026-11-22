import test from "node:test";
import assert from "node:assert/strict";
import {calculateSubscriptionPlanCreditEconomics} from "../subscription-plan-credit-economics.mjs";
import {createCustomerCreditQuotePolicy} from "../customer-credit-quote-policy.mjs";

const quote=createCustomerCreditQuotePolicy({env:{
 NEON_CUSTOMER_CREDITS_PER_USD:"100",
 NEON_CUSTOMER_TARGET_MARGIN_BPS:"6500",
 NEON_CUSTOMER_PAYMENT_FEE_BPS:"300",
 NEON_CUSTOMER_SUPPORT_RESERVE_BPS:"500",
 NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS:"0"
}});
const plans=[
 {plan_code:"starter_creator",name:"Starter Creator",amount_minor:900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"professional_creator",name:"Professional Creator",amount_minor:2900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"studio",name:"Studio",amount_minor:7900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"agency",name:"Agency",amount_minor:19900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"enterprise",name:"Enterprise",amount_minor:0,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0}
];
const scenario=(overrides={})=>({
 provider:"runway",model:"gen4.5",currency:"USD",operation:"text-to-video",durationSeconds:10,
 resolution:"1080p",amount:1.2,pricingSource:"https://dev.runway.com/pricing",pricingDate:"2026-11-22",
 billable:false,settlementEligible:false,...overrides
});
const calculate=(overrides={})=>calculateSubscriptionPlanCreditEconomics({
 plans,scenarios:[scenario()],quoteCustomerCredits:quote,creditsPerUsd:100,creditBudgetShareBps:7000,...overrides
});

test("prices private draft tiers without persisting or activating included credits",()=>{
 const result=calculate();
 assert.equal(result.calculationType,"subscription_plan_credit_scenario_not_activation");
 assert.deepEqual(result.plans.map(plan=>plan.proposedMonthlyCreditAllowance),[630,2030,5530,13930,0]);
 assert.equal(result.plans[0].status,"draft");
 assert.equal(result.plans[0].modelCoverage[0].provider,"runway");
 assert.equal(result.plans[0].modelCoverage[0].maximumWholeGenerations,1);
 assert.equal(result.plans[4].modelCoverage[0].maximumWholeGenerations,0);
 assert.equal(plans.every(plan=>plan.included_credits===0),true);
 assert.equal(result.scenarios[0].billable,false);
 assert.equal(result.scenarios[0].settlementEligible,false);
});

test("uses the same customer-credit margin, payment-fee and support-reserve policy as workflow quotes",()=>{
 const result=calculate();
 const generationCredits=result.scenarios[0].customerCreditsPerGeneration;
 assert.equal(generationCredits,quote({currency:"USD",amountMicros:1_200_000}));
 assert.equal(result.plans[0].modelCoverage[0].customerCreditsPerGeneration,generationCredits);
});

test("supports multiple model and duration scenarios independently for every plan",()=>{
 const result=calculate({scenarios:[
  scenario(),
  scenario({model:"seedance2_5",amount:6.8,resolution:"1080p"}),
  scenario({model:"kling4",amount:2.35,resolution:"1080p"})
 ]});
 assert.equal(result.scenarios.length,3);
 assert.equal(result.plans[1].modelCoverage.length,3);
 assert.ok(result.plans[1].modelCoverage.every(row=>row.maximumWholeGenerations>=0));
});

test("requires explicit credit budget share and a valid configured conversion rate",()=>{
 for(const value of [undefined,0,999,10001,1.5]){
  assert.throws(()=>calculate({creditBudgetShareBps:value}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 }
 for(const value of [undefined,0,-1,1.5,1000001]){
  assert.throws(()=>calculate({creditsPerUsd:value}),{code:"SUBSCRIPTION_ECONOMICS_INPUT_INVALID"});
 }
});

test("refuses public, active, preconfigured, non-monthly and non-USD plans",()=>{
 for(const patch of [
  {status:"active"},
  {is_public:true},
  {included_credits:100},
  {billing_interval:"annual"},
  {currency:"EUR"}
 ]){
  assert.throws(()=>calculate({plans:[{...plans[0],...patch}]}));
 }
});

test("refuses estimates that could be mistaken for billable or actual settlement evidence",()=>{
 for(const patch of [
  {billable:true},
  {settlementEligible:true},
  {currency:"EUR"},
  {amount:0},
  {amount:1.0000001}
 ]){
  assert.throws(()=>calculate({scenarios:[scenario(patch)]}));
 }
});

test("requires complete source, model, pricing date and bounded duration",()=>{
 for(const patch of [
  {pricingSource:""},
  {pricingDate:""},
  {model:""},
  {durationSeconds:0},
  {durationSeconds:601}
 ]){
  assert.throws(()=>calculate({scenarios:[scenario(patch)]}));
 }
});

test("does not treat a custom enterprise plan as an included-credit grant",()=>{
 const result=calculate();
 const enterprise=result.plans.find(plan=>plan.planCode==="enterprise");
 assert.equal(enterprise.proposedMonthlyCreditAllowance,0);
 assert.equal(enterprise.modelCoverage[0].maximumWholeGenerations,0);
});
