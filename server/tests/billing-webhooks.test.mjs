import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import {
  ensureBillingSchema, touchBillingAccount, saveBillingPlan, getBillingBalance
} from "../billing.mjs";
import {
  ensureBillingWebhookSchema, createBillingPurchaseOrder,
  verifyFlutterwaveWebhookSignature, receiveFlutterwaveWebhook,
  processNextFlutterwaveWebhook, createFlutterwaveCheckout
} from "../billing-webhooks.mjs";

function setup() {
  const db = openDatabase(":memory:");
  ensureBillingSchema(db);
  ensureBillingWebhookSchema(db);
  touchBillingAccount(db, { id: "user-pay-1", email: "pay@example.test" });
  const plan = saveBillingPlan(db, {
    code: "credits-ugx", name: "UGX Credit Pack", amountMinor: 50000,
    currency: "UGX", interval: "one_time", creditsPerPeriod: 1200,
    limits: { modelAllowlist: [] }
  });
  const order = createBillingPurchaseOrder(db, {
    userId: "user-pay-1", planId: plan.id, provider: "flutterwave"
  });
  return { db, plan, order };
}

function signedPayload(payload, secret = "test-webhook-secret-with-at-least-24-chars") {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = secret;
  return { rawBody, signature, secretHash: secret };
}

function payload(order, { event = "charge.completed", status = "successful", amount = 50000, currency = "UGX", id = 123456 } = {}) {
  return {
    event,
    data: { id, tx_ref: order.txRef, status, amount, currency }
  };
}

test("Flutterwave v3 webhook secret-hash header is compared safely", () => {
  const signed = signedPayload({ event: "charge.completed", data: { id: 1 } });
  assert.equal(verifyFlutterwaveWebhookSignature({
    rawBody: signed.rawBody, signature: signed.signature, secretHash: signed.secretHash
  }), true);
  assert.equal(verifyFlutterwaveWebhookSignature({
    rawBody: signed.rawBody, signature: "incorrect-secret-hash", secretHash: signed.secretHash
  }), false);
  assert.equal(verifyFlutterwaveWebhookSignature({
    rawBody: signed.rawBody, signature: signed.signature, secretHash: ""
  }), false);
});

test("webhook intake verifies signature, stores minimal data and deduplicates exact event retries", () => {
  const { db, order } = setup();
  const signed = signedPayload(payload(order));
  const first = receiveFlutterwaveWebhook(db, signed);
  const duplicate = receiveFlutterwaveWebhook(db, signed);
  const withProviderMetadata = signedPayload({
    ...payload(order),
    data: { ...payload(order).data, customer: { email: "private@example.test" }, created_at: "2026-11-07T00:00:00Z" }
  });
  const metadataDuplicate = receiveFlutterwaveWebhook(db, withProviderMetadata);
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(metadataDuplicate.duplicate, true);
  const stored = db.prepare("SELECT payload_json FROM billing_provider_events").get();
  const storedPayload = JSON.parse(stored.payload_json);
  assert.equal(storedPayload.data.tx_ref, order.txRef);
  assert.equal(storedPayload.data.customer, undefined);
  assert.throws(() => receiveFlutterwaveWebhook(db, {
    rawBody: signed.rawBody, signature: "wrong-secret", secretHash: signed.secretHash
  }), error => error.code === "BILLING_WEBHOOK_SIGNATURE_INVALID");
  db.close();
});

test("reused Flutterwave event identity with different signed content is quarantined", () => {
  const { db, order } = setup();
  const first = signedPayload(payload(order));
  receiveFlutterwaveWebhook(db, first);
  const changed = signedPayload(payload(order, { amount: 50001 }));
  assert.throws(() => receiveFlutterwaveWebhook(db, changed),
    error => error.code === "BILLING_WEBHOOK_REPLAY_CONFLICT");
  db.close();
});

test("credits are granted only after authoritative transaction verification and only once", async () => {
  const { db, order } = setup();
  const signed = signedPayload(payload(order));
  receiveFlutterwaveWebhook(db, signed);
  let verifyCalls = 0;
  const verifyTransaction = async ({ transactionId }) => {
    verifyCalls += 1;
    assert.equal(transactionId, "123456");
    return {
      id: 123456, tx_ref: order.txRef, status: "successful",
      currency: "UGX", amount: 50000
    };
  };
  const processed = await processNextFlutterwaveWebhook(db, { verifyTransaction });
  assert.equal(processed.paid, true);
  assert.equal(getBillingBalance(db, order.userId), 1200);
  const replay = await processNextFlutterwaveWebhook(db, { verifyTransaction });
  assert.equal(replay.processed, false);
  assert.equal(verifyCalls, 1);
  assert.equal(db.prepare("SELECT status FROM billing_payment_orders WHERE id=?").get(order.id).status, "paid");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_credit_ledger WHERE event_type='purchase'").get().n, 1);
  db.close();
});

test("transaction mismatch never grants credits and remains retryable for reconciliation", async () => {
  const { db, order } = setup();
  receiveFlutterwaveWebhook(db, signedPayload(payload(order)));
  const result = await processNextFlutterwaveWebhook(db, {
    verifyTransaction: async () => ({
      id: 123456, tx_ref: order.txRef, status: "successful",
      currency: "USD", amount: 50000
    })
  });
  assert.equal(result.processed, false);
  assert.equal(result.errorCode, "BILLING_PAYMENT_MISMATCH");
  assert.equal(getBillingBalance(db, order.userId), 0);
  const event = db.prepare("SELECT attempts,processed_at FROM billing_provider_events").get();
  assert.equal(event.attempts, 1);
  assert.equal(event.processed_at, null);
  db.close();
});

