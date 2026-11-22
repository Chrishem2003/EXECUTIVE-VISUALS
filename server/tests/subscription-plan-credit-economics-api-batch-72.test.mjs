import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";
import {estimateVideoGenerationCost} from "../video-generation-cost-estimator.mjs";
import {createCustomerCreditQuotePolicy} from "../customer-credit-quote-policy.mjs";

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
const scenario={provider:"runway",model:"gen4.5",durationSeconds:10,resolution:"1080p",audio:false,outputFormat:"mp4"};
const quoteCustomerCredits=createCustomerCreditQuotePolicy({env:{
 NEON_CUSTOMER_CREDITS_PER_USD:pricingEnv.CUSTOMER_CREDITS_PER_USD,
 NEON_CUSTOMER_TARGET_MARGIN_BPS:pricingEnv.CUSTOMER_TARGET_MARGIN_BPS,
 NEON_CUSTOMER_PAYMENT_FEE_BPS:pricingEnv.CUSTOMER_PAYMENT_FEE_BPS,
 NEON_CUSTOMER_SUPPORT_RESERVE_BPS:pricingEnv.CUSTOMER_SUPPORT_RESERVE_BPS,
 NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS:pricingEnv.CUSTOMER_FIXED_PAYMENT_FEE_MICROS
}});
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
  if(target.includes("ai_usage_cost_events?"))return json([]);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[
   scenario,
   {provider:"runway",model:"seedance2_5",durationSeconds:10,resolution:"1080p",audio:true}
  ]}});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const economics=result.body.economics;
 assert.equal(economics.calculationType,"subscription_plan_credit_scenario_not_activation");
 assert.deepEqual(economics.plans.map(plan=>plan.proposedMonthlyCreditAllowance),[630,2030,5530,13930,0]);
 assert.equal(economics.scenarios[0].providerCostUsd,1.2);
 assert.deepEqual(economics.pricingPolicy,{
  creditsPerUsd:100,targetMarginBps:6500,paymentFeeBps:300,supportReserveBps:500,fixedPaymentFeeMicros:0
 });
 assert.equal(economics.scenarios[0].customerCreditsPerGeneration,394);
 assert.equal(economics.scenarios[1].providerCostUsd,6.8);
 assert.equal(economics.scenarios[1].customerCreditsPerGeneration,2232);
 assert.equal(economics.plans[0].modelCoverage[0].maximumWholeGenerations,1);
 assert.equal(economics.plans[0].modelCoverage[1].maximumWholeGenerations,0);
 assert.equal(economics.plans[4].modelCoverage[0].maximumWholeGenerations,0);
 assert.equal(economics.scenarios[0].billable,false);
 assert.equal(economics.scenarios[0].settlementEligible,false);
 assert.equal(calls.filter(call=>call.method!=="GET").length,0,"scenario calculation must not write plans, credits or payments");
 assert.ok(calls.some(call=>call.target.includes("status=eq.draft")&&call.target.includes("is_public=eq.false")));
});

test("plan economics uses an exact governed provider rate-card version for Seedance cost scenarios",async()=>{
 const calls=[];
 const rateCard={
  provider:"runway",model:"seedance-2.5",currency:"USD",video_second_minor:68,
  rate_card_version:"2026-11-23.1",billing_unit:"video_second",
  verification_status:"source_linked",source_url:"https://dev.runway.com/pricing",
  source_checked_at:"2026-11-22T00:00:00Z",source_fingerprint:"a".repeat(64),
  effective_from:"2026-11-21T00:00:00Z",effective_to:null,
  pricing_dimensions:{videoSecondMinor_1080p:68,minimumGenerationMinor:80}
 };
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,body:options.body});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("/ai_model_price_catalog?"))return json([rateCard]);
  if(target.includes("ai_usage_cost_events?"))return json([]);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{
   provider:"runway",model:"seedance-2.5",currency:"USD",rateCardVersion:"2026-11-23.1",
   durationSeconds:10,resolution:"1080p",audio:false
  }]}});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const scenarioResult=result.body.economics.scenarios[0];
 assert.equal(scenarioResult.providerCostUsd,6.8);
 assert.equal(scenarioResult.customerCreditsPerGeneration,2232);
 assert.equal(scenarioResult.rateCardVersion,"2026-11-23.1");
 assert.equal(result.body.economics.plans[0].modelCoverage[0].rateCardVersion,"2026-11-23.1");
 const lookup=calls.find(call=>call.target.includes("/ai_model_price_catalog?"));
 assert.ok(lookup.target.includes("provider=eq.runway"));
 assert.ok(lookup.target.includes("model=eq.seedance-2.5"));
 assert.ok(lookup.target.includes("currency=eq.USD"));
 assert.ok(lookup.target.includes("rate_card_version=eq.2026-11-23.1"));
 assert.equal(calls.filter(call=>call.body!==undefined).length,0,"plan economics remains read-only");
});

