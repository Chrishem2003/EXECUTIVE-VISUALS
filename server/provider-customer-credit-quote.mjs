const MAX_SAFE=BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Bridges a governed provider-cost forecast into the customer credit economy.
 * This never reserves credits or treats the forecast as an actual invoice.
 */
export function quoteProviderVideoCustomerCredits({
  providerEstimate,quoteCustomerCredits,creditsPerUsd
}={}){
  if(!providerEstimate||providerEstimate.estimateType!=="provider_cost_forecast_not_actual"||
    providerEstimate.currency!=="USD"||!Number.isSafeInteger(providerEstimate.estimatedProviderCostMinor)||
    providerEstimate.estimatedProviderCostMinor<1)
    throw Object.assign(new Error("A positive USD provider-cost forecast is required."),{code:"PROVIDER_CUSTOMER_QUOTE_COST_INVALID"});
  if(typeof quoteCustomerCredits!=="function"||!Number.isSafeInteger(creditsPerUsd)||creditsPerUsd<1||creditsPerUsd>1_000_000)
    throw Object.assign(new Error("Server-owned customer credit pricing must be explicitly configured."),{code:"PROVIDER_CUSTOMER_QUOTE_POLICY_UNAVAILABLE"});
  const providerCostMicros=BigInt(providerEstimate.estimatedProviderCostMinor)*10_000n;
  if(providerCostMicros>MAX_SAFE)
    throw Object.assign(new Error("Provider cost exceeds safe USD micro-unit bounds."),{code:"PROVIDER_CUSTOMER_QUOTE_COST_INVALID"});
  const amountMicros=Number(providerCostMicros);
  const customerCredits=quoteCustomerCredits({currency:"USD",amountMicros});
  if(!Number.isSafeInteger(customerCredits)||customerCredits<1||customerCredits>100_000_000)
    throw Object.assign(new Error("Customer credit policy returned an invalid charge."),{code:"PROVIDER_CUSTOMER_QUOTE_CREDITS_INVALID"});
  const retailValueMicros=(BigInt(customerCredits)*1_000_000n+BigInt(creditsPerUsd)-1n)/BigInt(creditsPerUsd);
  if(retailValueMicros>MAX_SAFE)
    throw Object.assign(new Error("Customer credit value exceeds safe USD micro-unit bounds."),{code:"PROVIDER_CUSTOMER_QUOTE_CREDITS_INVALID"});
  const retailMicros=Number(retailValueMicros);
  const contributionMarginBps=Math.floor((retailMicros-amountMicros)*10_000/retailMicros);
  return Object.freeze({
    quoteType:"estimated_customer_credit_quote_not_a_reservation",
    provider:providerEstimate.provider,model:providerEstimate.model,
    rateCardVersion:providerEstimate.rateCardVersion,
    currency:"USD",providerCostMinor:providerEstimate.estimatedProviderCostMinor,
    providerCostMicros:amountMicros,customerCredits,
    creditConversionRatePerUsd:creditsPerUsd,
    creditEquivalentRetailValueMicros:retailMicros,
    estimatedPreFeeContributionMarginBps:contributionMarginBps,
    billable:false,reservesCredits:false,usesActualInvoice:false,
    limitations:Object.freeze([
      "Forecast based on the selected effective provider rate-card version; not an invoice or guaranteed provider charge.",
      "Credit-equivalent retail value is a pricing reference; subscription-included credits are not a separate cash charge.",
      "Contribution margin is before payment processing, refunds, taxes, support and infrastructure costs.",
      "This quote does not reserve, deduct, grant or transfer customer credits; the generation approval transaction remains authoritative."
    ])
  });
}
