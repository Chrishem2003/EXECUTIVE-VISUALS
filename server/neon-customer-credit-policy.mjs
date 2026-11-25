import { createHash } from "node:crypto";
import { priceWorkloadCostUnits } from "./ai-workload-economics.mjs";

function parseInteger(value, name, { min, max }) {
  const text = String(value ?? "").trim();
  if (!text || !Array.from(text).every(char => char >= "0" && char <= "9")) {
    throw new Error(name + " must be explicitly configured as a positive integer.");
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(name + " must be between " + min + " and " + max + ".");
  }
  return BigInt(number);
}

function parseOptionalInteger(value, name, fallback, { min, max }) {
  if (value === undefined || value === null || String(value).trim() === "") return BigInt(fallback);
  return parseInteger(value, name, { min, max });
}

/**
 * Server-owned bridge from the shared workload-economics pricing engine to
 * customer credits. The existing pricing engine applies target margin,
 * payment fees and support reserve; this module only converts its minimum
 * USD-micro sale price into integer customer credits.
 *
 * Provider estimates and verified actual charges use the same deterministic
 * policy. Provider credits are never treated as customer credits.
 */
export function createNeonCustomerCreditQuotePolicy({ env = process.env } = {}) {
  const rate = parseInteger(env.NEON_CUSTOMER_CREDITS_PER_USD,
    "NEON_CUSTOMER_CREDITS_PER_USD", { min: 1, max: 1_000_000 });
  const targetMarginBps = parseInteger(env.NEON_CUSTOMER_TARGET_MARGIN_BPS,
    "NEON_CUSTOMER_TARGET_MARGIN_BPS", { min: 1_000, max: 9_000 });
  const paymentFeeBps = parseOptionalInteger(env.NEON_CUSTOMER_PAYMENT_FEE_BPS,
    "NEON_CUSTOMER_PAYMENT_FEE_BPS", 300, { min: 0, max: 2_000 });
  const supportReserveBps = parseOptionalInteger(env.NEON_CUSTOMER_SUPPORT_RESERVE_BPS,
    "NEON_CUSTOMER_SUPPORT_RESERVE_BPS", 500, { min: 0, max: 5_000 });
  const fixedPaymentFeeMicros = parseOptionalInteger(env.NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS,
    "NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS", 0, { min: 0, max: 100_000_000 });

  const pricing = Object.freeze({
    targetMarginBps: Number(targetMarginBps),
    paymentFeeBps: Number(paymentFeeBps),
    supportReserveBps: Number(supportReserveBps),
    fixedPaymentFeeMinor: Number(fixedPaymentFeeMicros)
  });

  const quoteCustomerCredits = ({ currency, amountMicros } = {}) => {
    if (currency !== "USD" || !Number.isSafeInteger(amountMicros) || amountMicros < 1) {
      const error = new Error("Customer-credit pricing requires a verified positive USD provider cost.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }

    let minimumPriceMicros;
    try {
      minimumPriceMicros = BigInt(priceWorkloadCostUnits(amountMicros, pricing).minimumPriceUnits);
    } catch (cause) {
      const error = new Error("The shared workload pricing policy could not produce a safe customer price.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      error.cause = cause;
      throw error;
    }
    const credits = (minimumPriceMicros * rate + 999_999n) / 1_000_000n;

    if (credits < 1n || credits > 100_000_000n) {
      const error = new Error("The production charge exceeds the configured customer-credit bounds.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }

    return Number(credits);
  };
  const quoteCustomerPrice = ({ currency, amountMicros } = {}) => {
    if (currency !== "USD" || !Number.isSafeInteger(amountMicros) || amountMicros < 1) {
      const error = new Error("Customer price quoting requires a verified positive USD cost.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }
    let minimumPriceMicros;
    try {
      minimumPriceMicros = BigInt(priceWorkloadCostUnits(amountMicros, pricing).minimumPriceUnits);
    } catch (cause) {
      const error = new Error("The shared workload pricing policy could not produce a safe customer price.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      error.cause = cause;
      throw error;
    }
    if (minimumPriceMicros < 1n || minimumPriceMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
      const error = new Error("The customer price exceeds safe currency micro-unit bounds.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }
    return Number(minimumPriceMicros);
  };
  const policyFingerprint = createHash("sha256").update(JSON.stringify({
    policyVersion: "customer-credit-pricing-v1",
    creditsPerUsd: Number(rate),
    targetMarginBps: Number(targetMarginBps),
    paymentFeeBps: Number(paymentFeeBps),
    supportReserveBps: Number(supportReserveBps),
    fixedPaymentFeeMicros: Number(fixedPaymentFeeMicros)
  })).digest("hex");
  const quoteCustomerPriceEvidence = ({ currency, amountMicros, evidenceReference } = {}) => {
    if (typeof evidenceReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/.test(evidenceReference)) {
      const error = new Error("A server-generated customer price quote reference is required.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }
    const customerPriceMicros = quoteCustomerPrice({ currency, amountMicros });
    const payload = { currency, amountMicros, customerPriceMicros, evidenceReference, policyFingerprint };
    const evidenceSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return Object.freeze({
      status: "verified_quote", currency, customerPriceMicros, evidenceReference,
      policyFingerprint, evidenceSha256
    });
  };
  Object.defineProperty(quoteCustomerCredits, "quoteCustomerPrice", {
    value: quoteCustomerPrice,
    enumerable: true
  });
  Object.defineProperty(quoteCustomerCredits, "quoteCustomerPriceEvidence", {
    value: quoteCustomerPriceEvidence,
    enumerable: true
  });
  Object.defineProperty(quoteCustomerCredits, "assumptions", {
    value: Object.freeze({
      creditsPerUsd: Number(rate),
      targetMarginBps: Number(targetMarginBps),
      paymentFeeBps: Number(paymentFeeBps),
      supportReserveBps: Number(supportReserveBps),
      fixedPaymentFeeMicros: Number(fixedPaymentFeeMicros)
    }),
    enumerable: true
  });
  return Object.freeze(quoteCustomerCredits);
}

// Generic alias shared by Supabase cloud quotes and the isolated Neon staging path.
export const createCustomerCreditQuotePolicy = createNeonCustomerCreditQuotePolicy;
