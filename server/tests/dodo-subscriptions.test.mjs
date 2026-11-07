import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { openDatabase } from "../db.mjs";
import { ensureBillingSchema, touchBillingAccount, saveBillingPlan, getBillingBalance } from "../billing.mjs";
import { ensureBillingWebhookSchema } from "../billing-webhooks.mjs";
import {
  ensureDodoSubscriptionSchema, dodoProductEnvName, dodoSubscriptionCheckoutEnabled, dodoCustomerPortalEnabled,
  createDodoSubscriptionCheckout, verifyDodoWebhookSignature, receiveDodoWebhook,
  processNextDodoWebhook, getDodoCheckoutStatus, createDodoCustomerPortalSession
} from "../dodo-subscriptions.mjs";

const baseEnv = () => ({
  DODO_SUBSCRIPTIONS_ENABLED: "true",
  DODO_MERCHANT_APPROVED: "true",
  DODO_PAYMENTS_API_KEY: "test_api_key",
  DODO_PAYMENTS_WEBHOOK_KEY: "whsec_" + Buffer.from("test-dodo-webhook-signing-key-32bytes").toString("base64"),
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PRODUCT_ID_CREATOR: "pdt_test123456",
  PUBLIC_APP_URL: "https://executive.example.test",
  BILLING_ENFORCEMENT_ENABLED: "true",
  CREDITS_DAILY_FREE: "0"
});

function setup() {
  const db = openDatabase(":memory:");
  ensureBillingSchema(db);
  ensureBillingWebhookSchema(db);
  ensureDodoSubscriptionSchema(db);
  touchBillingAccount(db, { id: "dodo-user", email: "dodo@example.test" });
  const plan = saveBillingPlan(db, {
    code: "creator", name: "Creator", description: "Creator subscription",
    amountMinor: 1200, currency: "USD", interval: "month", creditsPerPeriod: 100,
    limits: { seats: 1 }, features: ["Creator tools"]
  });
  return { db, plan };
}

async function createCheckout(db, plan, env = baseEnv()) {
  return createDodoSubscriptionCheckout(db, {
    user: { id: "dodo-user", email: "dodo@example.test" },
    planId: plan.id,
    env,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://test.dodopayments.com/checkouts");
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.product_cart, [{ product_id: "pdt_test123456", quantity: 1 }]);
      assert.equal(body.customer.email, "dodo@example.test");
      assert.equal(body.metadata.executive_visuals_user_id, "dodo-user");
      assert.equal(body.metadata.executive_visuals_plan_id, plan.id);
      assert.match(body.return_url, /provider=dodo/);
      return new Response(JSON.stringify({
        session_id: "cks_test_session_123",
        checkout_url: "https://test.checkout.dodopayments.com/session/cks_test_session_123"
      }), { status: 200 });
    }
  });
}

function signedWebhook(payload, secret = Buffer.from("test-dodo-webhook-signing-key-32bytes"), id = randomUUID()) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v1," + createHmac("sha256", secret).update(id + "." + timestamp + "." + rawBody.toString("utf8")).digest("base64");
  return { rawBody, webhookId: id, timestamp, signature, webhookKey: "whsec_" + secret.toString("base64") };
}

function subscriptionPayload(orderId, plan, {
  type = "subscription.active",
  subscriptionId = "sub_dodo_123",
  status = "active",
  previous = "2026-11-07T00:00:00.000Z",
  next = "2026-12-07T00:00:00.000Z",
  paymentId = null,
  amount = 1200,
  timestamp = new Date().toISOString()
} = {}) {
  return {
    type,
    timestamp,
    data: {
      payload_type: "Subscription",
      subscription_id: subscriptionId,
      product_id: "pdt_test123456",
      status,
      currency: "USD",
      recurring_pre_tax_amount: amount,
      previous_billing_date: previous,
      next_billing_date: next,
      payment_id: paymentId,
      has_payment_method: true,
      customer: { customer_id: "cus_dodo_123", email: "dodo@example.test" },
      metadata: {
        executive_visuals_order_id: orderId,
        executive_visuals_user_id: "dodo-user",
        executive_visuals_plan_id: plan.id,
        executive_visuals_plan_code: "creator"
      }
    }
  };
}

test("Dodo subscription checkout is disabled without merchant approval and billing enforcement", () => {
  const env = baseEnv();
  assert.equal(dodoSubscriptionCheckoutEnabled(env), true);
  assert.equal(dodoSubscriptionCheckoutEnabled({ ...env, DODO_MERCHANT_APPROVED: "false" }), false);
  assert.equal(dodoSubscriptionCheckoutEnabled({ ...env, BILLING_ENFORCEMENT_ENABLED: "false" }), false);
  assert.equal(dodoProductEnvName("creator-plus"), "DODO_PRODUCT_ID_CREATOR_PLUS");
});

