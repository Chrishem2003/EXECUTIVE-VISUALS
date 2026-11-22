const BPS=10_000;
const MAX_MINOR=9_000_000_000_000;
const PROPOSED_SUBSCRIPTION_PLANS=Object.freeze([
 Object.freeze({planCode:"starter_creator",name:"Starter Creator",monthlyPriceMinor:900,currency:"USD"}),
 Object.freeze({planCode:"professional_creator",name:"Professional Creator",monthlyPriceMinor:2900,currency:"USD"}),
 Object.freeze({planCode:"studio",name:"Studio",monthlyPriceMinor:7900,currency:"USD"}),
 Object.freeze({planCode:"agency",name:"Agency",monthlyPriceMinor:19900,currency:"USD"})
]);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function integer(value,label,{min=0,max=MAX_MINOR}={}){
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID",label+" must be a bounded integer.");
 return value;
}
function bps(value,label,{max=10_000}={}){
 return integer(value,label,{min:0,max});
}
function ceilBps(amount,rate){return Number((BigInt(amount)*BigInt(rate)+9999n)/10000n);}
function floorBps(amount,rate){return Number((BigInt(amount)*BigInt(rate))/10000n);}
function date(value,label){
 if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))fail("SUBSCRIPTION_ECONOMICS_EVIDENCE_INVALID",label+" must be a valid date.");
 return Date.parse(value);
}
function validateEvidence(evidence,costPerCreditMinor){
 if(costPerCreditMinor===undefined||costPerCreditMinor===null)return null;
 integer(costPerCreditMinor,"provider cost per customer credit",{min:1});
 if(!evidence||typeof evidence!=="object"||Array.isArray(evidence)||
    evidence.status!=="verified_measured"||evidence.approved!==false||
    typeof evidence.source!=="string"||evidence.source.trim().length<3||
    typeof evidence.rateCardVersion!=="string"||evidence.rateCardVersion.trim().length<1||
    !Number.isSafeInteger(evidence.sampleJobs)||evidence.sampleJobs<1)
  fail("SUBSCRIPTION_ECONOMICS_EVIDENCE_INVALID","Credit allowances require server-verified measured provider-cost evidence; finance/product approval is a separate release gate. A source, calculation-method version and sample size are also required.");
 const start=date(evidence.periodStart,"evidence periodStart");
 const end=date(evidence.periodEnd,"evidence periodEnd");
 if(end<=start)fail("SUBSCRIPTION_ECONOMICS_EVIDENCE_INVALID","Evidence periodEnd must follow periodStart.");
 return Object.freeze({
  status:"verified_measured",approved:false,source:evidence.source.trim().slice(0,240),
  rateCardVersion:evidence.rateCardVersion.trim().slice(0,100),
  sampleJobs:evidence.sampleJobs,periodStart:new Date(start).toISOString(),
  periodEnd:new Date(end).toISOString()
 });
}
function normalizePlan(plan){
 if(!plan||typeof plan!=="object"||Array.isArray(plan))fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID","Each plan must be an object.");
 const planCode=String(plan.planCode||"").trim().toLowerCase();
 const name=String(plan.name||"").trim();
 const currency=String(plan.currency||"").trim().toUpperCase();
 if(!/^[a-z][a-z0-9_-]{1,63}$/.test(planCode)||!name||name.length>100||currency!=="USD")
  fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID","Plan identity and USD currency are required.");
 return Object.freeze({planCode,name,currency,monthlyPriceMinor:integer(plan.monthlyPriceMinor,"monthly plan price",{min:1})});
}
/**
 * Scenario-only allowance model. All monetary inputs are USD cents.
 * It never publishes plan credits, writes entitlements or changes billing.
 */
export function simulateSubscriptionAllowances({
 plans=PROPOSED_SUBSCRIPTION_PLANS,
 targetGrossMarginBps,
 paymentFeeBps,
 fixedPaymentFeeMinor=0,
 refundReserveBps=0,
 supportReserveMinor=0,
 infrastructureReserveMinor=0,
 providerCostPerCustomerCreditMinor,
 costEvidence
}={}){
 if(!Array.isArray(plans)||plans.length<1||plans.length>100)fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID","A bounded plan list is required.");
 const margin=bps(targetGrossMarginBps,"target gross margin",{max:9500});
 const payment=bps(paymentFeeBps,"payment fee");
 const refund=bps(refundReserveBps,"refund reserve");
 if(payment+refund>=BPS)fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID","Payment and refund reserves must total less than 100%.");
 const fixedFee=integer(fixedPaymentFeeMinor,"fixed payment fee");
 const support=integer(supportReserveMinor,"support reserve");
 const infrastructure=integer(infrastructureReserveMinor,"infrastructure reserve");
 const evidence=validateEvidence(costEvidence,providerCostPerCustomerCreditMinor);
 const costPerCredit=providerCostPerCustomerCreditMinor==null?null:integer(providerCostPerCustomerCreditMinor,"provider cost per customer credit",{min:1});
 const seen=new Set();
 const results=plans.map(raw=>{
  const plan=normalizePlan(raw);
  if(seen.has(plan.planCode))fail("SUBSCRIPTION_ECONOMICS_INPUT_INVALID","Plan codes must be unique.");
  seen.add(plan.planCode);
  const paymentFeeMinor=ceilBps(plan.monthlyPriceMinor,payment)+fixedFee;
  const refundReserveAmountMinor=ceilBps(plan.monthlyPriceMinor,refund);
  const netAfterPaymentAndRefundMinor=Math.max(0,plan.monthlyPriceMinor-paymentFeeMinor-refundReserveAmountMinor);
  const totalCostCeilingMinor=floorBps(netAfterPaymentAndRefundMinor,BPS-margin);
  const fixedDeliveryReserveMinor=support+infrastructure;
  const providerCostBudgetMinor=Math.max(0,totalCostCeilingMinor-fixedDeliveryReserveMinor);
  const maxProviderCostAtTargetMarginMinor=providerCostBudgetMinor;
  const estimatedIncludedCredits=costPerCredit===null?null:Number(BigInt(providerCostBudgetMinor)/BigInt(costPerCredit));
  return Object.freeze({
   ...plan,paymentFeeMinor,refundReserveMinor:refundReserveAmountMinor,
   netAfterPaymentAndRefundMinor,targetGrossMarginBps:margin,
   totalCostCeilingMinor,fixedDeliveryReserveMinor,
   providerCostBudgetMinor,maxProviderCostAtTargetMarginMinor,
   providerCostPerCustomerCreditMinor:costPerCredit,
   estimatedIncludedCredits,
   allowanceStatus:costPerCredit===null?"awaiting_approved_cost_evidence":"scenario_only_requires_product_finance_approval",
   publishable:false
  });
 });
 return Object.freeze({
  currency:"USD",moneyUnit:"minor_units",estimateType:"scenario_forecast_not_actual",
  assumptions:Object.freeze({targetGrossMarginBps:margin,paymentFeeBps:payment,fixedPaymentFeeMinor:fixedFee,
   refundReserveBps:refund,supportReserveMinor:support,infrastructureReserveMinor:infrastructure}),
  costEvidence:evidence,
  creditAllowanceCalculated:costPerCredit!==null,
  plans:Object.freeze(results),
  limitations:Object.freeze([
   "Scenario output is not invoice or payment evidence.",
   "Provider costs must be measured from reconciled usage and versioned rate cards.",
   "A customer credit is a platform unit, not a provider credit or currency amount.",
   "Credits remain unpublished until finance and product approval; this simulator never writes entitlements."
  ])
 });
}
export {PROPOSED_SUBSCRIPTION_PLANS};
