import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const plans=[
 {plan_code:"starter_creator",name:"Starter Creator",amount_minor:900,currency:"USD",billing_interval:"monthly",included_credits:0,status:"draft",is_public:false},
 {plan_code:"professional_creator",name:"Professional Creator",amount_minor:2900,currency:"USD",billing_interval:"monthly",included_credits:0,status:"draft",is_public:false},
 {plan_code:"studio",name:"Studio",amount_minor:7900,currency:"USD",billing_interval:"monthly",included_credits:0,status:"draft",is_public:false},
 {plan_code:"agency",name:"Agency",amount_minor:19900,currency:"USD",billing_interval:"monthly",included_credits:0,status:"draft",is_public:false},
 {plan_code:"enterprise",name:"Enterprise",amount_minor:0,currency:"USD",billing_interval:"monthly",included_credits:0,status:"draft",is_public:false}
];
const pricingEnv={
 CUSTOMER_CREDITS_PER_USD:"100",CUSTOMER_TARGET_MARGIN_BPS:"6500",
 CUSTOMER_PAYMENT_FEE_BPS:"300",CUSTOMER_SUPPORT_RESERVE_BPS:"500",
 CUSTOMER_FIXED_PAYMENT_FEE_MICROS:"0"
};
const scenario={provider:"runway",model:"gen4.5",durationSeconds:10,resolution:"1080p",audio:false,outputFormat:"mp4",pricingDate:"2026-11-22"};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl,env=pricingEnv){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 webhookSecretHash:"webhook-secret",billingEnabled:true,pricingEnv:env,fetchImpl
 });}

test("admin-only plan economics uses persisted draft hypotheses and server-owned provider pricing",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[
   scenario,
   {provider:"runway",model:"kling_4",durationSeconds:10,resolution:"1080p",pricingDate:"2026-11-22"}
  ]}});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const economics=result.body.economics;
 assert.equal(economics.calculationType,"subscription_plan_credit_scenario_not_activation");
 assert.deepEqual(economics.plans.map(plan=>plan.proposedMonthlyCreditAllowance),[630,2030,5530,13930,0]);
 assert.equal(economics.scenarios[0].providerCostUsd,1.2);
 assert.equal(economics.scenarios[0].customerCreditsPerGeneration,394);
 assert.equal(economics.scenarios[1].providerCostUsd,2.35);
 assert.equal(economics.scenarios[1].customerCreditsPerGeneration,772);
 assert.equal(economics.plans[0].modelCoverage[0].maximumWholeGenerations,1);
 assert.equal(economics.plans[0].modelCoverage[1].maximumWholeGenerations,0);
 assert.equal(economics.plans[4].modelCoverage[0].maximumWholeGenerations,0);
 assert.equal(economics.scenarios[0].billable,false);
 assert.equal(economics.scenarios[0].settlementEligible,false);
 assert.equal(calls.filter(call=>call.method!=="GET").length,0,"scenario calculation must not write plans, credits or payments");
 assert.ok(calls.some(call=>call.target.includes("status=eq.draft")&&call.target.includes("is_public=eq.false")));
});

test("subscription economics rejects non-admin users before reading plan or provider data",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);
  throw new Error("A non-admin must not read draft plan economics.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[scenario]}});
 assert.equal(result.status,403);
});

test("subscription economics requires an explicit credit-budget share and bounded scenarios",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  throw new Error("Invalid input must be rejected before data reads.");
 });
 for(const body of [
  {scenarios:[scenario]},
  {creditBudgetShareBps:999,scenarios:[scenario]},
  {creditBudgetShareBps:10001,scenarios:[scenario]},
  {creditBudgetShareBps:7000,scenarios:[]},
  {creditBudgetShareBps:7000,scenarios:Array(21).fill(scenario)}
 ]){
  const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,body});
  assert.equal(result.status,400);
 }
});

test("subscription economics fails closed when server-owned customer credit pricing is not configured",async()=>{
 let planReads=0;
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  if(String(url).includes("/subscription_plans?")){planReads++;return json(plans);}
  throw new Error("Unexpected request");
 },{});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[scenario]}});
 assert.equal(result.status,503);
 assert.equal(result.body.error.code,"CUSTOMER_CREDIT_PRICING_UNCONFIGURED");
 assert.equal(planReads,0);
});

test("subscription economics refuses unsupported model pricing instead of inventing a cost",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(String(url).includes("/subscription_plans?"))return json(plans);
  throw new Error("Unexpected request: "+String(url));
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{...scenario,model:"unlisted-model"}]}});
 assert.equal(result.status,422);
 assert.match(result.body.error.code,/VIDEO_PRICE_UNVERIFIED|VIDEO_PRICE_INPUT_INVALID/);
});

test("subscription economics does not write or activate private draft plan hypotheses",async()=>{
 const writes=[];
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(options.method&&options.method!=="GET")writes.push({target,method:options.method});
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[scenario]}});
 assert.equal(result.status,200);
 assert.deepEqual(writes,[]);
 assert.ok(result.body.economics.limitations.some(value=>value.includes("never persisted or granted")||value.includes("no subscription plan")));
});