test("Dodo hosted checkout uses the server-mapped product and persists an owner-scoped order", async () => {
  const { db, plan } = setup();
  try {
    const checkout = await createCheckout(db, plan);
    assert.equal(checkout.planId, plan.id);
    assert.equal(checkout.sessionId, "cks_test_session_123");
    assert.equal(new URL(checkout.checkoutUrl).hostname, "test.checkout.dodopayments.com");
    assert.equal(getDodoCheckoutStatus(db, { orderId: checkout.orderId, userId: "dodo-user" }).status, "pending");
    assert.throws(() => getDodoCheckoutStatus(db, { orderId: checkout.orderId, userId: "other-user" }),
      error => error.code === "DODO_CHECKOUT_NOT_FOUND");
  } finally { db.close(); }
});

test("Dodo checkout rejects untrusted redirect hosts and marks the local order failed", async () => {
  const { db, plan } = setup();
  try {
    await assert.rejects(() => createDodoSubscriptionCheckout(db, {
      user: { id: "dodo-user", email: "dodo@example.test" }, planId: plan.id, env: baseEnv(),
      fetchImpl: async () => new Response(JSON.stringify({
        session_id: "cks_bad", checkout_url: "https://evil.example/session"
      }), { status: 200 })
    }), error => error.code === "DODO_RESPONSE_INVALID");
    assert.equal(db.prepare("SELECT status FROM billing_dodo_checkout_sessions").get().status, "failed");
  } finally { db.close(); }
});

test("Dodo webhook signatures use Standard Webhooks raw-body signing and enforce a replay window", () => {
  const secret = Buffer.from("test-dodo-webhook-signing-key-32bytes");
  const signed = signedWebhook({ type: "subscription.active", data: { subscription_id: "sub_123" } }, secret);
  assert.equal(verifyDodoWebhookSignature({ ...signed, nowMs: Date.now() }), true);
  assert.equal(verifyDodoWebhookSignature({ ...signed, signature: "v1,wrong", nowMs: Date.now() }), false);
  assert.equal(verifyDodoWebhookSignature({ ...signed, timestamp: "1000000000", nowMs: Date.now() }), false);
});

test("Dodo activation, renewal and cancellation update the subscription and grant credits idempotently", async () => {
  const { db, plan } = setup();
  try {
    const checkout = await createCheckout(db, plan);
    const env = baseEnv();
    const active = signedWebhook(subscriptionPayload(checkout.orderId, plan, {
      timestamp: "2026-11-07T10:00:00.000Z"
    }));
    assert.equal(receiveDodoWebhook(db, active).accepted, true);
    assert.equal(receiveDodoWebhook(db, active).duplicate, true);
    const activated = processNextDodoWebhook(db, { env });
    assert.equal(activated.activated, true);
    assert.equal(getBillingBalance(db, "dodo-user"), 100);
    const local = db.prepare("SELECT * FROM billing_subscriptions WHERE provider='dodo'").get();
    assert.equal(local.status, "active");
    assert.equal(local.provider_subscription_id, "sub_dodo_123");
    assert.equal(getDodoCheckoutStatus(db, { orderId: checkout.orderId, userId: "dodo-user" }).status, "active");

    const renewed = signedWebhook(subscriptionPayload(checkout.orderId, plan, {
      type: "subscription.renewed",
      previous: "2026-12-07T00:00:00.000Z",
      next: "2027-01-07T00:00:00.000Z",
      paymentId: "pay_dodo_renewal_1",
      timestamp: "2026-12-07T00:01:00.000Z"
    }));
    receiveDodoWebhook(db, renewed);
    const renewalResult = processNextDodoWebhook(db, { env });
    assert.equal(renewalResult.renewed, true);
    assert.equal(getBillingBalance(db, "dodo-user"), 200);
    assert.equal(db.prepare("SELECT current_period_end FROM billing_subscriptions WHERE id=?").get(local.id).current_period_end, "2027-01-07T00:00:00.000Z");

    const cancelled = signedWebhook(subscriptionPayload(checkout.orderId, plan, {
      type: "subscription.cancelled",
      status: "cancelled",
      timestamp: "2026-12-08T00:00:00.000Z"
    }));
    receiveDodoWebhook(db, cancelled);
    const cancelResult = processNextDodoWebhook(db, { env });
    assert.equal(cancelResult.status, "cancelled");
    assert.equal(db.prepare("SELECT status FROM billing_subscriptions WHERE id=?").get(local.id).status, "cancelled");
  } finally { db.close(); }
});