test("plan economics refuses missing exact rate-card versions instead of silently falling back to static pricing",async()=>{
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("/ai_model_price_catalog?"))return json([]);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{
   provider:"runway",model:"seedance-2.5",currency:"USD",rateCardVersion:"missing-version",
   durationSeconds:10,resolution:"1080p",audio:false
  }]}});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ECONOMICS_RATE_CARD_NOT_FOUND");
});

test("plan economics exposes separate invoice-backed cost evidence and never treats blended cost as model pricing",async()=>{
 const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
 const usageEvents=[],invoiceAttributions=[],creditReservations=[];
 for(let i=1;i<=5;i++){
  const jobId=uuid(100+i),usageId=uuid(200+i);
  usageEvents.push({id:usageId,job_id:jobId,status:"succeeded",period_month:"2026-11-01",provider:"runway",requested_model:"gen4.5",response_model:"gen4.5",operation:"video",currency:"USD",cost_basis:"provider_reported",cost_minor:100});
  invoiceAttributions.push({usage_event_id:usageId,provider:"runway",model:"gen4.5",operation:"video",amount_minor:100,currency:"USD",invoice_import_id:uuid(300+i),invoice_line_id:uuid(400+i),reconciliation_event_id:uuid(500+i),service_cost_event_id:uuid(600+i)});
  creditReservations.push({job_id:jobId,actual_credits:1000,state:"settled"});
 }
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,method:options.method||"GET"});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("ai_usage_cost_events?")&&target.includes("period_month=eq.2026-11-01"))return json(usageEvents);
  if(target.includes("ai_usage_cost_events?")&&target.includes("job_id=in."))return json(usageEvents);
  if(target.includes("financial_cost_attribution_links?"))return json(invoiceAttributions);
  if(target.includes("billing_credit_reservations?"))return json(creditReservations);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,periodMonth:"2026-11-01",scenarios:[scenario]}});
 assert.equal(result.status,200,JSON.stringify({body:result.body,calls}));
 assert.equal(result.body.actualCostEvidence.status,"verified_measured");
 assert.equal(result.body.actualCostEvidence.sampleJobs,5);
 assert.equal(result.body.actualCostEvidence.sampleCredits,5000);
 assert.equal(result.body.actualCostEvidence.totalProviderCostMinor,500);
 assert.equal(result.body.actualCostEvidence.providerCostPerCustomerCreditMinor,1);
 assert.equal(result.body.actualCostEvidence.currency,"USD");
 assert.equal(result.body.actualCostEvidence.perModelAttributionAvailable,true);
 assert.equal(result.body.actualCostEvidence.workloadCostStatus,"verified_model_operation_actual_cost_available");
 assert.equal(result.body.modelActualCostEvidence.status,"verified_measured");
 assert.equal(result.body.modelActualCostEvidence.verifiedModelGroups,1);
 assert.equal(result.body.modelActualCostEvidence.models[0].provider,"runway");
 assert.equal(result.body.modelActualCostEvidence.models[0].model,"gen4.5");
 assert.equal(result.body.modelActualCostEvidence.models[0].operation,"video");
 assert.equal(result.body.modelActualCostEvidence.models[0].totalProviderCostMinor,500);
 assert.equal(result.body.modelActualCostEvidence.models[0].invoiceCoverage,1);
 assert.equal(result.body.allowanceReadiness.publishable,false);
 assert.match(result.body.allowanceReadiness.status,/requires_finance_product_approval/);
 assert.ok(result.body.economics.scenarios.every(row=>row.estimateType==="forecast_not_actual"));
 assert.ok(calls.every(call=>call.method==="GET"));
});