test("a failed checkout attempt does not block a later successful retry", async () => {
  const { db, order } = setup();
  receiveFlutterwaveWebhook(db, signedPayload(payload(order, { event: "charge.failed", status: "failed", id: 123455 })));
  const failedAttempt = await processNextFlutterwaveWebhook(db, {
    verifyTransaction: async () => { throw new Error("failed attempt must not be settled"); }
  });
  assert.equal(failedAttempt.processed, true);
  assert.equal(failedAttempt.retryableCheckout, true);
  assert.equal(db.prepare("SELECT status FROM billing_payment_orders WHERE id=?").get(order.id).status, "pending");
  receiveFlutterwaveWebhook(db, signedPayload(payload(order, { id: 123456 })));
  const successfulRetry = await processNextFlutterwaveWebhook(db, {
    verifyTransaction: async () => ({
      id: 123456, tx_ref: order.txRef, status: "successful", currency: "UGX", amount: 50000
    })
  });
  assert.equal(successfulRetry.paid, true);
  assert.equal(getBillingBalance(db, order.userId), 1200);
  db.close();
});

test("pending webhook states are not treated as failed payments", async () => {
  const { db, order } = setup();
  receiveFlutterwaveWebhook(db, signedPayload(payload(order, { status: "pending" })));
  const result = await processNextFlutterwaveWebhook(db, {
    verifyTransaction: async () => { throw new Error("verification should not run for pending webhook"); }
  });
  assert.equal(result.processed, false);
  assert.equal(result.errorCode, "BILLING_PAYMENT_PENDING");
  assert.equal(db.prepare("SELECT status FROM billing_payment_orders WHERE id=?").get(order.id).status, "pending");
  db.close();
});

test("only active one-time credit products can create Flutterwave payment orders", () => {
  const { db, plan } = setup();
  const recurring = saveBillingPlan(db, {
    code: "monthly", name: "Monthly", amountMinor: 10000, currency: "UGX",
    interval: "month", creditsPerPeriod: 500
  });
  assert.throws(() => createBillingPurchaseOrder(db, {
    userId: "user-pay-1", planId: recurring.id
  }), error => error.code === "BILLING_PRODUCT_INVALID");
  const order = createBillingPurchaseOrder(db, { userId: "user-pay-1", planId: plan.id });
  assert.match(order.txRef, /^ev_[a-f0-9]{32}$/);
  assert.equal(order.amountMinor, 50000);
  assert.equal(order.credits, 1200);
  db.close();
});


test("Flutterwave checkout uses the stored one-time price and Uganda mobile-money options", async () => {
  const { db, plan } = setup();
  let requestBody;
  const checkout = await createFlutterwaveCheckout(db, {
    user: { id: "user-pay-1", email: "pay@example.test" },
    planId: plan.id, secretKey: "flw-test-secret-key",
    publicAppUrl: "https://executive.example.com",
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://api.flutterwave.com/v3/payments");
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        status: "success",
        data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test-session" }
      }), { status: 200 });
    }
  });
  assert.equal(requestBody.amount, 50000);
  assert.equal(requestBody.currency, "UGX");
  assert.equal(requestBody.payment_options, "card, mobilemoneyuganda");
  assert.equal(requestBody.tx_ref, checkout.txRef);
  assert.equal(checkout.currency, "UGX");
  assert.equal(new URL(checkout.checkoutUrl).hostname, "checkout.flutterwave.com");
  assert.equal(db.prepare("SELECT status FROM billing_payment_orders WHERE id=?").get(checkout.orderId).status, "pending");
  db.close();
});

test("Flutterwave checkout rejects untrusted provider URLs and fails the order closed", async () => {
  const { db, plan } = setup();
  await assert.rejects(() => createFlutterwaveCheckout(db, {
    user: { id: "user-pay-1", email: "pay@example.test" },
    planId: plan.id, secretKey: "flw-test-secret-key",
    publicAppUrl: "https://executive.example.com",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "success", data: { link: "https://evil.example/steal" }
    }), { status: 200 })
  }), error => error.code === "BILLING_PROVIDER_RESPONSE_INVALID");
  assert.equal(db.prepare("SELECT status FROM billing_payment_orders ORDER BY created_at DESC LIMIT 1").get().status, "failed");
  db.close();
});

test("Flutterwave checkout requires HTTPS redirects and a configured secret", async () => {
  const { db, plan } = setup();
  await assert.rejects(() => createFlutterwaveCheckout(db, {
    user: { id: "user-pay-1", email: "pay@example.test" },
    planId: plan.id, secretKey: "flw-test-secret-key", publicAppUrl: "http://public.example.com",
    fetchImpl: async () => { throw new Error("must not call provider"); }
  }), error => error.code === "BILLING_REDIRECT_URL_INVALID");
  await assert.rejects(() => createFlutterwaveCheckout(db, {
    user: { id: "user-pay-1", email: "pay@example.test" },
    planId: plan.id, secretKey: "", publicAppUrl: "https://executive.example.com"
  }), error => error.code === "BILLING_PROVIDER_CONFIG_INVALID");
  db.close();
});


test("late successful events cannot settle failed or expired orders", async () => {
  const { db, order } = setup();
  db.prepare("UPDATE billing_payment_orders SET status='failed' WHERE id=?").run(order.id);
  receiveFlutterwaveWebhook(db, signedPayload(payload(order)));
  const result = await processNextFlutterwaveWebhook(db, {
    verifyTransaction: async () => ({
      id: 123456, tx_ref: order.txRef, status: "successful", currency: "UGX", amount: 50000
    })
  });
  assert.equal(result.processed, false);
  assert.equal(result.errorCode, "BILLING_ORDER_NOT_PENDING");
  assert.equal(getBillingBalance(db, order.userId), 0);
  db.close();
});
