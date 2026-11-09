import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import {
  ensureBillingSchema, touchBillingAccount, saveBillingPlan, getBillingBalance
} from "../billing.mjs";
import {
  ensureBillingWebhookSchema, createBillingPurchaseOrder,
  verifyFlutterwaveWebhookSignature, receiveFlutterwaveWebhook,
  processNextFlutterwaveWebhook, createFlutterwaveCheckout,
  createFlutterwaveSubscriptionCheckout
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

test("Flutterwave recurring checkout uses a configured payment plan and card-only billing",async()=>{
  const {db}=setup();
  const plan=saveBillingPlan(db,{code:"creator-monthly",name:"Creator Monthly",amountMinor:25000,
    currency:"UGX",interval:"month",creditsPerPeriod:800});
  let request;
  const checkout=await createFlutterwaveSubscriptionCheckout(db,{
    user:{id:"user-pay-1",email:"pay@example.test"},planId:plan.id,
    secretKey:"flw-test-secret-key",publicAppUrl:"https://executive.example.com",
    env:{FLW_SUBSCRIPTIONS_ENABLED:"true",FLW_MERCHANT_APPROVED:"true",FLW_WEBHOOK_SECRET:"test-webhook-secret-with-at-least-24-chars",
      BILLING_ENFORCEMENT_ENABLED:"true",FLW_PAYMENT_PLAN_ID_CREATOR_MONTHLY:"87654"},
    fetchImpl:async(url,options)=>{
      request={url:String(url),body:JSON.parse(options.body)};
      return new Response(JSON.stringify({status:"success",data:{link:"https://checkout.flutterwave.com/v3/hosted/pay/recurring"}}),{status:200});
    }
  });
  assert.equal(request.url,"https://api.flutterwave.com/v3/payments");
  assert.equal(request.body.payment_plan,87654);
  assert.equal(request.body.payment_options,"card");
  assert.equal(request.body.currency,"UGX");
  assert.equal(request.body.amount,25000);
  assert.equal(checkout.paymentMethod,"card");
  assert.equal(db.prepare("SELECT status FROM billing_flutterwave_subscription_checkouts WHERE id=?").get(checkout.orderId).status,"pending");
  db.close();
});

test("verified Flutterwave recurring first payment activates one subscription and grants one period",async()=>{
  const {db}=setup();
  const plan=saveBillingPlan(db,{code:"creator-monthly",name:"Creator Monthly",amountMinor:25000,
    currency:"UGX",interval:"month",creditsPerPeriod:800});
  const checkout=await createFlutterwaveSubscriptionCheckout(db,{
    user:{id:"user-pay-1",email:"pay@example.test"},planId:plan.id,secretKey:"flw-test-secret-key",
    publicAppUrl:"https://executive.example.com",
    env:{FLW_SUBSCRIPTIONS_ENABLED:"true",FLW_MERCHANT_APPROVED:"true",FLW_WEBHOOK_SECRET:"test-webhook-secret-with-at-least-24-chars",
      BILLING_ENFORCEMENT_ENABLED:"true",FLW_PAYMENT_PLAN_ID_CREATOR_MONTHLY:"87654"},
    fetchImpl:async()=>new Response(JSON.stringify({status:"success",data:{link:"https://checkout.flutterwave.com/pay/session"}}),{status:200})
  });
  const signed=signedPayload({event:"charge.completed",data:{id:7654321,tx_ref:checkout.txRef,status:"successful",
    amount:25000,currency:"UGX",customer:{id:9988,email:"pay@example.test"}}});
  receiveFlutterwaveWebhook(db,signed);
  const processed=await processNextFlutterwaveWebhook(db,{verifyTransaction:async()=>({
    id:7654321,tx_ref:checkout.txRef,status:"successful",currency:"UGX",amount:25000,
    customer:{id:9988},subscription_id:"flw-subscription-9988"
  })});
  assert.equal(processed.paid,true);
  assert.equal(processed.subscription,true);
  assert.equal(getBillingBalance(db,"user-pay-1"),800);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_subscriptions WHERE provider='flutterwave'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_credit_ledger WHERE event_type='subscription_grant'").get().n,1);
  const replay=await processNextFlutterwaveWebhook(db,{verifyTransaction:async()=>{throw new Error("must not reverify processed charge");}});
  assert.equal(replay.processed,false);
  db.close();
});

test("verified Flutterwave recurring renewal extends one billing period and grants credits once",async()=>{
  const {db}=setup();
  const plan=saveBillingPlan(db,{code:"creator-monthly",name:"Creator Monthly",amountMinor:25000,
    currency:"UGX",interval:"month",creditsPerPeriod:800});
  db.prepare(`INSERT INTO billing_subscriptions
    (id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,metadata_json)
    VALUES('flw-renewal-sub','user-pay-1',?,'active','flutterwave','9988','flw-subscription-9988',
      '2026-11-10T00:00:00.000Z','2026-12-10T00:00:00.000Z',?)`)
    .run(plan.id,JSON.stringify({paymentPlanId:"87654"}));
  const payment={event:"charge.completed",data:{id:8765432,tx_ref:"flwrenewal_001",status:"successful",
    amount:25000,currency:"UGX",payment_plan:87654,customer:{email:"pay@example.test",id:9988}}};
  receiveFlutterwaveWebhook(db,signedPayload(payment));
  const verifyTransaction=async()=>({id:8765432,tx_ref:"flwrenewal_001",status:"successful",
    amount:25000,currency:"UGX",payment_plan:87654,customer:{id:9988,email:"pay@example.test"}});
  const processed=await processNextFlutterwaveWebhook(db,{verifyTransaction});
  assert.equal(processed.renewed,true);
  assert.equal(getBillingBalance(db,"user-pay-1"),800);
  const sub=db.prepare("SELECT current_period_start,current_period_end,status FROM billing_subscriptions WHERE id='flw-renewal-sub'").get();
  assert.equal(sub.current_period_start,"2026-12-10T00:00:00.000Z");
  assert.equal(sub.current_period_end,"2027-01-10T00:00:00.000Z");
  assert.equal(sub.status,"active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_credit_ledger WHERE idempotency_key LIKE 'flutterwave-subscription-renewal:%'").get().n,1);
  const outbox=db.prepare("SELECT provider,provider_event_id FROM cloud_subscription_sync_outbox").get();
  assert.equal(outbox.provider,"flutterwave");
  assert.equal(outbox.provider_event_id,"charge.completed:8765432:successful");
  db.close();
});

