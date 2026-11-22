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

test("Financial Command Centre exposes editable mixed monthly workload scenarios and renders their results",()=>{
 const app=readFileSync(new URL("../../src/platform/app.ts",import.meta.url),"utf8");
 assert.match(app,/finance-plan-workload-mixes/);
 assert.match(app,/planEconomicsWorkloadJson/);
 assert.match(app,/mixedPlanEconomics/);
 assert.match(app,/Calculate plan and mixed-workload economics/);
 assert.match(app,/mixedEconomics\?:FinanceDashboard/);
});
