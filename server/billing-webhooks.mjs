import { createHash, timingSafeEqual, randomUUID } from "node:crypto";

const now = () => new Date().toISOString();
const json = value => JSON.stringify(value ?? {});
const parse = value => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function currencyExponent(currency) {
  const code = String(currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  if (["UGX", "RWF", "TZS", "JPY", "KRW", "XAF", "XOF", "XPF", "BIF", "DJF", "GNF", "KMF", "PYG", "VND", "VUV"].includes(code)) return 0;
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(code)) return 3;
  return 2;
}

export function ensureBillingWebhookSchema(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(billing_provider_events)").all().map(row => row.name));
  if (!columns.has("payload_json")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has("attempts")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("last_error")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN last_error TEXT");
  if (!columns.has("processing_at")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN processing_at TEXT");
  if (!columns.has("lease_expires_at")) db.exec("ALTER TABLE billing_provider_events ADD COLUMN lease_expires_at TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      provider TEXT NOT NULL CHECK(provider IN ('flutterwave')),
      tx_ref TEXT NOT NULL UNIQUE,
      expected_amount_minor INTEGER NOT NULL CHECK(expected_amount_minor > 0),
      currency TEXT NOT NULL,
      credits INTEGER NOT NULL CHECK(credits > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','expired')),
      provider_transaction_id TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_provider_tx_idx
      ON billing_payment_orders(provider,provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS billing_payment_pending_idx
      ON billing_payment_orders(provider,status,created_at);
  `);
}

export function createBillingPurchaseOrder(db, { userId, planId, provider = "flutterwave" } = {}) {
  if (provider !== "flutterwave") throw fail("This checkout order adapter currently supports Flutterwave one-time payments only.", "BILLING_PROVIDER_UNSUPPORTED");
  const user = db.prepare("SELECT user_id,status FROM billing_accounts WHERE user_id=?").get(userId);
  const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(planId);
  if (!user || user.status !== "active" || !plan) throw fail("Active account and plan are required.", "BILLING_TARGET_NOT_FOUND", 404);
  if (plan.interval !== "one_time" || !Number.isSafeInteger(Number(plan.amount_minor)) ||
      Number(plan.amount_minor) <= 0 || !Number.isSafeInteger(Number(plan.credits_per_period)) ||
      Number(plan.credits_per_period) <= 0 || currencyExponent(plan.currency) === null) {
    throw fail("Payment order requires an active one-time credit product with a supported currency and positive price.", "BILLING_PRODUCT_INVALID");
  }
  const id = randomUUID();
  const txRef = "ev_" + id.replaceAll("-", "");
  const timestamp = now();
  db.prepare(`INSERT INTO billing_payment_orders
    (id,user_id,plan_id,provider,tx_ref,expected_amount_minor,currency,credits,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`)
    .run(id, userId, planId, provider, txRef, Number(plan.amount_minor), String(plan.currency).toUpperCase(),
      Number(plan.credits_per_period), timestamp, timestamp);
  return {
    id, userId, planId, provider, txRef,
    amountMinor: Number(plan.amount_minor), currency: String(plan.currency).toUpperCase(),
    credits: Number(plan.credits_per_period), status: "pending"
  };
}

/**
 * Flutterwave Standard API v3 webhooks use the dashboard-configured secret
 * hash in the "verif-hash" header. Transaction authenticity is then confirmed
 * independently against the v3 transaction-verification API before settlement.
 */
export function verifyFlutterwaveWebhookSignature({ rawBody, signature, secretHash } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 1024 * 1024 ||
      typeof secretHash !== "string" || secretHash.length < 24 || secretHash.length > 512 ||
      typeof signature !== "string" || signature.length > 512) return false;
  return safeEqual(signature, secretHash);
}

export function receiveFlutterwaveWebhook(db, { rawBody, signature, secretHash } = {}) {
  if (!verifyFlutterwaveWebhookSignature({ rawBody, signature, secretHash })) {
    throw fail("Flutterwave webhook signature is invalid.", "BILLING_WEBHOOK_SIGNATURE_INVALID", 401);
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { throw fail("Flutterwave webhook body is not valid JSON.", "BILLING_WEBHOOK_INVALID", 400); }
  const eventType = String(payload?.event || "");
  const data = payload?.data;
  const transactionId = String(data?.id ?? "");
  const txRef = String(data?.tx_ref ?? "");
  const status = String(data?.status ?? "").toLowerCase();
  const amount = Number(data?.amount);
  const currency = String(data?.currency || "").toUpperCase();
  if (!["charge.completed", "charge.failed"].includes(eventType) ||
      !/^[0-9]{1,30}$/.test(transactionId) || !/^ev_[a-f0-9]{32}$/.test(txRef) ||
      !["successful", "failed", "pending"].includes(status) ||
      !Number.isFinite(amount) || amount < 0 || currencyExponent(currency) === null) {
    throw fail("Flutterwave webhook event fields are invalid or unsupported.", "BILLING_WEBHOOK_INVALID", 400);
  }
  const eventId = eventType + ":" + transactionId + ":" + status;
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const minimalPayload = { event: eventType, data: { id: transactionId, tx_ref: txRef, status, amount, currency } };
  const existing = db.prepare("SELECT payload_hash FROM billing_provider_events WHERE provider='flutterwave' AND event_id=?").get(eventId);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw fail("Flutterwave reused an event identity with different content.", "BILLING_WEBHOOK_REPLAY_CONFLICT", 409);
    return { accepted: true, duplicate: true, eventId };
  }
  db.prepare(`INSERT INTO billing_provider_events
    (id,provider,event_id,event_type,payload_hash,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?)`)
    .run(randomUUID(), "flutterwave", eventId, eventType, payloadHash, json(minimalPayload), now());
  return { accepted: true, duplicate: false, eventId };
}

export async function verifyFlutterwaveTransaction({ transactionId, secretKey, fetchImpl = fetch } = {}) {
  if (!/^[0-9]{1,30}$/.test(String(transactionId || "")) ||
      typeof secretKey !== "string" || secretKey.length < 12) {
    throw fail("Flutterwave transaction verification is not configured.", "BILLING_PROVIDER_CONFIG_INVALID", 503);
  }
  const response = await fetchImpl("https://api.flutterwave.com/v3/transactions/" +
    encodeURIComponent(String(transactionId)) + "/verify", {
    method: "GET",
    headers: { authorization: "Bearer " + secretKey, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw fail("Flutterwave transaction verification request failed.", "BILLING_PROVIDER_VERIFY_FAILED", 502);
  const body = await response.json();
  if (body?.status !== "success" || !body?.data) throw fail("Flutterwave did not return verified transaction data.", "BILLING_PROVIDER_VERIFY_FAILED", 502);
  return body.data;
}


export async function createFlutterwaveCheckout(db, {
  user,
  planId,
  secretKey,
  publicAppUrl,
  fetchImpl = fetch
} = {}) {
  if (!user?.id || !user?.email) throw fail("Authenticated customer identity is required.", "BILLING_USER_REQUIRED", 401);
  if (typeof secretKey !== "string" || secretKey.length < 12) {
    throw fail("Flutterwave checkout is not configured.", "BILLING_PROVIDER_CONFIG_INVALID", 503);
  }
  let baseUrl;
  try { baseUrl = new URL(publicAppUrl); } catch {
    throw fail("A valid public application URL is required for payment redirects.", "BILLING_REDIRECT_URL_INVALID", 503);
  }
  const local = ["localhost", "127.0.0.1"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production")) {
    throw fail("Payment return URLs must use HTTPS.", "BILLING_REDIRECT_URL_INVALID", 503);
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw fail("Payment return URL must not contain credentials, query parameters or fragments.", "BILLING_REDIRECT_URL_INVALID", 503);
  }
  const order = createBillingPurchaseOrder(db, { userId: user.id, planId, provider: "flutterwave" });
  const exponent = currencyExponent(order.currency);
  const amount = order.amountMinor / (10 ** exponent);
  const returnUrl = new URL("/billing/return", baseUrl).toString();
  const paymentOptions = order.currency === "UGX" ? "card, mobilemoneyuganda" : "card";
  let response;
  try {
    response = await fetchImpl("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        authorization: "Bearer " + secretKey,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        tx_ref: order.txRef,
        amount,
        currency: order.currency,
        redirect_url: returnUrl,
        customer: { email: String(user.email).trim().toLowerCase() },
        customizations: { title: "Executive Visuals", description: "Credit purchase" },
        payment_options: paymentOptions,
        meta: { payment_order_id: order.id }
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave checkout could not be created. No credits were granted.", "BILLING_CHECKOUT_CREATE_FAILED", 502);
  }
  if (!response.ok) {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave rejected the checkout request. No credits were granted.", "BILLING_CHECKOUT_CREATE_FAILED", 502);
  }
  let body;
  try { body = await response.json(); } catch {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave returned an invalid checkout response.", "BILLING_PROVIDER_RESPONSE_INVALID", 502);
  }
  let checkoutUrl;
  try { checkoutUrl = new URL(body?.data?.link); } catch {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave did not return a valid hosted checkout URL.", "BILLING_PROVIDER_RESPONSE_INVALID", 502);
  }
  if (body?.status !== "success" || checkoutUrl.protocol !== "https:" ||
      !(checkoutUrl.hostname === "flutterwave.com" || checkoutUrl.hostname.endsWith(".flutterwave.com"))) {
    db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
    throw fail("Flutterwave returned an untrusted checkout destination.", "BILLING_PROVIDER_RESPONSE_INVALID", 502);
  }
  return { orderId: order.id, txRef: order.txRef, checkoutUrl: checkoutUrl.toString(),
    amountMinor: order.amountMinor, currency: order.currency, credits: order.credits };
}

/**
 * Process one persisted webhook. Grant credits only after server-to-server
 * transaction verification and exact tx_ref/currency/amount matching.
 */
export async function processNextFlutterwaveWebhook(db, {
  secretKey,
  verifyTransaction = args => verifyFlutterwaveTransaction({ ...args, secretKey })
} = {}) {
  const claimTime = now();
  let event;
  db.exec("BEGIN IMMEDIATE");
  try {
    event = db.prepare(`SELECT * FROM billing_provider_events
      WHERE provider='flutterwave' AND processed_at IS NULL AND attempts<10
        AND (processing_at IS NULL OR lease_expires_at IS NULL OR lease_expires_at<?)
      ORDER BY created_at ASC LIMIT 1`).get(claimTime);
    if (event) {
      const claimed = db.prepare(`UPDATE billing_provider_events
        SET processing_at=?,lease_expires_at=?,attempts=attempts+1
        WHERE id=? AND processed_at IS NULL
          AND (processing_at IS NULL OR lease_expires_at IS NULL OR lease_expires_at<?)`)
        .run(claimTime, new Date(Date.parse(claimTime) + 120000).toISOString(), event.id, claimTime);
      if (claimed.changes !== 1) event = null;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!event) return { processed: false };
  const payload = parse(event.payload_json);
  const data = payload.data || {};
  try {
    const order = db.prepare("SELECT * FROM billing_payment_orders WHERE tx_ref=? AND provider='flutterwave'").get(data.tx_ref);
    if (!order) throw fail("No pending billing order matches this payment reference.", "BILLING_ORDER_NOT_FOUND", 404);
    if (order.status === "paid") {
      db.prepare("UPDATE billing_provider_events SET processed_at=?,last_error=NULL,processing_at=NULL,lease_expires_at=NULL WHERE id=?").run(now(), event.id);
      return { processed: true, duplicate: true, eventId: event.event_id };
    }
    if (order.status !== "pending") {
      throw fail("Billing order is no longer eligible for payment settlement.", "BILLING_ORDER_NOT_PENDING", 409);
    }
    if (payload.event === "charge.failed" || data.status === "failed") {
      db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
      db.prepare("UPDATE billing_provider_events SET processed_at=?,last_error=NULL WHERE id=?").run(now(), event.id);
      return { processed: true, paid: false, eventId: event.event_id };
    }
    if (payload.event !== "charge.completed" || data.status !== "successful") {
      throw fail("Flutterwave payment is not in a terminal successful state yet.", "BILLING_PAYMENT_PENDING", 409);
    }
    const verified = await verifyTransaction({ transactionId: String(data.id) });
    const exponent = currencyExponent(order.currency);
    const paidMinor = Math.round(Number(verified?.amount) * (10 ** exponent));
    if (String(verified?.id) !== String(data.id) ||
        String(verified?.tx_ref) !== order.tx_ref ||
        String(verified?.status).toLowerCase() !== "successful" ||
        String(verified?.currency).toUpperCase() !== order.currency ||
        !Number.isSafeInteger(paidMinor) || paidMinor < Number(order.expected_amount_minor)) {
      throw fail("Verified Flutterwave transaction does not match the pending order.", "BILLING_PAYMENT_MISMATCH", 409);
    }
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = db.prepare("SELECT * FROM billing_payment_orders WHERE id=?").get(order.id);
      if (latest.status !== "paid") {
        db.prepare("INSERT OR IGNORE INTO billing_credit_ledger(id,user_id,amount,event_type,description,reference_id,idempotency_key,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(), latest.user_id, Number(latest.credits), "purchase", "Credit purchase", latest.id,
            "flutterwave-purchase:" + latest.id, json({ provider: "flutterwave", transactionId: String(verified.id), txRef: latest.tx_ref }));
        db.prepare("UPDATE billing_payment_orders SET status='paid',provider_transaction_id=?,verified_at=?,updated_at=? WHERE id=?")
          .run(String(verified.id), timestamp, timestamp, latest.id);
      }
      db.prepare("UPDATE billing_provider_events SET processed_at=?,last_error=NULL WHERE id=?").run(timestamp, event.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { processed: true, paid: true, eventId: event.event_id, paymentOrderId: order.id };
  } catch (error) {
    db.prepare("UPDATE billing_provider_events SET last_error=?,processing_at=NULL,lease_expires_at=NULL WHERE id=?")
      .run(String(error?.code || "PROCESSING_FAILED").slice(0, 120), event.id);
    return { processed: false, retryable: true, eventId: event.event_id, errorCode: error?.code || "PROCESSING_FAILED" };
  }
}