test("Flutterwave subscription cancellation updates local and cloud lifecycle without granting credits",async()=>{
  const {db}=setup();
  const plan=saveBillingPlan(db,{code:"creator-monthly",name:"Creator Monthly",amountMinor:25000,
    currency:"UGX",interval:"month",creditsPerPeriod:800});
  const start=new Date().toISOString(),end=new Date(Date.now()+30*86400000).toISOString();
  db.prepare(`INSERT INTO billing_subscriptions
    (id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,metadata_json)
    VALUES('flw-local-sub','user-pay-1',?,'active','flutterwave','9988','flw-subscription-9988',?,?,?)`)
    .run(plan.id,start,end,JSON.stringify({paymentPlanId:"87654"}));
  const signed=signedPayload({event:"subscription.cancelled",data:{status:"deactivated",customer:{email:"pay@example.test"},plan:{id:87654}}});
  receiveFlutterwaveWebhook(db,signed);
  const processed=await processNextFlutterwaveWebhook(db,{verifyTransaction:async()=>{throw new Error("cancellation must not verify a charge");}});
  assert.equal(processed.cancelled,true);
  assert.equal(db.prepare("SELECT status FROM billing_subscriptions WHERE id='flw-local-sub'").get().status,"cancelled");
  const sync=db.prepare("SELECT action,metadata_json FROM cloud_subscription_sync_outbox WHERE provider_event_id=?").get(processed.eventId);
  assert.equal(sync.action,"status");
  assert.equal(JSON.parse(sync.metadata_json).targetStatus,"cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_credit_ledger WHERE event_type='subscription_grant'").get().n,0);
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


test("Flutterwave webhook worker respects active leases and releases completed leases",async()=>{
  const {db,order}=setup();
  const timestamp=new Date().toISOString();
  const payload={event:"charge.failed",data:{id:123456,tx_ref:order.txRef,status:"failed",amount:50000,currency:"UGX"}};
  db.prepare(`INSERT INTO billing_provider_events
    (id,provider,event_id,event_type,payload_hash,payload_json,created_at)
    VALUES('flw-lease-event','flutterwave','charge.failed:123456:failed','charge.failed','hash',?,?)`)
    .run(JSON.stringify(payload),timestamp);
  db.prepare("UPDATE billing_provider_events SET lease_owner='other-worker',lease_expires_at=? WHERE id='flw-lease-event'")
    .run(new Date(Date.now()+60000).toISOString());
  assert.deepEqual(await processNextFlutterwaveWebhook(db,{verifyTransaction:async()=>{throw new Error("must not verify a failed charge");}}),{processed:false});
  db.prepare("UPDATE billing_provider_events SET lease_expires_at=? WHERE id='flw-lease-event'")
    .run(new Date(Date.now()-1000).toISOString());
  const processed=await processNextFlutterwaveWebhook(db,{verifyTransaction:async()=>{throw new Error("must not verify a failed charge");}});
  assert.equal(processed.processed,true);
  const row=db.prepare("SELECT processed_at,lease_owner,lease_expires_at FROM billing_provider_events WHERE id='flw-lease-event'").get();
  assert.ok(row.processed_at);
  assert.equal(row.lease_owner,null);
  assert.equal(row.lease_expires_at,null);
  db.close();
});