test("plan economics blocks actual-cost readiness when invoice sample is insufficient or truncated",async()=>{
 const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
 const small=Array.from({length:4},(_,i)=>({id:uuid(200+i),job_id:uuid(100+i),status:"succeeded",period_month:"2026-11-01"}));
 const service=api(async(url)=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("ai_usage_cost_events?")&&target.includes("period_month=eq."))return json(small);
  if(target.includes("ai_usage_cost_events?")&&target.includes("job_id=in."))return json(small);
  if(target.includes("financial_cost_attribution_links?"))return json(small.map((row,i)=>({usage_event_id:row.id,amount_minor:100,currency:"USD",invoice_import_id:uuid(300+i),invoice_line_id:uuid(400+i)})));
  if(target.includes("billing_credit_reservations?"))return json(small.map(row=>({job_id:row.job_id,actual_credits:1000,state:"settled"})));
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,periodMonth:"2026-11-01",scenarios:[scenario]}});
 assert.equal(result.status,200);
 assert.equal(result.body.actualCostEvidence.status,"insufficient_sample");
 assert.equal(result.body.actualCostEvidence.providerCostPerCustomerCreditMinor,null);
 assert.equal(result.body.allowanceReadiness.status,"blocked_waiting_for_sufficient_complete_invoice_evidence");
 assert.equal(result.body.allowanceReadiness.publishable,false);
});

test("rejects browser-supplied invoice or actual-cost evidence before reading financial data",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  throw new Error("Untrusted cost evidence must be rejected before financial reads.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[scenario],actualCostEvidence:{status:"verified_measured",providerCostPerCustomerCreditMinor:0}}});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ECONOMICS_INPUT_INVALID");
});

test("treats a capped invoice usage query as incomplete and does not perform attribution joins",async()=>{
 const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
 const capped=Array.from({length:1000},(_,i)=>({id:uuid(2000+i),job_id:uuid(4000+i),status:"succeeded",period_month:"2026-11-01"}));
 const calls=[];
 const service=api(async(url)=>{
  const target=String(url);calls.push(target);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("ai_usage_cost_events?"))return json(capped);
  throw new Error("A capped sample must not query invoice links or reservations.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,periodMonth:"2026-11-01",scenarios:[scenario]}});
 assert.equal(result.status,200);
 assert.equal(result.body.actualCostEvidence.status,"sample_incomplete");
 assert.equal(result.body.actualCostEvidence.sampleComplete,false);
 assert.equal(result.body.actualCostEvidence.providerCostPerCustomerCreditMinor,null);
 assert.equal(result.body.allowanceReadiness.status,"blocked_waiting_for_sufficient_complete_invoice_evidence");
 assert.equal(calls.some(url=>url.includes("financial_cost_attribution_links?")),false);
 assert.equal(calls.some(url=>url.includes("billing_credit_reservations?")),false);
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

test("subscription economics rejects unknown scenario fields rather than silently ignoring them",async()=>{
 const service=api(async(url)=>{
  if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);
  if(String(url).includes("/subscription_plans?"))return json(plans);
  throw new Error("Unexpected request");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{...scenario,estimatedCostUsd:0.01}]}});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ECONOMICS_SCENARIO_INVALID");
});

test("subscription economics does not write or activate private draft plan hypotheses",async()=>{
 const writes=[];
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("ai_usage_cost_events?"))return json([]);
  if(options.method&&options.method!=="GET")writes.push({target,method:options.method});
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[scenario]}});
 assert.equal(result.status,200);
 assert.deepEqual(writes,[]);
 assert.ok(result.body.economics.limitations.some(value=>value.includes("never persisted or granted")||value.includes("no subscription plan")));
});

