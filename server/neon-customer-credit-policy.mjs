function parseInteger(value, name, { min, max }) {
  const text = String(value ?? "").trim();
  if (!text || !Array.from(text).every(char => char >= "0" && char <= "9")) throw new Error(name + " must be explicitly configured as a positive integer.");
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(name + " must be between " + min + " and " + max + ".");
  }
  return BigInt(number);
}

/**
 * One deterministic USD-to-customer-credit policy shared by approval quoting
 * and post-generation settlement. The configured credit rate is the retail
 * credit units per USD of customer price. A positive gross-margin floor is
 * applied to verified provider cost before converting the price to credits.
 *
 * Formula (all integer arithmetic):
 *   minimum sale price = ceil(provider cost / (1 - margin floor))
 *   credits = ceil(minimum sale price in USD * retail credits per USD)
 *
 * This deliberately does not invent FX, payment fees, storage or egress costs.
 * Those costs must be measured and included in the provider-cost evidence
 * before the commercial policy is expanded beyond this baseline.
 */
export function createNeonCustomerCreditQuotePolicy({ env = process.env } = {}) {
  const rate = parseInteger(env.NEON_CUSTOMER_CREDITS_PER_USD,
    "NEON_CUSTOMER_CREDITS_PER_USD", { min: 1, max: 1_000_000 });
  const marginBps = parseInteger(env.NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS,
    "NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS", { min: 100, max: 9_500 });
  const denominator = 10_000n - marginBps;

  return Object.freeze(({ currency, amountMicros } = {}) => {
    if (currency !== "USD" || !Number.isSafeInteger(amountMicros) || amountMicros < 1) {
      const error = new Error("Neon staging customer-credit policy currently requires a verified positive USD provider cost.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }

    const costMicros = BigInt(amountMicros);
    const minimumSaleMicros = (costMicros * 10_000n + denominator - 1n) / denominator;
    const credits = (minimumSaleMicros * rate + 999_999n) / 1_000_000n;

    if (credits < 1n || credits > 100_000_000n) {
      const error = new Error("The production charge exceeds the configured customer-credit bounds.");
      error.code = "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
      throw error;
    }

    return Number(credits);
  });
}
