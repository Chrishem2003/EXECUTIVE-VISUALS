import { randomUUID } from "node:crypto";
/**
 * Converts a verified provider estimate into a customer-facing credit preview.
 * This is an estimate only: it never reserves credits or submits a provider job.
 */
export function buildCustomerGenerationCreditQuote({providerEstimate,quoteCustomerCredits}={}) {
  if(!providerEstimate||providerEstimate.available!==true||providerEstimate.estimated!==true) {
    return Object.freeze({available:false,reason:"A current verified provider estimate is required."});
  }
  if(typeof quoteCustomerCredits!=="function") {
    return Object.freeze({available:false,reason:"Customer credit pricing is not configured."});
  }
  if(providerEstimate.currency!=="USD"||!Number.isFinite(providerEstimate.amount)||providerEstimate.amount<=0) {
    return Object.freeze({available:false,reason:"This provider estimate cannot yet be converted safely into customer credits."});
  }
  const amountMicros=Math.round(providerEstimate.amount*1_000_000);
  if(!Number.isSafeInteger(amountMicros)||amountMicros<1) {
    return Object.freeze({available:false,reason:"The provider estimate exceeds safe pricing precision."});
  }
  const credits=quoteCustomerCredits({currency:"USD",amountMicros});
  if(!Number.isSafeInteger(credits)||credits<1||credits>100_000_000) {
    throw Object.assign(new Error("Customer credit pricing returned an invalid credit amount."),{code:"VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID"});
  }
  const customerPriceEvidence=typeof quoteCustomerCredits.quoteCustomerPriceEvidence==="function"
    ? quoteCustomerCredits.quoteCustomerPriceEvidence({
      currency:"USD",amountMicros,evidenceReference:"customer-price-quote:"+randomUUID()
    })
    : null;
  return Object.freeze({
    available:true,
    estimated:true,
    credits,
    unit:"customer_credits",
    ...(customerPriceEvidence?{customerPriceEvidence}:{}),
    provider:providerEstimate.provider,
    model:providerEstimate.model,
    pricingSource:providerEstimate.pricing?.sourceUrl||providerEstimate.pricingSource||null,
    pricingObservedAt:providerEstimate.pricing?.observedAt||null,
    pricingExpiresAt:providerEstimate.pricing?.expiresAt||null,
    pricingDate:providerEstimate.pricingDate||null,
    reservationRequired:true,
    requestsSubmitted:false
  });
}
