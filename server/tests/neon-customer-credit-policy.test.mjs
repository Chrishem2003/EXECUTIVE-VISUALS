import test from "node:test";
import assert from "node:assert/strict";
import { createNeonCustomerCreditQuotePolicy } from "../neon-customer-credit-policy.mjs";

const env = {
  NEON_CUSTOMER_CREDITS_PER_USD: "100",
  NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS: "3000"
};

test("prices provider cost with the configured minimum gross margin using integer micro arithmetic", () => {
  const quote = createNeonCustomerCreditQuotePolicy({ env });
  // $1.00 provider cost at a 30% gross-margin floor requires $1.428572
  // minimum sale price; at 100 credits/USD, round up to 143 credits.
  assert.equal(quote({ currency: "USD", amountMicros: 1_000_000 }), 143);
  assert.equal(quote({ currency: "USD", amountMicros: 1_250_000 }), 179);
  assert.equal(quote({ currency: "USD", amountMicros: 1 }), 1);
});

test("applies the same versioned policy to actual-cost settlement inputs", () => {
  const quote = createNeonCustomerCreditQuotePolicy({ env });
  const approved = quote({ currency: "USD", amountMicros: 1_000_000 });
  const actual = quote({ currency: "USD", amountMicros: 900_000 });
  assert.equal(approved, 143);
  assert.equal(actual, 129);
  assert.ok(actual <= approved);
});

test("rejects non-USD, zero, fractional-micro and unsafe actual charges", () => {
  const quote = createNeonCustomerCreditQuotePolicy({ env: {
    ...env, NEON_CUSTOMER_CREDITS_PER_USD: "250"
  } });
  for (const input of [
    { currency: "EUR", amountMicros: 1_000_000 },
    { currency: "USD", amountMicros: 0 },
    { currency: "USD", amountMicros: 1.5 },
    { currency: "USD", amountMicros: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.throws(() => quote(input), error => error.code === "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
  }
});

test("requires a bounded explicit retail credit conversion rate", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "1000001", "NaN"]) {
    assert.throws(() => createNeonCustomerCreditQuotePolicy({
      env: { ...env, NEON_CUSTOMER_CREDITS_PER_USD: value }
    }), /NEON_CUSTOMER_CREDITS_PER_USD/);
  }
});

test("requires an explicit positive and bounded gross-margin floor", () => {
  for (const value of [undefined, "", "0", "99", "9501", "10000", "-1", "30.5", "NaN"]) {
    assert.throws(() => createNeonCustomerCreditQuotePolicy({
      env: { ...env, NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS: value }
    }), /NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS/);
  }
});

test("rounding credits upward never falls below the configured gross-margin floor", () => {
  const marginBps = 3500n;
  const quote = createNeonCustomerCreditQuotePolicy({
    env: { NEON_CUSTOMER_CREDITS_PER_USD: "137", NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS: String(marginBps) }
  });
  for (const cost of [1, 17, 999, 1_000_001, 10_000_000, 99_999_999]) {
    const credits = BigInt(quote({ currency: "USD", amountMicros: cost }));
    const saleMicros = (credits * 1_000_000n + 136n) / 137n;
    const marginNumerator = (saleMicros - BigInt(cost)) * 10_000n;
    assert.ok(marginNumerator >= saleMicros * marginBps, "rounded sale price must meet the margin floor");
  }
});

test("rejects conversion results outside the supported customer-credit bounds", () => {
  const quote = createNeonCustomerCreditQuotePolicy({
    env: { NEON_CUSTOMER_CREDITS_PER_USD: "1000000", NEON_CUSTOMER_MIN_GROSS_MARGIN_BPS: "9500" }
  });
  assert.throws(() => quote({ currency: "USD", amountMicros: 100_000_000 }), {
    code: "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID"
  });
});