test("Dodo subscription price mismatch never activates or grants credits", async () => {
  const { db, plan } = setup();
  try {
    const checkout = await createCheckout(db, plan);
    const event = signedWebhook(subscriptionPayload(checkout.orderId, plan, { amount: 1000 }));
    receiveDodoWebhook(db, event);
    const result = processNextDodoWebhook(db, { env: baseEnv() });
    assert.equal(result.processed, false);
    assert.equal(result.errorCode, "DODO_SUBSCRIPTION_MISMATCH");
    assert.equal(getBillingBalance(db, "dodo-user"), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_subscriptions WHERE provider='dodo'").get().count, 0);
  } finally { db.close(); }
});


test("Dodo customer portal is owner-scoped and returns only a verified hosted URL",async()=>{
  const {db,plan}=setup();
  const env=baseEnv();
  db.prepare(`INSERT INTO billing_subscriptions
    (id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,metadata_json)
    VALUES(?,?,?,'cancelled','dodo',?,?,?,?,'{}')`)
    .run("dodo-subscription-portal","dodo-user",plan.id,"cus_dodo_123","sub_dodo_123",
      "2026-11-07T00:00:00.000Z","2026-12-07T00:00:00.000Z");
  try{
    const portal=await createDodoCustomerPortalSession(db,{
      user:{id:"dodo-user",email:"dodo@example.test"},env,
      fetchImpl:async(url,options)=>{
        const parsed=new URL(String(url));
        assert.equal(parsed.origin,"https://test.dodopayments.com");
        assert.equal(parsed.pathname,"/customers/cus_dodo_123/customer-portal/session");
        assert.equal(parsed.searchParams.get("return_url"),"https://executive.example.test/");
        assert.equal(options.method,"POST");
        assert.equal(options.headers.authorization,"Bearer test_api_key");
        return new Response(JSON.stringify({link:"https://customer.dodopayments.com/portal/session-123"}),{status:200});
      }
    });
    assert.equal(portal.url,"https://customer.dodopayments.com/portal/session-123");
    await assert.rejects(()=>createDodoCustomerPortalSession(db,{
      user:{id:"another-user",email:"other@example.test"},env,
      fetchImpl:async()=>{throw new Error("must not call Dodo for a different account");}
    }),error=>error.code==="DODO_CUSTOMER_NOT_FOUND");
    await assert.rejects(()=>createDodoCustomerPortalSession(db,{
      user:{id:"dodo-user"},env,
      fetchImpl:async()=>new Response(JSON.stringify({link:"https://evil.example/portal"}),{status:200})
    }),error=>error.code==="DODO_RESPONSE_INVALID");
  }finally{db.close();}
});


test("Dodo customer portal readiness remains independent from new subscription checkout",()=>{
  const env=baseEnv();
  assert.equal(dodoSubscriptionCheckoutEnabled(env),true);
  assert.equal(dodoCustomerPortalEnabled(env),true);
  assert.equal(dodoSubscriptionCheckoutEnabled({...env,BILLING_ENFORCEMENT_ENABLED:"false"}),false);
  assert.equal(dodoCustomerPortalEnabled({...env,BILLING_ENFORCEMENT_ENABLED:"false"}),true);
  assert.equal(dodoCustomerPortalEnabled({...env,DODO_MERCHANT_APPROVED:"false"}),true);
});


test("Dodo webhook worker respects active processing leases and releases completed leases",()=>{
  const {db}=setup();
  const timestamp=new Date().toISOString();
  const payload={type:"subscription.update_payment_method",timestamp,data:{subscription_id:"sub_lease_test",status:"active",metadata:{}}};
  db.prepare(`INSERT INTO billing_provider_events
    (id,provider,event_id,event_type,payload_hash,payload_json,created_at)
    VALUES('dodo-lease-event','dodo','lease-event-1','subscription.update_payment_method','hash',?,?)`)
    .run(JSON.stringify(payload),timestamp);
  db.prepare("UPDATE billing_provider_events SET lease_owner='other-worker',lease_expires_at=? WHERE id='dodo-lease-event'")
    .run(new Date(Date.now()+60000).toISOString());
  assert.deepEqual(processNextDodoWebhook(db),{processed:false});
  db.prepare("UPDATE billing_provider_events SET lease_expires_at=? WHERE id='dodo-lease-event'")
    .run(new Date(Date.now()-1000).toISOString());
  const processed=processNextDodoWebhook(db);
  assert.equal(processed.processed,true);
  const row=db.prepare("SELECT processed_at,lease_owner,lease_expires_at FROM billing_provider_events WHERE id='dodo-lease-event'").get();
  assert.ok(row.processed_at);
  assert.equal(row.lease_owner,null);
  assert.equal(row.lease_expires_at,null);
  db.close();
});


test("Dodo partial refunds reverse purchased subscription credits proportionally and idempotently",async()=>{
  const {db,plan}=setup();
  const env=baseEnv();
  try{
    const checkout=await createCheckout(db,plan);
    const active=signedWebhook(subscriptionPayload(checkout.orderId,plan,{
      paymentId:"pay_dodo_refund_001",timestamp:"2026-11-07T10:00:00.000Z"
    }));
    receiveDodoWebhook(db,active);
    assert.equal(processNextDodoWebhook(db,{env}).activated,true);
    assert.equal(getBillingBalance(db,"dodo-user"),100);

    const refundOne=signedWebhook({
      type:"refund.succeeded",timestamp:"2026-11-08T10:00:00.000Z",
      data:{payload_type:"Refund",refund_id:"ref_dodo_refund_001",payment_id:"pay_dodo_refund_001",
        amount:600,currency:"USD",status:"succeeded",customer:{customer_id:"cus_dodo_123"}}
    });
    assert.equal(receiveDodoWebhook(db,refundOne).accepted,true);
    const first=processNextDodoWebhook(db,{env});
    assert.equal(first.processed,true,JSON.stringify(first));
    assert.equal(first.refunded,true);
    assert.equal(first.creditsReversed,50);
    assert.equal(first.reconciliationRequired,false);
    assert.equal(getBillingBalance(db,"dodo-user"),50);

    const duplicate=signedWebhook({
      type:"refund.succeeded",timestamp:"2026-11-08T10:01:00.000Z",
      data:{payload_type:"Refund",refund_id:"ref_dodo_refund_001",payment_id:"pay_dodo_refund_001",
        amount:600,currency:"USD",status:"succeeded",customer:{customer_id:"cus_dodo_123"}}
    });
    receiveDodoWebhook(db,duplicate);
    assert.equal(processNextDodoWebhook(db,{env}).duplicate,true);
    assert.equal(getBillingBalance(db,"dodo-user"),50);

    const refundTwo=signedWebhook({
      type:"refund.succeeded",timestamp:"2026-11-08T10:02:00.000Z",
      data:{payload_type:"Refund",refund_id:"ref_dodo_refund_002",payment_id:"pay_dodo_refund_001",
        amount:600,currency:"USD",status:"succeeded",customer:{customer_id:"cus_dodo_123"}}
    });
    receiveDodoWebhook(db,refundTwo);
    const second=processNextDodoWebhook(db,{env});
    assert.equal(second.creditsReversed,50);
    assert.equal(getBillingBalance(db,"dodo-user"),0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_refund_events WHERE payment_id=?").get("pay_dodo_refund_001").n,2);
  }finally{db.close();}
});

test("Dodo refunds without a matched credit grant are recorded for administrator reconciliation",async()=>{
  const {db,plan}=setup();
  const env=baseEnv();
  try{
    const checkout=await createCheckout(db,plan);
    const active=signedWebhook(subscriptionPayload(checkout.orderId,plan,{
      timestamp:"2026-11-07T10:00:00.000Z"
    }));
    receiveDodoWebhook(db,active);
    processNextDodoWebhook(db,{env});
    const refund=signedWebhook({
      type:"refund.succeeded",timestamp:"2026-11-08T10:00:00.000Z",
      data:{payload_type:"Refund",refund_id:"ref_dodo_unmatched_001",payment_id:"pay_dodo_unknown_001",
        amount:1200,currency:"USD",status:"succeeded",customer:{customer_id:"cus_dodo_123"}}
    });
    receiveDodoWebhook(db,refund);
    const result=processNextDodoWebhook(db,{env});
    assert.equal(result.refunded,true);
    assert.equal(result.reconciliationRequired,true);
    const record=db.prepare("SELECT user_id,reconciliation_required,reconciliation_note FROM billing_refund_events WHERE refund_id=?").get("ref_dodo_unmatched_001");
    assert.equal(record.user_id,"dodo-user");
    assert.equal(record.reconciliation_required,1);
    assert.match(record.reconciliation_note,/manual/i);
  }finally{db.close();}
});
