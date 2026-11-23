import test from "node:test";
import assert from "node:assert/strict";
import {createCustomerCreditQuotePolicy} from "../customer-credit-quote-policy.mjs";
import {calculateSubscriptionPlanCreditEconomics} from "../subscription-plan-credit-economics.mjs";
import {calculateMixedSubscriptionWorkloadEconomics} from "../mixed-subscription-workload-economics.mjs";

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
const source="https://dev.runway.com/learn/ai-video-api-pricing";
// All entries are date-stamped provider forecasts; none can settle customer billing.
const scenarios=[
  {provider:"runway",model:"gen4.5",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:1.20,pricingSource:source,pricingDate:"2026-11-22",billable:false,settlementEligible:false},
  {provider:"runway",model:"kling_4",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"1080p",amount:2.35,pricingSource:source,pricingDate:"2026-11-22",billable:false,settlementEligible:false},
  {provider:"runway",model:"seedance2_5",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"1080p",amount:6.80,pricingSource:source,pricingDate:"2026-11-22",billable:false,settlementEligible:false},
  {provider:"runway",model:"seedance2_5",operation:"video-to-video",currency:"USD",durationSeconds:10,resolution:"1080p",amount:10.20,pricingSource:source,pricingDate:"2026-11-22",billable:false,settlementEligible:false},
  {provider:"runway",model:"kling_4",operation:"video-to-video",currency:"USD",durationSeconds:10,resolution:"1080p",amount:3.76,pricingSource:source,pricingDate:"2026-11-22",billable:false,settlementEligible:false},
  {provider:"runway",model:"gemini_omni_flash_1.1",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:1.00,pricingSource:"https://dev.runwayml.com/learn/gemini-omni-flash-1-1-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false},
  {provider:"runway",model:"gemini_omni_flash_1.1",operation:"video-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:1.10,pricingSource:"https://dev.runwayml.com/learn/gemini-omni-flash-1-1-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false},
  {provider:"runway",model:"gemini_omni_flash_1.2",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:0.70,pricingSource:"https://dev.runwayml.com/learn/gemini-omni-flash-1-2-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false},
  {provider:"runway",model:"gemini_omni_flash_1.2",operation:"video-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:0.80,pricingSource:"https://dev.runwayml.com/learn/gemini-omni-flash-1-2-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false},
  {provider:"runway",model:"wan3",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:1.00,pricingSource:"https://dev.runwayml.com/learn/wan-3-0-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false},
  {provider:"runway",model:"wan3_prime",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"720p",amount:1.40,pricingSource:"https://dev.runwayml.com/learn/wan-3-0-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false},
  {provider:"runway",model:"h3_max",operation:"text-to-video",currency:"USD",durationSeconds:10,resolution:"768p",amount:0.80,pricingSource:"https://dev.runwayml.com/learn/minimax-h3-max-api",pricingDate:"2026-11-23",billable:false,settlementEligible:false}
];
const economics=()=>calculateSubscriptionPlanCreditEconomics({
  plans,scenarios,quoteCustomerCredits:quote,creditsPerUsd:100,creditBudgetShareBps:7000
});

test("November 2026 official provider-price benchmark remains forecast-only and non-billable",()=>{
  const result=economics();
  assert.deepEqual(result.scenarios.map(item=>item.providerCostUsd),[1.2,2.35,6.8,10.2,3.76,1,1.1,0.7,0.8,1,1.4,0.8]);
  assert.ok(result.scenarios.every(item=>item.estimateType==="forecast_not_actual"&&item.billable===false&&item.settlementEligible===false));
  assert.ok(result.scenarios.slice(0,5).every(item=>item.pricingSource===source&&item.pricingDate==="2026-11-22"));
  assert.ok(result.scenarios.slice(5).every(item=>item.pricingDate==="2026-11-23"));
  assert.equal(result.calculationType,"subscription_plan_credit_scenario_not_activation");
});

test("proposed $9/$29/$79/$199 tiers retain the explicit 70-percent hypothetical credit budget",()=>{
  const result=economics();
  assert.deepEqual(result.plans.map(plan=>plan.proposedMonthlyCreditAllowance),[630,2030,5530,13930,0]);
  assert.ok(plans.every(plan=>plan.status==="draft"&&plan.included_credits===0&&!plan.is_public));
});

test("10-second premium video costs consume materially different included-credit capacity",()=>{
  const result=economics();
  const starter=result.plans.find(plan=>plan.planCode==="starter_creator");
  const professional=result.plans.find(plan=>plan.planCode==="professional_creator");
  const studio=result.plans.find(plan=>plan.planCode==="studio");
  const agency=result.plans.find(plan=>plan.planCode==="agency");
  assert.ok(starter.modelCoverage[0].maximumWholeGenerations>=1);
  assert.equal(starter.modelCoverage[1].maximumWholeGenerations,0);
  assert.equal(starter.modelCoverage[2].maximumWholeGenerations,0);
  assert.ok(professional.modelCoverage[0].maximumWholeGenerations>starter.modelCoverage[0].maximumWholeGenerations);
  assert.ok(studio.modelCoverage[2].maximumWholeGenerations>0);
  assert.ok(agency.modelCoverage[2].maximumWholeGenerations>studio.modelCoverage[2].maximumWholeGenerations);
});

test("a balanced one-of-each monthly workload exposes plan shortfall and contribution margin separately",()=>{
  const planEconomics=economics();
  const mixed=calculateMixedSubscriptionWorkloadEconomics({
    planEconomics,
    workloads:[{name:"One-of-each 10-second model mix",items:[
      {scenarioIndex:0,quantity:1},{scenarioIndex:1,quantity:1},{scenarioIndex:2,quantity:1}
    ]}]
  });
  const starter=mixed.plans.find(plan=>plan.planCode==="starter_creator").mixes[0];
  const professional=mixed.plans.find(plan=>plan.planCode==="professional_creator").mixes[0];
  const studio=mixed.plans.find(plan=>plan.planCode==="studio").mixes[0];
  const agency=mixed.plans.find(plan=>plan.planCode==="agency").mixes[0];
  assert.equal(starter.fitsCreditAllowance,false);
  assert.equal(professional.fitsCreditAllowance,false);
  assert.equal(studio.fitsCreditAllowance,true);
  assert.equal(agency.fitsCreditAllowance,true);
  assert.equal(studio.marginAssessment,"meets_target_before_other_costs");
  assert.equal(agency.marginAssessment,"meets_target_before_other_costs");
  assert.equal(mixed.calculationType,"mixed_monthly_workload_scenario_not_forecast_or_activation");
});

test("video-reference inputs are priced separately from text-to-video output-only estimates",()=>{
  const result=economics();
  const seedanceText=result.scenarios.find(row=>row.model==="seedance2_5"&&row.operation==="text-to-video");
  const seedanceEdit=result.scenarios.find(row=>row.model==="seedance2_5"&&row.operation==="video-to-video");
  const klingText=result.scenarios.find(row=>row.model==="kling_4"&&row.operation==="text-to-video");
  const klingEdit=result.scenarios.find(row=>row.model==="kling_4"&&row.operation==="video-to-video");
  // 10s Seedance 1080p output ($0.68/s) + 10s video reference ($0.34/s).
  assert.equal(seedanceText.providerCostUsd,6.8);
  assert.equal(seedanceEdit.providerCostUsd,10.2);
  // Kling 4.0 1080p output ($0.235/s) + 10s input video ($0.141/s).
  assert.equal(klingText.providerCostUsd,2.35);
  assert.equal(klingEdit.providerCostUsd,3.76);
  assert.ok(seedanceEdit.customerCreditsPerGeneration>seedanceText.customerCreditsPerGeneration);
  assert.ok(klingEdit.customerCreditsPerGeneration>klingText.customerCreditsPerGeneration);
  assert.ok([seedanceEdit,klingEdit].every(row=>row.billable===false&&row.settlementEligible===false));
});

test("Gemini Omni 1.1 and 1.2 use distinct official model IDs and rates",()=>{
  const result=economics();
  const v11=result.scenarios.filter(row=>row.model==="gemini_omni_flash_1.1");
  const v12=result.scenarios.filter(row=>row.model==="gemini_omni_flash_1.2");
  assert.deepEqual(v11.map(row=>row.providerCostUsd),[1.00,1.10]);
  assert.deepEqual(v12.map(row=>row.providerCostUsd),[0.70,0.80]);
  assert.ok(v11.every(row=>row.pricingSource==="https://dev.runwayml.com/learn/gemini-omni-flash-1-1-api"));
  assert.ok(v12.every(row=>row.pricingSource==="https://dev.runwayml.com/learn/gemini-omni-flash-1-2-api"));
  assert.ok(v11.concat(v12).every(row=>row.pricingDate==="2026-11-23"&&row.billable===false&&row.settlementEligible===false));
});

test("WAN 3.0 tiers and MiniMax H3 Max use documented Runway Dev IDs and resolutions",()=>{
  const result=economics();
  const wan=result.scenarios.find(row=>row.model==="wan3");
  const prime=result.scenarios.find(row=>row.model==="wan3_prime");
  const h3=result.scenarios.find(row=>row.model==="h3_max");
  assert.equal(wan.providerCostUsd,1.00);
  assert.equal(prime.providerCostUsd,1.40);
  assert.equal(h3.providerCostUsd,0.80);
  assert.equal(wan.resolution,"720p");
  assert.equal(prime.resolution,"720p");
  assert.equal(h3.resolution,"768p");
  assert.equal(wan.pricingSource,"https://dev.runwayml.com/learn/wan-3-0-api");
  assert.equal(h3.pricingSource,"https://dev.runwayml.com/learn/minimax-h3-max-api");
  assert.ok([wan,prime,h3].every(row=>row.billable===false&&row.settlementEligible===false));
});

test("the benchmark never converts scenario output into a published price, allowance or actual invoice cost",()=>{
  const result=economics();
  assert.equal("publishable" in result,false);
  assert.equal("actualCostEvidence" in result,false);
  assert.equal("includedCredits" in result.plans[0],false);
  assert.ok(result.limitations.some(item=>item.includes("Provider costs are dated list-price forecasts")));
});
