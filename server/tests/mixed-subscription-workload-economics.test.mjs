import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {calculateSubscriptionPlanCreditEconomics} from "../subscription-plan-credit-economics.mjs";
import {calculateMixedSubscriptionWorkloadEconomics} from "../mixed-subscription-workload-economics.mjs";
import {createCustomerCreditQuotePolicy} from "../customer-credit-quote-policy.mjs";

const quote=createCustomerCreditQuotePolicy({env:{NEON_CUSTOMER_CREDITS_PER_USD:"100",NEON_CUSTOMER_TARGET_MARGIN_BPS:"6500",NEON_CUSTOMER_PAYMENT_FEE_BPS:"300",NEON_CUSTOMER_SUPPORT_RESERVE_BPS:"500",NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS:"0"}});
const plans=[
 {plan_code:"starter_creator",name:"Starter Creator",amount_minor:900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"professional_creator",name:"Professional Creator",amount_minor:2900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"studio",name:"Studio",amount_minor:7900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"agency",name:"Agency",amount_minor:19900,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0},
 {plan_code:"enterprise",name:"Enterprise",amount_minor:0,currency:"USD",billing_interval:"monthly",status:"draft",is_public:false,included_credits:0}
];
const scenario=(model,amount)=>({provider:"runway",model,currency:"USD",operation:"video",durationSeconds:10,resolution:"1080p",amount,pricingSource:"https://dev.runway.com/pricing",pricingDate:"2026-11-22",billable:false,settlementEligible:false});
const economics=calculateSubscriptionPlanCreditEconomics({plans,scenarios:[scenario("gen4.5",1.2),scenario("seedance2_5",6.8),scenario("kling3.0_standard",0.9)],quoteCustomerCredits:quote,creditsPerUsd:100,creditBudgetShareBps:7000});

test("prices a mixed monthly workload across every draft tier without granting credits",()=>{
 const result=calculateMixedSubscriptionWorkloadEconomics({planEconomics:economics,workloads:[{name:"Balanced creator month",items:[{scenarioIndex:0,quantity:10},{scenarioIndex:1,quantity:3},{scenarioIndex:2,quantity:5}]}]});
 const starter=result.plans.find(p=>p.planCode==="starter_creator").mixes[0];
 const studio=result.plans.find(p=>p.planCode==="studio").mixes[0];
 assert.equal(starter.creditsRequired,10*economics.scenarios[0].customerCreditsPerGeneration+3*economics.scenarios[1].customerCreditsPerGeneration+5*economics.scenarios[2].customerCreditsPerGeneration);
 assert.equal(starter.fitsCreditAllowance,false);
 assert.equal(studio.estimatedProviderSpendUsd,Number((10*1.2+3*6.8+5*0.9).toFixed(6)));
 assert.equal(result.plans.find(p=>p.planCode==="enterprise").mixes[0].monthlyCreditAllowance,0);
 assert.equal(plans.every(p=>p.included_credits===0),true);
});

test("reports multiple distinct workload mixes and aggregates duplicate scenario lines",()=>{
 const result=calculateMixedSubscriptionWorkloadEconomics({planEconomics:economics,workloads:[
  {name:"Image-led pilot",items:[{scenarioIndex:0,quantity:2},{scenarioIndex:0,quantity:3}]},
  {name:"Premium video month",items:[{scenarioIndex:1,quantity:2}]}
 ]});
 assert.equal(result.plans[0].mixes.length,2);
 assert.equal(result.plans[0].mixes[0].lines.length,1);
 assert.equal(result.plans[0].mixes[0].lines[0].quantity,5);
 assert.equal(result.plans[0].mixes[1].lines[0].model,"seedance2_5");
});

test("reports provider cost ratio and explicitly avoids representing contribution as net profit",()=>{
 const result=calculateMixedSubscriptionWorkloadEconomics({planEconomics:economics,workloads:[{name:"Small workload",items:[{scenarioIndex:0,quantity:1}]}]});
 const row=result.plans[0].mixes[0];
 assert.equal(row.providerCostRatioOfPlanRevenue,Number((1.2/9).toFixed(6)));
 assert.equal(row.estimatedContributionBeforePaymentFeesSupportStorageAndOtherCostsUsd,7.8);
 assert.match(result.limitations.join(" "),/not net profit/);
});

test("calculates contribution after provider cost, payment fees and support reserve",()=>{
 const input={...economics,pricingPolicy:{...economics.pricingPolicy,fixedPaymentFeeMicros:125000}};
 const result=calculateMixedSubscriptionWorkloadEconomics({planEconomics:input,workloads:[{name:"Single Gen 4.5",items:[{scenarioIndex:0,quantity:1}]}]});
 const row=result.plans.find(plan=>plan.planCode==="starter_creator").mixes[0];
 assert.equal(row.fitsCreditAllowance,true);
 assert.equal(row.estimatedProviderCostMinor,120);
 assert.equal(row.estimatedPaymentFeeMinor,40);
 assert.equal(row.estimatedSupportReserveMinor,45);
 assert.equal(row.estimatedContributionAfterProviderPaymentAndSupportUsd,6.95);
 assert.equal(row.estimatedContributionMarginBps,Math.floor(695*10000/900));
 assert.equal(row.targetMarginBps,6500);
 assert.equal(row.marginAssessment,"meets_target_before_other_costs");
 assert.equal(row.targetMarginMet,true);
 assert.equal(result.pricingAssumptions.fixedPaymentFeeMicros,125000);
});

