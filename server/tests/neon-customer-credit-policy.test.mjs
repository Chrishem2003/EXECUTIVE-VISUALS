import test from "node:test";
import assert from "node:assert/strict";
import { createNeonCustomerCreditQuotePolicy } from "../neon-customer-credit-policy.mjs";
import { priceWorkloadCostUnits } from "../ai-workload-economics.mjs";

const env = {
  NEON_CUSTOMER_CREDITS_PER_USD: "100",
  NEON_CUSTOMER_TARGET_MARGIN_BPS: "3000",
  NEON_CUSTOMER_PAYMENT_FEE_BPS: "0",
  NEON_CUSTOMER_SUPPORT_RESERVE_BPS: "0",
  NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS: "0"
};

test("converts the shared workload-economics minimum price into customer credits", () => {
  const quote = createNeonCustomerCreditQuotePolicy({ env });
  // Shared engine: $1 provider cost at a 30% margin requires $1.428572.
  // At 100 customer credits per USD, round the customer charge up to 143.
  assert.equal(quote({ currency: "USD", amountMicros: 1_000_000 }), 143);
  assert.equal(quote({ currency: "USD", amountMicros: 1_250_000 }), 179);
  assert.equal(quote({ currency: "USD", amountMicros: 1 }), 1);
});

test("uses the same pricing policy for approval reservation and actual-cost settlement", () => {
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

test("requires an explicit bounded retail credit conversion rate", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "1000001", "NaN"]) {
    assert.throws(() => createNeonCustomerCreditQuotePolicy({
      env: { ...env, NEON_CUSTOMER_CREDITS_PER_USD: value }
    }), /NEON_CUSTOMER_CREDITS_PER_USD/);
  }
});

test("requires an explicit target margin and validates optional payment/reserve assumptions", () => {
  for (const value of [undefined, "", "0", "999", "9001", "10000", "-1", "30.5", "NaN"]) {
    assert.throws(() => createNeonCustomerCreditQuotePolicy({
      env: { ...env, NEON_CUSTOMER_TARGET_MARGIN_BPS: value }
    }), /NEON_CUSTOMER_TARGET_MARGIN_BPS/);
  }
  for (const [key, value] of [
    ["NEON_CUSTOMER_PAYMENT_FEE_BPS", "2001"],
    ["NEON_CUSTOMER_SUPPORT_RESERVE_BPS", "5001"],
    ["NEON_CUSTOMER_FIXED_PAYMENT_FEE_MICROS", "-1"]
  ]) {
    assert.throws(() => createNeonCustomerCreditQuotePolicy({ env: { ...env, [key]: value } }));
  }
});

test("credit rounding never undercuts the shared pricing engine's minimum price", () => {
  const assumptions = {
    targetMarginBps: 3500,
    paymentFeeBps: 300,
    supportReserveBps: 500,
    fixedPaymentFeeMinor: 0
  };
  const quote = createNeonCustomerCreditQuotePolicy({
    env: {
      NEON_CUSTOMER_CREDITS_PER_USD: "137",
      NEON_CUSTOMER_TARGET_MARGIN_BPS: "3500",
      NEON_CUSTOMER_PAYMENT_FEE_BPS: "300",
      NEON_CUSTOMER_SUPPORT_RESERVE_BPS: "500"
    }
  });
  for (const cost of [1, 17, 999, 1_000_001, 10_000_000, 99_999_999]) {
    const credits = BigInt(quote({ currency: "USD", amountMicros: cost }));
    const saleMicros = (credits * 1_000_000n + 136n) / 137n;
    const minimumPriceMicros = BigInt(priceWorkloadCostUnits(cost, assumptions).minimumPriceUnits);
    assert.ok(saleMicros >= minimumPriceMicros, "rounded credits must cover the shared engine's minimum sale price");
  }
});

test("rejects conversion results outside the supported customer-credit bounds", () => {
  const quote = createNeonCustomerCreditQuotePolicy({
    env: {
      NEON_CUSTOMER_CREDITS_PER_USD: "1000000",
      NEON_CUSTOMER_TARGET_MARGIN_BPS: "9000",
      NEON_CUSTOMER_PAYMENT_FEE_BPS: "0",
      NEON_CUSTOMER_SUPPORT_RESERVE_BPS: "0"
    }
  });
  assert.throws(() => quote({ currency: "USD", amountMicros: 100_000_000 }), {
    code: "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID"
  });
});
