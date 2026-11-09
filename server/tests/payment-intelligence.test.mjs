import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyFlutterwaveWebhook, verifyFlutterwaveV3Webhook, hashWebhookPayload,
  parseRefundStatus, minorToMajor, validateRefundRequest,
  calculateCreditReversal, shouldRetryPaymentFailure, calculatePaymentRetryAt,
  initiateFlutterwaveRefund
} from "../payment-intelligence.mjs";

test("Flutterwave v4 webhook signature verifies exact raw bytes and rejects tampering", () => {
  const raw = Buffer.from('{"event":"refund.completed","data":{"id":"rfd_1"}}');
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.equal(verifyFlutterwaveWebhook(raw, signature, secret), true);
  assert.equal(verifyFlutterwaveWebhook(Buffer.from(raw.toString() + " "), signature, secret), false);
  assert.equal(verifyFlutterwaveWebhook(raw, signature, "wrong-secret"), false);
  assert.equal(verifyFlutterwaveWebhook(raw, "", secret), false);
});

test("legacy v3 secret hash comparison is constant-time and exact", () => {
  assert.equal(verifyFlutterwaveV3Webhook("configured-secret", "configured-secret"), true);
  assert.equal(verifyFlutterwaveV3Webhook("configured-secret ", "configured-secret"), false);
  assert.equal(verifyFlutterwaveV3Webhook("", "configured-secret"), false);
});

test("webhook payload hashes are stable SHA-256 fingerprints", () => {
  const raw = Buffer.from('{"id":1}');
  assert.equal(hashWebhookPayload(raw), hashWebhookPayload(Buffer.from(raw)));
  assert.throws(() => hashWebhookPayload("not bytes"), /raw request body/);
});

test("refund statuses normalize without treating initiated v3 refunds as final", () => {
  assert.equal(parseRefundStatus("new"), "processing");
  assert.equal(parseRefundStatus("pending-momo"), "processing");
  assert.equal(parseRefundStatus("completed"), "processing");
  assert.equal(parseRefundStatus("completed-bank-transfer"), "succeeded");
  assert.equal(parseRefundStatus("succeeded"), "succeeded");
  assert.equal(parseRefundStatus("failed"), "failed");
  assert.equal(parseRefundStatus("unknown-provider-status"), "processing");
});

test("minor currency conversion handles UGX and two-decimal currencies", () => {
  assert.equal(minorToMajor(25000, "UGX"), 25000);
  assert.equal(minorToMajor(1250, "USD"), 12.5);
  assert.throws(() => minorToMajor(0, "UGX"), { code: "INVALID_AMOUNT" });
  assert.throws(() => minorToMajor(100, "XYZ"), { code: "UNSUPPORTED_CURRENCY" });
});

test("refund validation supports multiple partial refunds but prevents over-refunding", () => {
  const first = validateRefundRequest({
    paymentStatus: "successful", paymentAmountMinor: 10000,
    alreadyRefundedMinor: 0, requestedAmountMinor: 2500,
    paymentCurrency: "UGX"
  });
  assert.deepEqual(first, { amountMinor: 2500, remainingAfterMinor: 7500, isPartial: true });
  const second = validateRefundRequest({
    paymentStatus: "successful", paymentAmountMinor: 10000,
    alreadyRefundedMinor: 2500, requestedAmountMinor: 7500,
    paymentCurrency: "UGX"
  });
  assert.equal(second.isPartial, false);
  assert.throws(() => validateRefundRequest({
    paymentStatus: "successful", paymentAmountMinor: 10000,
    alreadyRefundedMinor: 9000, requestedAmountMinor: 1001,
    paymentCurrency: "UGX"
  }), { code: "REFUND_EXCEEDS_REMAINING" });
  assert.throws(() => validateRefundRequest({
    paymentStatus: "pending", paymentAmountMinor: 10000,
    requestedAmountMinor: 1000, paymentCurrency: "UGX"
  }), { code: "PAYMENT_NOT_REFUNDABLE" });
  assert.throws(() => validateRefundRequest({
    paymentStatus: "successful", paymentAmountMinor: 10000,
    requestedAmountMinor: 1000, paymentCurrency: "UGX", requestedCurrency: "USD"
  }), { code: "REFUND_CURRENCY_MISMATCH" });
});

