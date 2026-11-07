import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";

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
 * Flutterwave V4 webhook signature: base64(HMAC-SHA256(rawBody, secretHash)).
 * Raw bytes are required; parsed/re-serialized JSON is not equivalent.
 */
export function verifyFlutterwaveWebhookSignature({ rawBody, signature, secretHash } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 1024 * 1024 ||
      typeof secretHash !== "string" || secretHash.length < 24 || secretHash.length > 512 ||
      typeof signature !== "string" || signature.length > 256) return false;
  const expected = createHmac("sha256", secretHash).update(rawBody).digest("base64");
  return safeEqual(signature, expected);
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

/**
 * Process one persisted webhook. Grant credits only after server-to-server
 * transaction verification and exact tx_ref/currency/amount matching.
 */
export async function processNextFlutterwaveWebhook(db, {
  secretKey,
  verifyTransaction = args => verifyFlutterwaveTransaction({ ...args, secretKey })
} = {}) {
  const event = db.prepare(`SELECT * FROM billing_provider_events
    WHERE provider='flutterwave' AND processed_at IS NULL AND attempts<10
    ORDER BY created_at ASC LIMIT 1`).get();
  if (!event) return { processed: false };
  const payload = parse(event.payload_json);
  const data = payload.data || {};
  try {
    const order = db.prepare("SELECT * FROM billing_payment_orders WHERE tx_ref=? AND provider='flutterwave'").get(data.tx_ref);
    if (!order) throw fail("No pending billing order matches this payment reference.", "BILLING_ORDER_NOT_FOUND", 404);
    if (order.status === "paid") {
      db.prepare("UPDATE billing_provider_events SET processed_at=?,last_error=NULL WHERE id=?").run(now(), event.id);
      return { processed: true, duplicate: true, eventId: event.event_id };
    }
    if (payload.event !== "charge.completed" || data.status !== "successful") {
      db.prepare("UPDATE billing_payment_orders SET status='failed',updated_at=? WHERE id=? AND status='pending'").run(now(), order.id);
      db.prepare("UPDATE billing_provider_events SET processed_at=?,last_error=NULL WHERE id=?").run(now(), event.id);
      return { processed: true, paid: false, eventId: event.event_id };
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
    db.prepare("UPDATE billing_provider_events SET attempts=attempts+1,last_error=? WHERE id=?")
      .run(String(error?.code || "PROCESSING_FAILED").slice(0, 120), event.id);
    return { processed: false, retryable: true, eventId: event.event_id, errorCode: error?.code || "PROCESSING_FAILED" };
  }
}
