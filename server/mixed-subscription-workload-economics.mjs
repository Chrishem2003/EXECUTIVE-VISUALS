const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const integer=(value,label,{min=0,max=100000}={})=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID",label+" must be a bounded integer.");
 return value;
};
const label=(value,name,max=120)=>{
 if(typeof value!=="string"||!value.trim()||value.trim().length>max)fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID",name+" is required.");
 return value.trim();
};

/** Read-only mixed-model workload comparison against hypothetical draft plan allowances. */
export function calculateMixedSubscriptionWorkloadEconomics({planEconomics,workloads}={}){
 if(!planEconomics||planEconomics.calculationType!=="subscription_plan_credit_scenario_not_activation"||
    !Array.isArray(planEconomics.plans)||!Array.isArray(planEconomics.scenarios))
  fail("SUBSCRIPTION_WORKLOAD_ECONOMICS_INPUT_INVALID","A valid read-only subscription-plan economics result is required.");
 if(planEconomics.plans.length<1||planEconomics.plans.length>20||planEconomics.scenarios.length<1||planEconomics.scenarios.length>20)
  fail("SUBSCRIPTION_WORKLOAD_ECONOMICS_INPUT_INVALID","The plan and provider scenario collections must be bounded and non-empty.");
 if(!Array.isArray(workloads)||workloads.length<1||workloads.length>20)
  fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Provide between one and twenty named monthly workload mixes.");
 const policy=planEconomics.pricingPolicy;
 if(!policy||typeof policy!=="object"||Array.isArray(policy))
  fail("SUBSCRIPTION_WORKLOAD_ECONOMICS_INPUT_INVALID","The shared customer-credit pricing policy is required for margin analysis.");
 const targetMarginBps=integer(policy.targetMarginBps,"target margin basis points",{min:1000,max:9000});
 const paymentFeeBps=integer(policy.paymentFeeBps,"payment fee basis points",{min:0,max:2000});
 const supportReserveBps=integer(policy.supportReserveBps,"support reserve basis points",{min:0,max:5000});
 const fixedPaymentFeeMicros=integer(policy.fixedPaymentFeeMicros,"fixed payment fee micros",{min:0,max:100000000});
 const ceilDiv=(numerator,denominator)=>Math.floor((numerator+denominator-1)/denominator);
 const scenarios=planEconomics.scenarios;
 const normalized=workloads.map(workload=>{
  if(!workload||typeof workload!=="object"||Array.isArray(workload))fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Each workload must be an object.");
  const name=label(workload.name,"workload name");
  if(!Array.isArray(workload.items)||workload.items.length<1||workload.items.length>50)
   fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Each workload must contain between one and fifty scenario lines.");
  const merged=new Map();
  for(const item of workload.items){
   if(!item||typeof item!=="object"||Array.isArray(item))fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Each workload line must be an object.");
   const scenarioIndex=integer(item.scenarioIndex,"scenario index",{min:0,max:scenarios.length-1});
   const quantity=integer(item.quantity,"monthly quantity",{min:1,max:10000});
   merged.set(scenarioIndex,(merged.get(scenarioIndex)||0)+quantity);
   if(merged.get(scenarioIndex)>10000)fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Combined monthly quantity exceeds the supported limit.");
  }
  const lines=[...merged.entries()].map(([scenarioIndex,quantity])=>{
   const scenario=scenarios[scenarioIndex];
   if(!scenario||typeof scenario!=="object"||Array.isArray(scenario))
    fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","The selected provider scenario is unavailable.");
   const providerCostUsd=Number(scenario.providerCostUsd);
   if(!Number.isFinite(providerCostUsd)||providerCostUsd<0||providerCostUsd>10_000_000)
    fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Scenario provider cost must be a finite, non-negative USD amount.");
   const creditsPerGeneration=integer(scenario.customerCreditsPerGeneration,"scenario customer credits",{min:1,max:100000000});
   const creditsRequired=quantity*creditsPerGeneration;
   if(!Number.isSafeInteger(creditsRequired))fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Monthly credit requirement exceeds safe bounds.");
   const providerSpendUsd=Number((quantity*providerCostUsd).toFixed(6));
   if(!Number.isFinite(providerSpendUsd)||providerSpendUsd>10_000_000)
    fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Monthly line provider spend exceeds safe bounds.");
   return Object.freeze({scenarioIndex,provider:scenario.provider,model:scenario.model,operation:scenario.operation,
    durationSeconds:scenario.durationSeconds,resolution:scenario.resolution,quantity,
    providerCostPerGenerationUsd:providerCostUsd,providerSpendUsd,
    customerCreditsPerGeneration:creditsPerGeneration,creditsRequired});
  });
  const totalCredits=lines.reduce((sum,line)=>sum+line.creditsRequired,0);
  if(!Number.isSafeInteger(totalCredits)||totalCredits>1_000_000_000)
   fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Total monthly workload credits exceed safe bounds.");
  const providerSpendUsd=Number(lines.reduce((sum,line)=>sum+line.providerSpendUsd,0).toFixed(6));
  if(!Number.isFinite(providerSpendUsd)||providerSpendUsd>10_000_000)
   fail("SUBSCRIPTION_WORKLOAD_MIX_INVALID","Total monthly provider spend exceeds safe bounds.");
  return Object.freeze({name,lines:Object.freeze(lines),totalCredits,providerSpendUsd});
 });
 const plans=planEconomics.plans.map(plan=>{
  if(!plan||typeof plan!=="object"||Array.isArray(plan))fail("SUBSCRIPTION_WORKLOAD_ECONOMICS_INPUT_INVALID","Each draft plan must be an object.");
  const amountMinor=integer(plan.amountMinor,"draft plan price in minor units",{min:0,max:100_000_000});
  const priceUsd=amountMinor/100;
  const monthlyCreditAllowance=integer(plan.proposedMonthlyCreditAllowance,"hypothetical monthly credit allowance",{min:0,max:100000000});
  const mixes=normalized.map(workload=>{
   const creditShortfall=Math.max(0,workload.totalCredits-monthlyCreditAllowance);
   const providerCostMinor=priceUsd>0?Math.ceil(workload.providerSpendUsd*100-1e-9):null;
   const paymentFeeMinor=priceUsd>0
    ?ceilDiv(amountMinor*paymentFeeBps,10000)+ceilDiv(fixedPaymentFeeMicros,10000):null;
   const supportReserveMinor=priceUsd>0?ceilDiv(amountMinor*supportReserveBps,10000):null;
   const modeledContributionMinor=priceUsd>0
    ?amountMinor-providerCostMinor-paymentFeeMinor-supportReserveMinor:null;
   const modeledContributionMarginBps=priceUsd>0
    ?Math.floor(modeledContributionMinor*10000/amountMinor):null;
   const marginAssessment=priceUsd<=0?"custom_price_required":
    creditShortfall>0?"not_applicable_credit_shortfall":
    modeledContributionMarginBps>=targetMarginBps?"meets_target_before_other_costs":"below_target_before_other_costs";
   return Object.freeze({workloadName:workload.name,monthlyCreditAllowance,creditsRequired:workload.totalCredits,
    creditsRemaining:Math.max(0,monthlyCreditAllowance-workload.totalCredits),creditShortfall,
    fitsCreditAllowance:creditShortfall===0,estimatedProviderSpendUsd:workload.providerSpendUsd,
    estimatedProviderCostMinor:providerCostMinor,
    estimatedPaymentFeeMinor:paymentFeeMinor,estimatedSupportReserveMinor:supportReserveMinor,
    estimatedContributionAfterProviderPaymentAndSupportUsd:modeledContributionMinor===null?null:Number((modeledContributionMinor/100).toFixed(2)),
    estimatedContributionMarginBps:modeledContributionMarginBps,targetMarginBps,
    marginAssessment,targetMarginMet:marginAssessment==="meets_target_before_other_costs",
    providerCostRatioOfPlanRevenue:priceUsd>0?Number((workload.providerSpendUsd/priceUsd).toFixed(6)):null,
    estimatedContributionBeforePaymentFeesSupportStorageAndOtherCostsUsd:priceUsd>0?Number((priceUsd-workload.providerSpendUsd).toFixed(6)):null,
    lines:workload.lines});
  });
  return Object.freeze({planCode:plan.planCode,planName:plan.name,monthlyPriceUsd:priceUsd,monthlyCreditAllowance,mixes:Object.freeze(mixes)});
 });
 return Object.freeze({calculationType:"mixed_monthly_workload_scenario_not_forecast_or_activation",
  workloadDefinitions:Object.freeze(normalized),plans:Object.freeze(plans),
  pricingAssumptions:Object.freeze({targetMarginBps,paymentFeeBps,supportReserveBps,fixedPaymentFeeMicros}),
  limitations:Object.freeze([
   "Workloads are illustrative monthly scenarios supplied by an administrator, not measured customer behavior or demand forecasts.",
   "Provider spend uses dated list-price estimates; retries, failed-but-billable tasks, reference media, taxes, foreign exchange and provider invoice variance may change actual cost.",
   "Modeled contribution deducts forecast provider spend, configured payment-fee assumptions and support reserve only; storage, delivery, refunds, taxes, infrastructure, acquisition and other operating costs remain excluded. It is not net profit.",
   "The target-margin check is a scenario signal before excluded operating costs, not an approval to publish plan prices or allowances.",
   "A workload exceeding included credits is marked not applicable for included-plan margin; any top-up revenue and top-up credit economics must be modeled separately.",
   "The plan credit allowance is hypothetical and derived from the explicit Batch 72 credit-budget-share assumption; this calculation does not approve or grant credits.",
   "Enterprise plans with a custom price are not evaluated as a priced subscription until a contract price is supplied through a separately approved process."
  ])});
}
