const CURRENCY=/^[A-Z]{3}$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
function amount(value,label,{integer=true,min=0,max=Number.MAX_SAFE_INTEGER}={}){
 if(value===undefined||value===null||value==="")throw fail("CREDIT_PRICING_INPUT_REQUIRED",label+" is required.");
 const number=Number(value);
 if(!Number.isFinite(number)||number<min||number>max||(integer&&!Number.isSafeInteger(number)))
  throw fail("CREDIT_PRICING_INPUT_INVALID",label+" must be "+(integer?"a safe integer":"a finite number")+" within the allowed range.");
 return number;
}
function normalizeCommon(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw fail("CREDIT_PRICING_INPUT_INVALID","Pricing input must be an object.");
 const currency=String(input.currency||"").toUpperCase();
 if(!CURRENCY.test(currency))throw fail("CREDIT_PRICING_CURRENCY_REQUIRED","An ISO 4217 currency is required; currencies cannot be combined.");
 const paymentFeeBps=amount(input.paymentFeeBps,"Payment fee basis points",{max:5000});
 const feeVatBps=amount(input.feeVatBps,"VAT on payment fee basis points",{max:3000});
 const targetMarginBps=amount(input.targetMarginBps,"Target contribution margin basis points",{max:9000});
 const fixedPaymentFeeMinor=amount(input.fixedPaymentFeeMinor??0,"Fixed payment fee",{max:1_000_000_000});
 const feeRate=paymentFeeBps/10000*(1+feeVatBps/10000);
 if(feeRate+targetMarginBps/10000>=1)throw fail("CREDIT_PRICING_MARGIN_UNREACHABLE","Payment fees and target margin leave no room for costs.");
 return {currency,paymentFeeBps,feeVatBps,targetMarginBps,fixedPaymentFeeMinor,feeRate};
}
function feeFor(price,common){
 return Math.ceil(price*common.paymentFeeBps/10000*(1+common.feeVatBps/10000))+common.fixedPaymentFeeMinor;
}
function money(value){return Math.ceil(value-1e-10);}
function marginBps(revenue,contribution){return revenue>0?Math.floor(contribution/revenue*10000):0;}

/**
 * Calculate a minimum customer price from explicitly supplied, evidenced costs.
 * All money values are integer minor units; no provider rate is inferred here.
 */
export function calculateCreditPriceFloor(input={}){
 const common=normalizeCommon(input);
 const providerCostMinor=amount(input.providerCostMinor,"Provider cost",{max:1_000_000_000_000});
 const infrastructureCostMinor=amount(input.infrastructureCostMinor,"Allocated infrastructure cost",{max:1_000_000_000_000});
 const retryAllowanceMinor=amount(input.retryAllowanceMinor,"Expected retry cost",{max:1_000_000_000_000});
 const creditUnits=amount(input.creditUnits,"Credit units",{max:1_000_000_000});
 if(creditUnits<1)throw fail("CREDIT_PRICING_INPUT_INVALID","Credit units must be at least one.");
 const directCostMinor=providerCostMinor+infrastructureCostMinor+retryAllowanceMinor;
 const denominator=1-common.feeRate-common.targetMarginBps/10000;
 const rawFloor=(directCostMinor+common.fixedPaymentFeeMinor)/denominator;
 const minimumPriceMinor=money(rawFloor);
 const processingFeeMinor=feeFor(minimumPriceMinor,common);
 const contributionMinor=minimumPriceMinor-processingFeeMinor-directCostMinor;
 const actualMarginBps=marginBps(minimumPriceMinor,contributionMinor);
 return {
  currency:common.currency,creditUnits,providerCostMinor,infrastructureCostMinor,retryAllowanceMinor,
  directCostMinor,paymentFeeBps:common.paymentFeeBps,feeVatBps:common.feeVatBps,
  processingFeeMinor,minimumPriceMinor,minimumPricePerCreditMinor:Math.ceil(minimumPriceMinor/creditUnits),
  contributionMinor,actualMarginBps,targetMarginBps:common.targetMarginBps,
  costEvidenceRequired:true,customerChargeCreated:false
 };
}

/**
 * Maximum monthly allowance using a measured, blended variable cost per credit.
 * This is a ceiling, not a recommendation to grant the full amount.
 */
export function calculateSubscriptionCreditCeiling(input={}){
 const common=normalizeCommon(input);
 const monthlyPriceMinor=amount(input.monthlyPriceMinor,"Monthly subscription price",{max:1_000_000_000_000});
 const fixedServiceCostMinor=amount(input.fixedServiceCostMinor,"Monthly fixed service cost",{max:1_000_000_000_000});
 const variableCostPerCreditMinor=amount(input.variableCostPerCreditMinor,"Measured variable cost per credit",{integer:false,min:Number.MIN_VALUE,max:1_000_000_000});
 const targetContributionMinor=money(monthlyPriceMinor*common.targetMarginBps/10000);
 const processingFeeMinor=feeFor(monthlyPriceMinor,common);
 const availableForCreditsMinor=monthlyPriceMinor-processingFeeMinor-fixedServiceCostMinor-targetContributionMinor;
 const maximumIncludedCredits=availableForCreditsMinor<=0?0:Math.floor((availableForCreditsMinor+1e-9)/variableCostPerCreditMinor);
 const projectedVariableCostMinor=maximumIncludedCredits*variableCostPerCreditMinor;
 const contributionMinor=monthlyPriceMinor-processingFeeMinor-fixedServiceCostMinor-projectedVariableCostMinor;
 return {
  currency:common.currency,monthlyPriceMinor,paymentFeeBps:common.paymentFeeBps,feeVatBps:common.feeVatBps,
  processingFeeMinor,fixedServiceCostMinor,variableCostPerCreditMinor,targetMarginBps:common.targetMarginBps,
  targetContributionMinor,maximumIncludedCredits,projectedVariableCostMinor,projectedContributionMinor:contributionMinor,
  projectedMarginBps:marginBps(monthlyPriceMinor,contributionMinor),
  costEvidenceRequired:true,subscriptionEntitlementChanged:false
 };
}