test("credit reversal is proportional, cumulative and idempotency-friendly", () => {
  const first = calculateCreditReversal({
    originalCreditUnits: 1000, originalPaymentAmountMinor: 10000,
    cumulativeConfirmedRefundedMinor: 2500
  });
  assert.deepEqual(first, { targetReversedCreditUnits: 250, reversalDelta: 250 });
  const second = calculateCreditReversal({
    originalCreditUnits: 1000, originalPaymentAmountMinor: 10000,
    cumulativeConfirmedRefundedMinor: 5000, alreadyReversedCreditUnits: 250
  });
  assert.deepEqual(second, { targetReversedCreditUnits: 500, reversalDelta: 250 });
  const final = calculateCreditReversal({
    originalCreditUnits: 1000, originalPaymentAmountMinor: 10000,
    cumulativeConfirmedRefundedMinor: 10000, alreadyReversedCreditUnits: 500
  });
  assert.deepEqual(final, { targetReversedCreditUnits: 1000, reversalDelta: 500 });
  assert.throws(() => calculateCreditReversal({
    originalCreditUnits: 100, originalPaymentAmountMinor: 1000,
    cumulativeConfirmedRefundedMinor: 1001
  }), { code: "REFUND_TOTAL_EXCEEDED" });
});

test("payment retry policy retries transient failures only", () => {
  assert.equal(shouldRetryPaymentFailure("timeout"), true);
  assert.equal(shouldRetryPaymentFailure("processor_unavailable"), true);
  assert.equal(shouldRetryPaymentFailure("insufficient_funds"), false);
  assert.equal(shouldRetryPaymentFailure("card_declined"), false);
  assert.equal(calculatePaymentRetryAt({
    attemptNumber: 1, now: new Date("2026-11-10T00:00:00.000Z")
  }), "2026-11-10T00:05:00.000Z");
  assert.equal(calculatePaymentRetryAt({
    attemptNumber: 3, now: new Date("2026-11-10T00:00:00.000Z")
  }), "2026-11-10T00:20:00.000Z");
  assert.throws(() => calculatePaymentRetryAt({ attemptNumber: 0 }), { code: "INVALID_RETRY_ATTEMPT" });
});

test("Flutterwave refund client obtains OAuth token and sends idempotency headers to sandbox", async () => {
  const captured=[];
  const result = await initiateFlutterwaveRefund({
    chargeId: "chg_test", amountMinor: 25000, currency: "UGX",
    reason: "Customer request", idempotencyKey: "refund-once",
    traceId: "trace-once", clientId: "test-client", clientSecret: "test-client-secret",
    fetchImpl: async (url, options) => {
      captured.push({ url: String(url), options });
      if(String(url)==="https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token") {
        return new Response(JSON.stringify({access_token:"test-access-token",expires_in:600}), {status:200,headers:{"content-type":"application/json"}});
      }
      return new Response(JSON.stringify({
        message: "Refund Initiated",
        data: { id: "rfd_test", amount_refunded: 25000, status: "pending", charge_id: "chg_test" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(captured.length,2);
  assert.equal(captured[0].url,"https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token");
  assert.equal(captured[0].options.headers["content-type"],"application/x-www-form-urlencoded");
  assert.equal(String(captured[0].options.body).includes("grant_type=client_credentials"),true);
  assert.equal(captured[1].url, "https://developersandbox-api.flutterwave.com/refunds");
  assert.equal(captured[1].options.headers.authorization,"Bearer test-access-token");
  assert.equal(captured[1].options.headers["x-idempotency-key"], "refund-once");
  assert.equal(captured[1].options.headers["x-trace-id"], "trace-once");
  assert.deepEqual(JSON.parse(captured[1].options.body), {
    amount: 25000, reason: "Customer request", charge_id: "chg_test"
  });
  assert.equal(result.providerRefundId, "rfd_test");
  assert.equal(result.status, "processing");
});
