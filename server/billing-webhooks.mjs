import { randomUUID } from "node:crypto";

const now = () => new Date().toISOString();

function fail(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Local billing webhook ledger schema.
 *
 * This module deliberately records purchase intent only. It does not create a
 * checkout session, contact a payment provider, mark an order paid, or grant
 * credits. A verified provider webhook must perform those later transitions.
 */
export function ensureBillingWebhookSchema(db) {
  if (!db) throw new Error("Billing webhook database is required.");

  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      provider TEXT NOT NULL DEFAULT 'flutterwave',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','paid','failed','cancelled','expired','refunded')),
      expected_amount_minor INTEGER NOT NULL CHECK(expected_amount_minor > 0),
      currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
      provider_payment_id TEXT,
      provider_checkout_id TEXT,
      checkout_url TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      verified_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_orders_provider_payment_idx
      ON billing_payment_orders(provider,provider_payment_id)
      WHERE provider_payment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS billing_payment_orders_user_created_idx
      ON billing_payment_orders(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS billing_payment_orders_verified_idx
      ON billing_payment_orders(status,verified_at DESC);

    CREATE TABLE IF NOT EXISTS billing_refund_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      refund_id TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
      created_at TEXT NOT NULL,
      user_id TEXT REFERENCES billing_accounts(user_id) ON DELETE SET NULL,
      reconciliation_required INTEGER NOT NULL DEFAULT 0
        CHECK(reconciliation_required IN (0,1)),
      reconciliation_note TEXT NOT NULL DEFAULT '',
      UNIQUE(provider,refund_id)
    );
    CREATE INDEX IF NOT EXISTS billing_refund_events_reconciliation_idx
      ON billing_refund_events(reconciliation_required,created_at DESC);
  `);

  const eventColumns = new Set(
    db.prepare("PRAGMA table_info(billing_provider_events)").all().map(row => row.name)
  );
  if (!eventColumns.has("payload_json")) {
    db.exec("ALTER TABLE billing_provider_events ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
  }
}

/**
 * Persist a pending one-time purchase order for an existing active account.
 * Provider checkout creation is intentionally a separate, explicitly gated
 * operation; this function never initiates a charge.
 */
export function createBillingPurchaseOrder(db, {
  userId,
  planId,
  provider = "flutterwave",
  metadata = {}
} = {}) {
  const user = String(userId || "").trim();
  const plan = String(planId || "").trim();
  const providerName = String(provider || "").trim().toLowerCase();
  if (!user || user.length > 256) throw fail("A valid billing user is required.", "BILLING_USER_REQUIRED", 401);
  if (!plan || plan.length > 256) throw fail("A valid billing plan is required.", "BILLING_PLAN_REQUIRED");
  if (!/^[a-z][a-z0-9_-]{1,39}$/.test(providerName)) {
    throw fail("Payment provider identifier is invalid.", "BILLING_PROVIDER_INVALID");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw fail("Purchase metadata must be an object.", "BILLING_PURCHASE_METADATA_INVALID");
  }
  const metadataJson = JSON.stringify(metadata);
  if (Buffer.byteLength(metadataJson, "utf8") > 8192) {
    throw fail("Purchase metadata exceeds the 8 KB limit.", "BILLING_PURCHASE_METADATA_TOO_LARGE");
  }

  const account = db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(user);
  if (!account) throw fail("Billing account does not exist.", "BILLING_ACCOUNT_NOT_FOUND", 404);
  if (account.status !== "active") throw fail("Billing account is not active.", "BILLING_ACCOUNT_SUSPENDED", 403);

  const selectedPlan = db.prepare(
    "SELECT id,code,active,amount_minor,currency,interval FROM billing_plans WHERE id=?"
  ).get(plan);
  if (!selectedPlan || Number(selectedPlan.active) !== 1) {
    throw fail("Selected billing plan is unavailable.", "BILLING_PLAN_UNAVAILABLE", 404);
  }
  const amount = Number(selectedPlan.amount_minor);
  const currency = String(selectedPlan.currency || "").toUpperCase();
  if (selectedPlan.interval !== "one_time" || !Number.isSafeInteger(amount) || amount <= 0 ||
      !/^[A-Z]{3}$/.test(currency)) {
    throw fail("Only valid, priced one-time plans can create purchase orders.", "BILLING_PURCHASE_PLAN_INVALID");
  }

  const id = randomUUID();
  const timestamp = now();
  db.prepare(`INSERT INTO billing_payment_orders
    (id,user_id,plan_id,provider,status,expected_amount_minor,currency,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,'pending',?,?,?,?,?)`)
    .run(id,user,plan,providerName,amount,currency,metadataJson,timestamp,timestamp);

  const row = db.prepare("SELECT * FROM billing_payment_orders WHERE id=?").get(id);
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    provider: row.provider,
    status: row.status,
    expectedAmountMinor: Number(row.expected_amount_minor),
    currency: row.currency,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    metadata: JSON.parse(row.metadata_json || "{}")
  };
}
