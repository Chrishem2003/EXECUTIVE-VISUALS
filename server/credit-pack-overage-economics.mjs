import {convertProviderCostWithApprovedFx} from "./approved-fx-rate-conversion.mjs";
const CURRENCY=/^[A-Z]{3}$/;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const integer=(value,name,{min=0,max=Number.MAX_SAFE_INTEGER}={})=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("CREDIT_PACK_ECONOMICS_INPUT_INVALID",name+" must be a bounded integer.");
 return value;
};

/**
 * Read-only top-up profitability using the verified blended provider cost per
 * platform credit. It never converts currencies: product and evidence
 * currencies must match exactly. No FX is inferred from market rates.
 */
export function calculateCreditPackOverageEconomics({products=[],costEvidence,pricingPolicy,fxEvidence=null}={}){
 if(!Array.isArray(products)||products.length>100)fail("CREDIT_PACK_ECONOMICS_INPUT_INVALID","Credit-pack products must be a bounded array.");
 if(!pricingPolicy||typeof pricingPolicy!=="object"||Array.isArray(pricingPolicy))
  fail("CREDIT_PACK_ECONOMICS_POLICY_REQUIRED","Server-owned payment and margin assumptions are required.");
 const paymentFeeBps=integer(pricingPolicy.paymentFeeBps,"Payment fee basis points",{max:2000});
 const supportReserveBps=integer(pricingPolicy.supportReserveBps,"Support reserve basis points",{max:5000});
 const targetMarginBps=integer(pricingPolicy.targetMarginBps,"Target margin basis points",{min:1000,max:9000});
 const fixedPaymentFeeMicros=integer(pricingPolicy.fixedPaymentFeeMicros,"Fixed payment fee micros",{max:100000000});
 const fixedPaymentFeeMinor=Math.ceil(fixedPaymentFeeMicros/10000);
 const evidenceReady=costEvidence?.status==="verified_measured"&&
  CURRENCY.test(String(costEvidence.currency||""))&&
  Number.isSafeInteger(costEvidence.providerCostPerCustomerCreditMinor)&&
  costEvidence.providerCostPerCustomerCreditMinor>0&&
  Number.isSafeInteger(costEvidence.sampleJobs)&&costEvidence.sampleJobs>=5&&
  /^\d{4}-\d{2}-01$/.test(String(costEvidence.periodMonth||""));
 const rows=products.map(product=>{
  if(!product||typeof product!=="object"||Array.isArray(product))fail("CREDIT_PACK_ECONOMICS_INPUT_INVALID","Each credit-pack product must be an object.");
  const productCode=String(product.product_code||"").trim();
  const name=String(product.name||"").trim();
  const currency=String(product.currency||"").trim().toUpperCase();
  const amountMinor=Number(product.amount_minor),creditUnits=Number(product.credit_units);
  if(!/^[a-z0-9][a-z0-9_-]{2,59}$/.test(productCode)||!name||name.length>160||
     !CURRENCY.test(currency)||!Number.isSafeInteger(amountMinor)||amountMinor<=0||
     !Number.isSafeInteger(creditUnits)||creditUnits<=0||product.product_type!=="credit_pack"||
     typeof product.active!=="boolean")
   fail("CREDIT_PACK_ECONOMICS_PRODUCT_INVALID","Product code, type, amount, currency, credit units and active state must be explicit.");
  const base={productCode,name,currency,amountMinor,creditUnits,active:product.active,checkoutEligible:false};
  if(!evidenceReady)return Object.freeze({...base,status:"blocked_invoice_evidence",providerCostMinor:null,paymentFeeMinor:null,supportReserveMinor:null,contributionMinor:null,contributionMarginBps:null,marginAssessment:"not_measurable"});
  const sourceProviderCostMinor=costEvidence.providerCostPerCustomerCreditMinor*creditUnits;
  if(!Number.isSafeInteger(sourceProviderCostMinor)||sourceProviderCostMinor>9_000_000_000_000)
   fail("CREDIT_PACK_ECONOMICS_OVERFLOW","Provider cost for this pack exceeds safe calculation bounds.");
  let providerCostMinor=sourceProviderCostMinor,conversion=null;
  if(currency!==costEvidence.currency){
   conversion=convertProviderCostWithApprovedFx({amountMinor:sourceProviderCostMinor,sourceCurrency:costEvidence.currency,
    targetCurrency:currency,periodMonth:costEvidence.periodMonth,fxEvidence});
   if(conversion.status!=="converted_with_approved_settlement_evidence")return Object.freeze({...base,
    status:conversion.status,costCurrency:costEvidence.currency,providerCostMinor:null,paymentFeeMinor:null,
    supportReserveMinor:null,contributionMinor:null,contributionMarginBps:null,marginAssessment:"blocked_fx_evidence",
    fxReason:conversion.reason});
   providerCostMinor=conversion.amountMinor;
  }
  const paymentFeeMinor=Math.ceil(amountMinor*paymentFeeBps/10000)+fixedPaymentFeeMinor;
  const supportReserveMinor=Math.ceil(amountMinor*supportReserveBps/10000);
  const contributionMinor=amountMinor-providerCostMinor-paymentFeeMinor-supportReserveMinor;
  const contributionMarginBps=Math.floor(contributionMinor*10000/amountMinor);
  const marginAssessment=contributionMarginBps>=targetMarginBps?"meets_target_before_other_costs":"below_target_before_other_costs";
  return Object.freeze({...base,status:"measured_scenario_only",costCurrency:currency,
   providerCostPerCreditMinor:costEvidence.providerCostPerCustomerCreditMinor,providerCostMinor,
   paymentFeeMinor,supportReserveMinor,contributionMinor,contributionMarginBps,
   targetMarginBps,marginAssessment,customerChargeCreated:false,checkoutEnabled:false});
 });
 const blocked=rows.filter(row=>row.status!=="measured_scenario_only").length;
 return Object.freeze({
  calculationType:"credit_pack_overage_profitability_scenario_not_activation",
  status:!evidenceReady?"blocked_invoice_evidence":!products.length?"no_credit_pack_products":blocked?"partially_blocked":"measured_scenario_only",
  evidence: Object.freeze({status:costEvidence?.status||"missing",currency:costEvidence?.currency||null,
   periodMonth:costEvidence?.periodMonth||null,sampleJobs:costEvidence?.sampleJobs??null,
   providerCostPerCustomerCreditMinor:evidenceReady?costEvidence.providerCostPerCustomerCreditMinor:null,
   rateCardVersion:costEvidence?.evidence?.rateCardVersion||null}),
  pricingAssumptions:Object.freeze({paymentFeeBps,supportReserveBps,targetMarginBps,fixedPaymentFeeMicros}),
  products:Object.freeze(rows),
  limitations:Object.freeze([
   "Provider cost per platform credit is derived only from complete, posted USD invoice attribution and settled generation-credit reservations with at least five verified jobs.",
   "Credit-pack product prices are read from the server-owned catalogue; browser-supplied product prices and credit units are never accepted.",
   "Foreign-exchange conversion is permitted only with approved same-month processor-settlement or bank-statement evidence. Official reference and tax rates are not accepted for settlement-cost margin.",
   "This uses historical blended provider cost per platform credit, not model-specific future cost. Retries, storage, delivery, taxes, refunds, chargebacks, acquisition and other overhead are excluded.",
   "The result is read-only. It does not activate products, enable checkout, create charges, grant credits or change subscription entitlements."
  ])
 });
}