test("does not claim plan margin when workload exceeds included credits or plan is custom-priced",()=>{
 const result=calculateMixedSubscriptionWorkloadEconomics({planEconomics:economics,workloads:[
  {name:"Premium-only month",items:[{scenarioIndex:1,quantity:1}]}
 ]});
 const starter=result.plans.find(plan=>plan.planCode==="starter_creator").mixes[0];
 const enterprise=result.plans.find(plan=>plan.planCode==="enterprise").mixes[0];
 assert.equal(starter.fitsCreditAllowance,false);
 assert.equal(starter.marginAssessment,"not_applicable_credit_shortfall");
 assert.equal(starter.targetMarginMet,false);
 assert.equal(enterprise.marginAssessment,"custom_price_required");
 assert.equal(enterprise.estimatedContributionAfterProviderPaymentAndSupportUsd,null);
});

test("flags a below-target modeled contribution without calling it net profit",()=>{
 const expensive={...economics,scenarios:economics.scenarios.map((scenario,index)=>index===0
  ?{...scenario,providerCostUsd:8,customerCreditsPerGeneration:1}:scenario)};
 const result=calculateMixedSubscriptionWorkloadEconomics({planEconomics:expensive,workloads:[{name:"Loss-making example",items:[{scenarioIndex:0,quantity:1}]}]});
 const row=result.plans.find(plan=>plan.planCode==="starter_creator").mixes[0];
 assert.equal(row.estimatedContributionAfterProviderPaymentAndSupportUsd,0.28);
 assert.equal(row.marginAssessment,"below_target_before_other_costs");
 assert.equal(row.targetMarginMet,false);
 assert.match(result.limitations.join(" "),/not net profit/);
});

test("requires bounded shared pricing assumptions before calculating margins",()=>{
 for(const pricingPolicy of [null,{}, {...economics.pricingPolicy,paymentFeeBps:2001},
  {...economics.pricingPolicy,targetMarginBps:9500},{...economics.pricingPolicy,fixedPaymentFeeMicros:-1}]){
  const invalid={...economics,pricingPolicy};
  assert.throws(()=>calculateMixedSubscriptionWorkloadEconomics({planEconomics:invalid,workloads:[{name:"Validation",items:[{scenarioIndex:0,quantity:1}]}]}));
 }
});

test("rejects invalid scenario indexes, zero quantities, empty mixes and unsafe input",()=>{
 for(const workload of [
  {name:"Invalid",items:[{scenarioIndex:99,quantity:1}]},
  {name:"Invalid",items:[{scenarioIndex:0,quantity:0}]},
  {name:"Invalid",items:[]},
  {name:"Invalid",items:[{scenarioIndex:0,quantity:10001}]},
  {name:"",items:[{scenarioIndex:0,quantity:1}]}
 ])assert.throws(()=>calculateMixedSubscriptionWorkloadEconomics({planEconomics:economics,workloads:[workload]}));
});

test("rejects non-Batch-72 inputs and excessive workload counts",()=>{
 assert.throws(()=>calculateMixedSubscriptionWorkloadEconomics({planEconomics:{},workloads:[{name:"x",items:[{scenarioIndex:0,quantity:1}]}]}));
 assert.throws(()=>calculateMixedSubscriptionWorkloadEconomics({planEconomics:economics,workloads:[]}));
});

test("rejects non-finite or negative provider costs instead of emitting misleading economics",()=>{
 for(const providerCostUsd of [NaN,Infinity,-0.01]){
  const invalid={...economics,scenarios:economics.scenarios.map((item,index)=>index===0?{...item,providerCostUsd}:item)};
  assert.throws(()=>calculateMixedSubscriptionWorkloadEconomics({planEconomics:invalid,workloads:[{name:"Invalid cost",items:[{scenarioIndex:0,quantity:1}]}]}));
 }
});

test("rejects malformed draft plan prices and allowances",()=>{
 for(const plan of [
  {...economics.plans[0],amountMinor:-1},
  {...economics.plans[0],amountMinor:Infinity},
  {...economics.plans[0],proposedMonthlyCreditAllowance:-1}
 ]){
  const invalid={...economics,plans:[plan]};
  assert.throws(()=>calculateMixedSubscriptionWorkloadEconomics({planEconomics:invalid,workloads:[{name:"Plan validation",items:[{scenarioIndex:0,quantity:1}]}]}));
 }
});

test("Financial Command Centre exposes editable mixed monthly workload scenarios and renders their results",()=>{
 const app=readFileSync(new URL("../../src/platform/app.ts",import.meta.url),"utf8");
 assert.match(app,/finance-plan-workload-mixes/);
 assert.match(app,/planEconomicsWorkloadJson/);
 assert.match(app,/mixedPlanEconomics/);
 assert.match(app,/Calculate plan and mixed-workload economics/);
 assert.match(app,/mixedEconomics\?:FinanceDashboard/);
});
