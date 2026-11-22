const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const safeInteger=(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={})=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID",label+" must be a bounded integer.");
 return value;
};
const text=(value,label,max=160)=>{
 if(typeof value!=="string"||!value.trim()||value.trim().length>max)fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID",label+" is required.");
 return value.trim();
};

/**
 * Read-only scenario calculator. Plan credit allowances are hypothetical and
 * are never persisted or granted. Generation prices come from the same
 * server-owned customer-credit quote policy used by workflow approval.
 */
export function calculateSubscriptionPlanCreditEconomics({
 plans,scenarios,quoteCustomerCredits,creditsPerUsd,creditBudgetShareBps
}={}){
 if(!Array.isArray(plans)||plans.length<1||plans.length>20)fail("SUBSCRIPTION_ECONOMICS_PLANS_INVALID","One to twenty persisted draft plans are required.");
 if(!Array.isArray(scenarios)||scenarios.length<1||scenarios.length>20)fail("SUBSCRIPTION_ECONOMICS_SCENARIOS_INVALID","One to twenty provider cost scenarios are required.");
 if(typeof quoteCustomerCredits!=="function")fail("CUSTOMER_CREDIT_PRICING_UNCONFIGURED","The server-side customer-credit pricing policy is unavailable.");
 const rate=safeInteger(creditsPerUsd,"creditsPerUsd",{min:1,max:1_000_000});
 const share=safeInteger(creditBudgetShareBps,"creditBudgetShareBps",{min:1000,max:10000});
 const normalizedPlans=plans.map(plan=>{
  const planCode=text(plan.plan_code??plan.planCode,"plan code",80);
  const name=text(plan.name,"plan name",120);
  const currency=text(plan.currency,"plan currency",3).toUpperCase();
  const billingInterval=text(plan.billing_interval??plan.billingInterval,"billing interval",20);
  const status=text(plan.status,"plan status",30);
  if(status!=="draft"||plan.is_public===true||plan.isPublic===true)fail("SUBSCRIPTION_ECONOMICS_PLAN_NOT_DRAFT","Only private draft plan hypotheses can be evaluated.");
  if(currency!=="USD"||billingInterval!=="monthly")fail("SUBSCRIPTION_ECONOMICS_PLAN_UNSUPPORTED","Only monthly USD draft plans can be evaluated in this version.");
  const amountMinor=safeInteger(plan.amount_minor??plan.amountMinor,"plan amount",{min:0,max:100_000_000});
  const includedCredits=safeInteger(plan.included_credits??plan.includedCredits??0,"persisted included credits",{min:0,max:100_000_000});
  if(includedCredits!==0)fail("SUBSCRIPTION_ECONOMICS_PLAN_ALREADY_CONFIGURED","A plan with configured credits must not be treated as an unconfigured pricing hypothesis.");
  const numerator=BigInt(amountMinor)*BigInt(rate)*BigInt(share);
  const allowance=Number(numerator/1_000_000n);
  if(!Number.isSafeInteger(allowance)||allowance>100_000_000)fail("SUBSCRIPTION_ECONOMICS_CREDIT_OVERFLOW","Proposed plan credits exceed safe bounds.");
  return Object.freeze({planCode,name,currency,billingInterval,status,amountMinor,proposedMonthlyCreditAllowance:allowance});
 });
 const pricedScenarios=scenarios.map(scenario=>{
  const provider=text(scenario.provider,"provider",80).toLowerCase();
  const model=text(scenario.model,"model",160);
  const currency=text(scenario.currency,"provider currency",3).toUpperCase();
  const pricingSource=text(scenario.pricingSource,"pricing source",500);
  const pricingDate=text(scenario.pricingDate,"pricing date",40);
  if(currency!=="USD"||scenario.billable!==false||scenario.settlementEligible!==false)
   fail("SUBSCRIPTION_ECONOMICS_PROVIDER_ESTIMATE_INVALID","Scenarios must be non-billable USD forecasts, not settlement evidence.");
  const amount=Number(scenario.amount);
  if(!Number.isFinite(amount)||amount<=0||amount>1_000_000)fail("SUBSCRIPTION_ECONOMICS_PROVIDER_COST_INVALID","Provider cost must be a positive bounded USD estimate.");
  const amountMicros=Math.round(amount*1_000_000);
  if(!Number.isSafeInteger(amountMicros)||amountMicros<1||Math.abs(amount*1_000_000-amountMicros)>0.0001)
   fail("SUBSCRIPTION_ECONOMICS_PROVIDER_COST_INVALID","Provider cost must normalize exactly to USD micro-units.");
  const customerCredits=quoteCustomerCredits({currency:"USD",amountMicros});
  safeInteger(customerCredits,"customer generation credits",{min:1,max:100_000_000});
  const durationSeconds=Number(scenario.durationSeconds);
  if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>600)
   fail("SUBSCRIPTION_ECONOMICS_SCENARIO_INVALID","Scenario duration must be between 0 and 600 seconds.");
  const resolution=text(scenario.resolution||"provider_default","resolution",30);
  return Object.freeze({
   provider,model,currency,operation:String(scenario.operation||"video"),durationSeconds,resolution,
   providerCostUsd:Number(amount.toFixed(6)),customerCreditsPerGeneration:customerCredits,
   pricingSource,pricingDate,estimateType:"forecast_not_actual",billable:false,settlementEligible:false
  });
 });
 const coverage=normalizedPlans.map(plan=>{
  const modelCoverage=pricedScenarios.map(scenario=>{
   const generations=Math.floor(plan.proposedMonthlyCreditAllowance/scenario.customerCreditsPerGeneration);
   const creditsUsed=generations*scenario.customerCreditsPerGeneration;
   const providerSpendUsd=Number((generations*scenario.providerCostUsd).toFixed(6));
   return Object.freeze({
    provider:scenario.provider,model:scenario.model,operation:scenario.operation,
    durationSeconds:scenario.durationSeconds,resolution:scenario.resolution,
    customerCreditsPerGeneration:scenario.customerCreditsPerGeneration,
    maximumWholeGenerations:generations,creditsUsed,creditsRemaining:plan.proposedMonthlyCreditAllowance-creditsUsed,
    estimatedProviderSpendUsd:providerSpendUsd,pricingSource:scenario.pricingSource,pricingDate:scenario.pricingDate
   });
  });
  return Object.freeze({...plan,modelCoverage:Object.freeze(modelCoverage)});
 });
 return Object.freeze({
  calculationType:"subscription_plan_credit_scenario_not_activation",
  creditBudgetShareBps:share,creditsPerUsd:rate,
  plans:Object.freeze(coverage),scenarios:Object.freeze(pricedScenarios),
  limitations:Object.freeze([
   "All plan allowances are hypothetical; no subscription plan, entitlement or credit ledger is changed.",
   "The credit budget share is an explicit scenario assumption, not a recommended or approved allowance.",
   "Provider costs are dated list-price forecasts; invoice, retries, refunds, taxes, FX, storage and delivery costs may differ.",
   "Each model-coverage row assumes the entire plan credit allowance is spent only on that one model and request shape.",
   "Monthly subscription revenue recognition and unused-credit breakage require separate accounting treatment."
  ])
 });
}
