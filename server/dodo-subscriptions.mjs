import { billingEnforcementEnabled } from "./billing.mjs";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const now = () => new Date().toISOString();
const safeJson = value => JSON.stringify(value ?? {});
const parseJson = value => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

const SUBSCRIPTION_EVENTS = new Set([
  "subscription.active", "subscription.updated", "subscription.past_due",
  "subscription.on_hold", "subscription.paused", "subscription.unpaused",
  "subscription.renewed", "subscription.plan_changed", "subscription.cancelled",
  "subscription.failed", "subscription.expired", "subscription.update_payment_method"
]);

export function dodoProductEnvName(planCode) {
  const suffix = String(planCode || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return suffix ? "DODO_PRODUCT_ID_" + suffix : "";
}

export function dodoSubscriptionCheckoutEnabled(env = process.env) {
  return env.DODO_SUBSCRIPTIONS_ENABLED === "true" &&
    env.DODO_MERCHANT_APPROVED === "true" &&
    billingEnforcementEnabled(env) &&
    !!(env.DODO_PAYMENTS_API_KEY && env.DODO_PAYMENTS_WEBHOOK_KEY && env.PUBLIC_APP_URL) &&
    ["test_mode", "live_mode"].includes(env.DODO_PAYMENTS_ENVIRONMENT || "test_mode");
}

export function dodoCustomerPortalEnabled(env = process.env) {
  return env.DODO_MERCHANT_APPROVED === "true" &&
    !!(env.DODO_PAYMENTS_API_KEY && env.PUBLIC_APP_URL) &&
    ["test_mode", "live_mode"].includes(env.DODO_PAYMENTS_ENVIRONMENT || "test_mode");
}

export function ensureDodoSubscriptionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_dodo_checkout_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      provider_product_id TEXT NOT NULL,
      provider_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','pending','active','failed','expired')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_dodo_checkout_owner_idx
      ON billing_dodo_checkout_sessions(user_id,created_at DESC);
  `);
}

function productIdForPlan(planCode, env = process.env) {
  const key = dodoProductEnvName(planCode);
  return key ? String(env[key] || "").trim() : "";
}

function secureReturnUrl(publicAppUrl, orderId) {
  let base;
  try { base = new URL(publicAppUrl); } catch { throw fail("A valid public application URL is required.", "DODO_RETURN_URL_INVALID", 503); }
  const local = ["localhost", "127.0.0.1"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) {
    throw fail("Dodo return URLs must use HTTPS.", "DODO_RETURN_URL_INVALID", 503);
  }
  if (base.username || base.password || base.search || base.hash) throw fail("Public application URL must not contain credentials, query parameters or fragments.", "DODO_RETURN_URL_INVALID", 503);
  const result = new URL("/billing/return", base);
  result.searchParams.set("provider", "dodo");
  result.searchParams.set("order_id", orderId);
  return result.toString();
}

export async function createDodoSubscriptionCheckout(db, {
  user, planId, env = process.env, fetchImpl = fetch
} = {}) {
  if (!dodoSubscriptionCheckoutEnabled(env)) throw fail("Dodo subscription checkout is disabled pending merchant approval and complete test/live configuration.", "DODO_SUBSCRIPTIONS_DISABLED", 503);
  if (!user?.id || !user?.email) throw fail("Authenticated customer identity is required.", "BILLING_USER_REQUIRED", 401);
  const account = db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(user.id);
  const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(planId);
  if (!account || account.status !== "active" || !plan) throw fail("Active account and plan are required.", "BILLING_TARGET_NOT_FOUND", 404);
  if (!["month", "year"].includes(plan.interval) || !Number.isSafeInteger(Number(plan.amount_minor)) ||
      Number(plan.amount_minor) <= 0 || !Number.isSafeInteger(Number(plan.credits_per_period)) ||
      Number(plan.credits_per_period) <= 0 || !/^[A-Z]{3}$/.test(String(plan.currency || ""))) {
    throw fail("Dodo checkout requires an active, priced recurring plan with positive credits.", "BILLING_PRODUCT_INVALID");
  }
  const productId = productIdForPlan(plan.code, env);
  if (!/^pdt_[A-Za-z0-9_-]{6,120}$/.test(productId)) throw fail("The Dodo product ID for this plan is not configured.", "DODO_PRODUCT_NOT_CONFIGURED", 503);
  const localOrderId = randomUUID();
  const timestamp = now();
  db.prepare(`INSERT INTO billing_dodo_checkout_sessions
    (id,user_id,plan_id,provider_product_id,status,created_at,updated_at)
    VALUES(?,?,?,?,'creating',?,?)`)
    .run(localOrderId, user.id, plan.id, productId, timestamp, timestamp);

  const environment = env.DODO_PAYMENTS_ENVIRONMENT || "test_mode";
  const apiBase = environment === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
  const returnUrl = secureReturnUrl(env.PUBLIC_APP_URL, localOrderId);
  let response;
  try {
    response = await fetchImpl(apiBase + "/checkouts", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.DODO_PAYMENTS_API_KEY,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { email: String(user.email).trim().toLowerCase() },
        return_url: returnUrl,
        metadata: {
          executive_visuals_order_id: localOrderId,
          executive_visuals_user_id: String(user.id),
          executive_visuals_plan_id: String(plan.id),
          executive_visuals_plan_code: String(plan.code)
        }
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    db.prepare("UPDATE billing_dodo_checkout_sessions SET status='failed',updated_at=? WHERE id=?").run(now(), localOrderId);
    throw fail("Dodo checkout could not be created.", "DODO_CHECKOUT_CREATE_FAILED", 502);
  }
  if (!response.ok) {
    db.prepare("UPDATE billing_dodo_checkout_sessions SET status='failed',updated_at=? WHERE id=?").run(now(), localOrderId);
    throw fail("Dodo rejected the checkout session request.", "DODO_CHECKOUT_CREATE_FAILED", 502);
  }
  let body;
  try { body = await response.json(); } catch {
    db.prepare("UPDATE billing_dodo_checkout_sessions SET status='failed',updated_at=? WHERE id=?").run(now(), localOrderId);
    throw fail("Dodo returned an invalid checkout response.", "DODO_RESPONSE_INVALID", 502);
  }
  let checkoutUrl;
  try { checkoutUrl = new URL(body?.checkout_url); } catch {
    db.prepare("UPDATE billing_dodo_checkout_sessions SET status='failed',updated_at=? WHERE id=?").run(now(), localOrderId);
    throw fail("Dodo did not return a valid checkout URL.", "DODO_RESPONSE_INVALID", 502);
  }
  const allowedHost = environment === "live_mode" ? "checkout.dodopayments.com" : "test.checkout.dodopayments.com";
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== allowedHost ||
      typeof body?.session_id !== "string" || !body.session_id) {
    db.prepare("UPDATE billing_dodo_checkout_sessions SET status='failed',updated_at=? WHERE id=?").run(now(), localOrderId);
    throw fail("Dodo returned an untrusted checkout destination.", "DODO_RESPONSE_INVALID", 502);
  }
  db.prepare("UPDATE billing_dodo_checkout_sessions SET provider_session_id=?,status='pending',updated_at=? WHERE id=?")
    .run(body.session_id, now(), localOrderId);
  return { orderId: localOrderId, sessionId: body.session_id, checkoutUrl: checkoutUrl.toString(), planId: plan.id };
}

/**
 * Create a short-lived Dodo customer-portal link for the authenticated owner.
 * Dodo's hosted portal handles invoices, payment methods and cancellation;
 * the signed-in user's local subscription record is the source of ownership.
 */
export async function createDodoCustomerPortalSession(db, {
  user, env = process.env, fetchImpl = fetch
} = {}) {
  if (!dodoCustomerPortalEnabled(env)) {
    throw fail("Dodo customer portal is unavailable until merchant approval and portal credentials are configured.", "DODO_PORTAL_DISABLED", 503);
  }
  if (!user?.id) throw fail("Authenticated customer identity is required.", "BILLING_USER_REQUIRED", 401);
  const subscription = db.prepare(`SELECT provider_customer_id FROM billing_subscriptions
    WHERE user_id=? AND provider='dodo' AND provider_customer_id IS NOT NULL
      AND status IN ('active','trialing','past_due','on_hold')
    ORDER BY current_period_end DESC LIMIT 1`).get(String(user.id));
  const customerId = String(subscription?.provider_customer_id || "").trim();
  if (!/^cus_[A-Za-z0-9_-]{6,120}$/.test(customerId)) {
    throw fail("No active Dodo customer is linked to this account.", "DODO_CUSTOMER_NOT_FOUND", 404);
  }
  let base;
  try { base = new URL(env.PUBLIC_APP_URL); } catch {
    throw fail("A valid public application URL is required.", "DODO_RETURN_URL_INVALID", 503);
  }
  const local = ["localhost", "127.0.0.1"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && env.NODE_ENV !== "production")) {
    throw fail("Dodo portal return URLs must use HTTPS.", "DODO_RETURN_URL_INVALID", 503);
  }
  if (base.username || base.password || base.search || base.hash) {
    throw fail("Public application URL must not contain credentials, query parameters or fragments.", "DODO_RETURN_URL_INVALID", 503);
  }
  const host = env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
  const endpoint = new URL("/customers/" + encodeURIComponent(customerId) + "/customer-portal/session", host);
  endpoint.searchParams.set("return_url", new URL("/", base).toString());
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + String(env.DODO_PAYMENTS_API_KEY), accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw fail("Dodo customer portal could not be reached.", "DODO_PORTAL_CREATE_FAILED", 502);
  }
  if (!response.ok) throw fail("Dodo rejected the customer portal request.", "DODO_PORTAL_CREATE_FAILED", 502);
  let body;
  try { body = await response.json(); } catch {
    throw fail("Dodo returned an invalid customer portal response.", "DODO_RESPONSE_INVALID", 502);
  }
  let link;
  try { link = new URL(body?.link); } catch {
    throw fail("Dodo did not return a valid customer portal link.", "DODO_RESPONSE_INVALID", 502);
  }
  if (link.protocol !== "https:" || !(link.hostname === "dodopayments.com" || link.hostname.endsWith(".dodopayments.com"))) {
    throw fail("Dodo returned an untrusted customer portal destination.", "DODO_RESPONSE_INVALID", 502);
  }
  return { url: link.toString() };
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyDodoWebhookSignature({ rawBody, webhookId, signature, timestamp, webhookKey, nowMs = Date.now() } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 1024 * 1024 ||
      typeof webhookId !== "string" || webhookId.length < 8 || webhookId.length > 200 ||
      typeof timestamp !== "string" || !/^\d{10,13}$/.test(timestamp) ||
      typeof signature !== "string" || signature.length > 2048 ||
      typeof webhookKey !== "string" || !webhookKey.startsWith("whsec_")) return false;
  const seconds = Number(timestamp.length === 13 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp));
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > 300) return false;
  let secret;
  try { secret = Buffer.from(webhookKey.slice(6), "base64"); } catch { return false; }
  if (!secret.length) return false;
  const signedContent = webhookId + "." + timestamp + "." + rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(signedContent).digest("base64");
  return signature.split(/\s+/).some(part => {
    const match = part.match(/^v1,([A-Za-z0-9+/=]+)$/);
    return !!match && safeEqual(match[1], expected);
  });
}

export function receiveDodoWebhook(db, {
  rawBody, webhookId, signature, timestamp, webhookKey, nowMs = Date.now()
} = {}) {
  if (!verifyDodoWebhookSignature({ rawBody, webhookId, signature, timestamp, webhookKey, nowMs })) {
    throw fail("Dodo webhook signature is invalid or outside the replay window.", "DODO_WEBHOOK_SIGNATURE_INVALID", 401);
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); } catch {
    throw fail("Dodo webhook body is not valid JSON.", "DODO_WEBHOOK_INVALID");
  }
  const type = String(payload?.type || "");
  const eventTimestamp = String(payload?.timestamp || "");
  const data = payload?.data;
  if (!Number.isFinite(Date.parse(eventTimestamp))) throw fail("Dodo webhook event timestamp is invalid.", "DODO_WEBHOOK_INVALID");
  if (!SUBSCRIPTION_EVENTS.has(type) || !data || typeof data !== "object") {
    throw fail("Dodo webhook event is unsupported or malformed.", "DODO_WEBHOOK_INVALID");
  }
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const minimal = {
    type,
    timestamp: String(payload.timestamp || ""),
    data: {
      subscription_id: String(data.subscription_id || ""),
      product_id: String(data.product_id || ""),
      status: String(data.status || ""),
      currency: String(data.currency || "").toUpperCase(),
      recurring_pre_tax_amount: Number(data.recurring_pre_tax_amount || 0),
      previous_billing_date: data.previous_billing_date || null,
      next_billing_date: data.next_billing_date || null,
      payment_id: data.payment_id || null,
      has_payment_method: data.has_payment_method === true,
      cancel_at_next_billing_date: data.cancel_at_next_billing_date === true,
      past_due_ends_at: data.past_due_ends_at || null,
      customer_id: String(data.customer?.customer_id || ""),
      metadata: {
        executive_visuals_order_id: String(metadata.executive_visuals_order_id || ""),
        executive_visuals_user_id: String(metadata.executive_visuals_user_id || ""),
        executive_visuals_plan_id: String(metadata.executive_visuals_plan_id || ""),
        executive_visuals_plan_code: String(metadata.executive_visuals_plan_code || "")
      }
    }
  };
  if (!minimal.data.subscription_id && !minimal.data.metadata.executive_visuals_order_id) {
    throw fail("Dodo event lacks a subscription or local checkout reference.", "DODO_WEBHOOK_INVALID");
  }
  const hash = createHash("sha256").update(safeJson(minimal)).digest("hex");
  const existing = db.prepare("SELECT payload_hash FROM billing_provider_events WHERE provider='dodo' AND event_id=?").get(webhookId);
  if (existing) {
    if (existing.payload_hash !== hash) throw fail("Dodo reused a webhook ID with different settlement data.", "DODO_WEBHOOK_REPLAY_CONFLICT", 409);
    return { accepted: true, duplicate: true, eventId: webhookId };
  }
  db.prepare(`INSERT INTO billing_provider_events
    (id,provider,event_id,event_type,payload_hash,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?)`)
    .run(randomUUID(), "dodo", webhookId, type, hash, safeJson(minimal), now());
  return { accepted: true, duplicate: false, eventId: webhookId };
}

function statusForDodoEvent(type, status) {
  if (type === "subscription.cancelled") return "cancelled";
  if (type === "subscription.expired") return "expired";
  if (type === "subscription.failed") return "past_due";
  if (type === "subscription.past_due") return "past_due";
  if (type === "subscription.on_hold" || type === "subscription.paused") return "paused";
  if (type === "subscription.unpaused" || type === "subscription.active" || type === "subscription.renewed") return "active";
  if (["active","past_due","paused","cancelled","expired","failed","on_hold"].includes(String(status))) {
    return status === "failed" || status === "on_hold" ? "past_due" : status;
  }
  return null;
}

function findPlanForDodoProduct(db, productId, env = process.env) {
  const plans = db.prepare("SELECT * FROM billing_plans WHERE active=1 AND interval IN ('month','year')").all();
  return plans.find(plan => productIdForPlan(plan.code, env) === productId) || null;
}

function insertSubscriptionCredits(db, { userId, plan, subscriptionId, paymentId, periodEnd, idempotencyKey, description }) {
  const amount = Number(plan.credits_per_period || 0);
  if (amount <= 0) return;
  db.prepare(`INSERT OR IGNORE INTO billing_credit_ledger
    (id,user_id,amount,event_type,description,reference_id,idempotency_key,expires_at,metadata_json)
    VALUES(?,?,?,'subscription_grant',?,?,?,?,?)`)
    .run(randomUUID(), userId, amount, description, subscriptionId, idempotencyKey,
      periodEnd || null, safeJson({ provider: "dodo", subscriptionId, paymentId: paymentId || null, planId: plan.id }));
}

export function processNextDodoWebhook(db, { env = process.env } = {}) {
  const leaseOwner=randomUUID();
  let event=null;
  db.exec("BEGIN IMMEDIATE");
  try{
    const current=now();
    const pendingEvents = db.prepare(`SELECT * FROM billing_provider_events
      WHERE provider='dodo' AND processed_at IS NULL AND attempts<1000
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      ORDER BY created_at ASC LIMIT 100`).all(current);
    event = pendingEvents.sort((a,b) => {
      const left = Date.parse(parseJson(a.payload_json).timestamp || "") || 0;
      const right = Date.parse(parseJson(b.payload_json).timestamp || "") || 0;
      return left - right || String(a.created_at).localeCompare(String(b.created_at));
    })[0] || null;
    if(!event){db.exec("COMMIT");return {processed:false};}
    const leaseExpiresAt=new Date(Date.now()+120000).toISOString();
    const claimed=db.prepare(`UPDATE billing_provider_events SET lease_owner=?,lease_expires_at=?
      WHERE id=? AND processed_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .run(leaseOwner,leaseExpiresAt,event.id,current);
    if(claimed.changes!==1){db.exec("COMMIT");return {processed:false};}
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  const markProcessed=()=>{
    const result=db.prepare(`UPDATE billing_provider_events SET processed_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_owner=? AND processed_at IS NULL`).run(now(),event.id,leaseOwner);
    if(result.changes!==1)throw fail("Dodo webhook processing lease was lost.", "DODO_WEBHOOK_LEASE_LOST", 409);
  };
  const payload = parseJson(event.payload_json);
  const type = payload.type;
  const data = payload.data || {};
  const metadata = data.metadata || {};
  try {
    const checkoutId = metadata.executive_visuals_order_id;
    const subscriptionId = data.subscription_id;
    let local = subscriptionId ? db.prepare("SELECT * FROM billing_subscriptions WHERE provider='dodo' AND provider_subscription_id=?").get(subscriptionId) : null;
    if ((type === "subscription.failed" || type === "subscription.cancelled" || type === "subscription.expired") && !local && checkoutId) {
      db.prepare("UPDATE billing_dodo_checkout_sessions SET status=?,updated_at=? WHERE id=?")
        .run(type === "subscription.expired" ? "expired" : "failed", now(), checkoutId);
      markProcessed();
      return { processed: true, failed: true, eventId: event.event_id };
    }
    if (type === "subscription.update_payment_method") {
      markProcessed();
      return { processed: true, eventId: event.event_id };
    }
    const status = statusForDodoEvent(type, data.status);
    if (!status) throw fail("Dodo subscription status is unsupported.", "DODO_SUBSCRIPTION_STATUS_INVALID");
    if (!local && type === "subscription.active") {
      const checkout = db.prepare("SELECT * FROM billing_dodo_checkout_sessions WHERE id=? AND status IN ('pending','creating')").get(checkoutId);
      if (!checkout || checkout.user_id !== metadata.executive_visuals_user_id || checkout.plan_id !== metadata.executive_visuals_plan_id) {
        throw fail("Dodo activation does not match a pending local checkout.", "DODO_CHECKOUT_NOT_FOUND", 404);
      }
      const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(checkout.plan_id);
      if (!plan || checkout.provider_product_id !== data.product_id || productIdForPlan(plan.code, env) !== data.product_id ||
          String(data.currency).toUpperCase() !== String(plan.currency).toUpperCase() ||
          Number(data.recurring_pre_tax_amount) !== Number(plan.amount_minor) ||
          data.has_payment_method !== true || !data.next_billing_date) {
        throw fail("Dodo subscription does not match the configured plan price or payment mandate.", "DODO_SUBSCRIPTION_MISMATCH", 409);
      }
      const periodStart = data.previous_billing_date || data.created_at || now();
      const periodEnd = data.next_billing_date;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO billing_subscriptions
          (id,user_id,plan_id,status,provider,provider_customer_id,provider_subscription_id,current_period_start,current_period_end,cancel_at_period_end,metadata_json)
          VALUES(?,?,?,'active','dodo',?,?,?,?,?,?)`)
          .run(randomUUID(), checkout.user_id, plan.id, data.customer_id || null, subscriptionId,
            periodStart, periodEnd, data.cancel_at_next_billing_date === true ? 1 : 0,
            safeJson({ productId: data.product_id, lastProviderTimestamp: payload.timestamp }));
        insertSubscriptionCredits(db, {
          userId: checkout.user_id, plan, subscriptionId, paymentId: data.payment_id,
          periodEnd, idempotencyKey: "dodo-subscription-active:" + subscriptionId + ":" + periodStart,
          description: "Dodo subscription activation credits"
        });
        db.prepare("UPDATE billing_dodo_checkout_sessions SET status='active',updated_at=? WHERE id=?").run(now(), checkout.id);
        markProcessed();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { processed: true, activated: true, eventId: event.event_id };
    }
    if (!local) throw fail("No local subscription matches this Dodo event.", "DODO_SUBSCRIPTION_NOT_FOUND", 404);
    const currentMetadata = parseJson(local.metadata_json);
    const eventTime = String(payload.timestamp || "");
    if (currentMetadata.lastProviderTimestamp && eventTime && eventTime < currentMetadata.lastProviderTimestamp) {
      markProcessed();
      return { processed: true, stale: true, eventId: event.event_id };
    }
    if (type === "subscription.renewed") {
      const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(local.plan_id);
      if (!plan || !data.payment_id || String(data.product_id) !== String(currentMetadata.productId) ||
          String(data.currency).toUpperCase() !== String(plan.currency).toUpperCase() ||
          Number(data.recurring_pre_tax_amount) !== Number(plan.amount_minor) || !data.next_billing_date) {
        throw fail("Dodo renewal does not match the active subscription price.", "DODO_RENEWAL_MISMATCH", 409);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE billing_subscriptions SET status='active',current_period_start=?,current_period_end=?,cancel_at_period_end=?,metadata_json=?,updated_at=? WHERE id=?")
          .run(data.previous_billing_date || now(), data.next_billing_date, data.cancel_at_next_billing_date === true ? 1 : 0,
            safeJson({ ...currentMetadata, lastProviderTimestamp: eventTime, pastDueEndsAt: null }), now(), local.id);
        insertSubscriptionCredits(db, {
          userId: local.user_id, plan, subscriptionId, paymentId: data.payment_id,
          periodEnd: data.next_billing_date, idempotencyKey: "dodo-subscription-renewal:" + subscriptionId + ":" + data.payment_id,
          description: "Dodo subscription renewal credits"
        });
        markProcessed();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { processed: true, renewed: true, eventId: event.event_id };
    }
    if (type === "subscription.plan_changed") {
      const newPlan = findPlanForDodoProduct(db, data.product_id, env);
      if (!newPlan || String(data.currency).toUpperCase() !== String(newPlan.currency).toUpperCase() ||
          Number(data.recurring_pre_tax_amount) !== Number(newPlan.amount_minor)) {
        throw fail("Dodo plan change does not match a configured local plan.", "DODO_PLAN_CHANGE_MISMATCH", 409);
      }
      db.prepare("UPDATE billing_subscriptions SET plan_id=?,status=?,current_period_end=?,cancel_at_period_end=?,metadata_json=?,updated_at=? WHERE id=?")
        .run(newPlan.id, status, data.next_billing_date || local.current_period_end, data.cancel_at_next_billing_date === true ? 1 : 0,
          safeJson({ ...currentMetadata, productId: data.product_id, lastProviderTimestamp: eventTime,
            pastDueEndsAt: data.past_due_ends_at || currentMetadata.pastDueEndsAt || null }), now(), local.id);
    } else {
      db.prepare("UPDATE billing_subscriptions SET status=?,current_period_end=?,cancel_at_period_end=?,metadata_json=?,updated_at=? WHERE id=?")
        .run(status, data.next_billing_date || local.current_period_end, data.cancel_at_next_billing_date === true ? 1 : 0,
          safeJson({ ...currentMetadata, lastProviderTimestamp: eventTime,
            pastDueEndsAt: data.past_due_ends_at || currentMetadata.pastDueEndsAt || null }), now(), local.id);
    }
    markProcessed();
    return { processed: true, status, eventId: event.event_id };
  } catch (error) {
    db.prepare(`UPDATE billing_provider_events SET attempts=attempts+1,last_error=?,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_owner=?`)
      .run(String(error?.code || "DODO_PROCESSING_FAILED").slice(0, 120), event.id, leaseOwner);
    return { processed: false, retryable: true, eventId: event.event_id, errorCode: error?.code || "DODO_PROCESSING_FAILED" };
  }
}

export function getDodoCheckoutStatus(db, { orderId, userId } = {}) {
  const row = db.prepare(`SELECT s.id,s.status,s.provider_session_id,s.created_at,p.name AS plan_name,p.interval
    FROM billing_dodo_checkout_sessions s JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.id=? AND s.user_id=? LIMIT 1`).get(orderId,userId);
  if (!row) throw fail("Dodo checkout order not found.", "DODO_CHECKOUT_NOT_FOUND", 404);
  return { orderId: row.id, status: row.status, sessionId: row.provider_session_id, createdAt: row.created_at, planName: row.plan_name, interval: row.interval };
}
