function parseCreditRate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error("NEON_CUSTOMER_CREDITS_PER_USD must be an explicitly configured positive integer.");
  const rate = Number(text);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 1_000_000) {
    throw new Error("NEON_CUSTOMER_CREDITS_PER_USD must be between 1 and 1,000,000.");
  }
  return BigInt(rate);
}

/**
 * One deterministic USD-to-customer-credit policy shared by approval quoting
 * and post-generation settlement. Provider credits are never treated as
 * customer credits; the same configured conversion is applied to the verified
 * provider charge in integer micros.
 */
export function createNeonCustomerCreditQuotePolicy({ env = process.env } = {}) {
  const rate = parseCreditRate(env.NEON_CUSTOMER_CREDITS_PER_USD);
  return Object.freeze(({ currency, amountMicros } = {}) => {
    if (currency !== "USD" || !Number.isSafeInteger(amountMicros) || amountMicros < 1) {
      const error = new Error("Neon staging customer-credit policy currently requires a verified USD quote.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }
    const amount = BigInt(amountMicros);
    const credits = (amount * rate + 999_999n) / 1_000_000n;
    if (credits < 1n || credits > 100_000_000n) {
      const error = new Error("The production charge exceeds the configured customer-credit bounds.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }
    return Number(credits);
  });
}
