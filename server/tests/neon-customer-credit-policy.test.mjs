import test from "node:test";
import assert from "node:assert/strict";
import { createNeonCustomerCreditQuotePolicy } from "../neon-customer-credit-policy.mjs";

test("uses one deterministic integer-micro USD conversion for approval and actual settlement", () => {
  const quote = createNeonCustomerCreditQuotePolicy({ env: { NEON_CUSTOMER_CREDITS_PER_USD: "100" } });
  assert.equal(quote({ currency: "USD", amountMicros: 1_000_000 }), 100);
  assert.equal(quote({ currency: "USD", amountMicros: 1_250_000 }), 125);
  assert.equal(quote({ currency: "USD", amountMicros: 1 }), 1);
});

test("rejects non-USD, zero, fractional-micro and unsafe actual charges", () => {
  const quote = createNeonCustomerCreditQuotePolicy({ env: { NEON_CUSTOMER_CREDITS_PER_USD: "250" } });
  for (const input of [
    { currency: "EUR", amountMicros: 1_000_000 },
    { currency: "USD", amountMicros: 0 },
    { currency: "USD", amountMicros: 1.5 },
    { currency: "USD", amountMicros: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.throws(() => quote(input), error => error.code === "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
  }
});

test("requires a bounded explicit positive conversion rate", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "1000001", "NaN"]) {
    assert.throws(() => createNeonCustomerCreditQuotePolicy({
      env: { NEON_CUSTOMER_CREDITS_PER_USD: value }
    }), /NEON_CUSTOMER_CREDITS_PER_USD/);
  }
});