test("plan economics includes the exact governed Kling 4.0 HDR surcharge in the customer-cost forecast",async()=>{
 const rateCard={
  provider:"runway",model:"kling-4.0",currency:"USD",video_second_minor:24,
  rate_card_version:"2026-11-23.kling4-hdr",billing_unit:"mixed",
  verification_status:"source_linked",source_url:"https://dev.runwayml.com/learn/kling-4-0-api",
  source_checked_at:"2026-11-22T00:00:00Z",source_fingerprint:"b".repeat(64),
  effective_from:"2026-11-22T00:00:00Z",effective_to:null,
  pricing_dimensions:{hdrSurchargeSecondMinor_1080p:5}
 };
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url);calls.push({target,method:options.method||"GET",body:options.body});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("/ai_model_price_catalog?"))return json([rateCard]);
  if(target.includes("ai_usage_cost_events?"))return json([]);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{
   provider:"runway",model:"kling-4.0",currency:"USD",rateCardVersion:"2026-11-23.kling4-hdr",
   durationSeconds:10,resolution:"1080p",audio:false,hdr:true
  }]}});
 assert.equal(result.status,200,JSON.stringify(result.body));
 const row=result.body.economics.scenarios[0];
 assert.equal(row.providerCostUsd,2.9);
 assert.equal(row.rateCardVersion,"2026-11-23.kling4-hdr");
 const lookup=calls.find(call=>call.target.includes("/ai_model_price_catalog?"));
 assert.ok(lookup.target.includes("rate_card_version=eq.2026-11-23.kling4-hdr"));
 assert.equal(calls.filter(call=>call.method!=="GET").length,0,"plan economics remains read-only");
});

test("plan economics fails closed when HDR is requested without a governed surcharge",async()=>{
 const rateCard={
  provider:"runway",model:"kling-4.0",currency:"USD",video_second_minor:235,
  rate_card_version:"2026-11-23.kling4-no-hdr",billing_unit:"video_second",
  verification_status:"source_linked",source_url:"https://dev.runwayml.com/learn/kling-4-0-api",
  source_checked_at:"2026-11-22T00:00:00Z",source_fingerprint:"c".repeat(64),
  effective_from:"2026-11-22T00:00:00Z",effective_to:null,pricing_dimensions:{}
 };
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"owner"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("/ai_model_price_catalog?"))return json([rateCard]);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{
   provider:"runway",model:"kling-4.0",currency:"USD",rateCardVersion:"2026-11-23.kling4-no-hdr",
   durationSeconds:10,resolution:"1080p",audio:false,hdr:true
  }]}});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"PROVIDER_VIDEO_HDR_PRICING_UNRESOLVED");
});

test("plan economics rejects string and numeric HDR flags instead of silently pricing SDR",async()=>{
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  if(target.includes("/ai_model_price_catalog?"))return json([{
   provider:"runway",model:"kling-4.0",currency:"USD",video_second_minor:24,
   rate_card_version:"2026-11-23.strict-flags",billing_unit:"mixed",
   verification_status:"source_linked",source_url:"https://dev.runwayml.com/learn/kling-4-0-api",
   source_checked_at:"2026-11-22T00:00:00Z",source_fingerprint:"d".repeat(64),
   effective_from:"2026-11-22T00:00:00Z",effective_to:null,
   pricing_dimensions:{hdrSurchargeSecondMinor_1080p:5}
  }]);
  if(target.includes("ai_usage_cost_events?"))return json([]);
  throw new Error("Unexpected request: "+target);
 });
 for(const hdr of ["true",1,0]){
  const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
   body:{creditBudgetShareBps:7000,scenarios:[{
    provider:"runway",model:"kling-4.0",currency:"USD",rateCardVersion:"2026-11-23.strict-flags",
    durationSeconds:10,resolution:"1080p",audio:false,hdr
   }]}});
  assert.equal(result.status,422);
  assert.equal(result.body.error.code,"SUBSCRIPTION_ECONOMICS_MEDIA_FLAG_INVALID");
 }
});

test("plan economics rejects non-boolean audio selections instead of silently changing provider pricing",async()=>{
 const service=api(async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("/subscription_plans?"))return json(plans);
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-plan-economics",ownerId:owner,
  body:{creditBudgetShareBps:7000,scenarios:[{...scenario,audio:"false"}]}});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ECONOMICS_MEDIA_FLAG_INVALID");
});
