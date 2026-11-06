import { randomUUID } from "node:crypto";

const isoNow = () => new Date().toISOString();
const safeJson = value => JSON.stringify(value ?? {});
const parseJson = value => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };

function fail(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function ensureBillingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_accounts (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_accounts_email_idx ON billing_accounts(email);
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount_minor INTEGER,
      currency TEXT NOT NULL DEFAULT 'USD',
      interval TEXT NOT NULL DEFAULT 'month' CHECK(interval IN ('month','year','one_time')),
      credits_per_period INTEGER NOT NULL DEFAULT 0 CHECK(credits_per_period >= 0),
      limits_json TEXT NOT NULL DEFAULT '{}',
      features_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES billing_plans(id),
      status TEXT NOT NULL CHECK(status IN ('trialing','active','past_due','cancelled','expired','paused')),
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_customer_id TEXT,
      provider_subscription_id TEXT,
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_subscriptions_user_idx ON billing_subscriptions(user_id,status,current_period_end DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_provider_idx ON billing_subscriptions(provider,provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS billing_credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES billing_accounts(user_id) ON DELETE CASCADE,
      amount INTEGER NOT NULL CHECK(amount <> 0),
      event_type TEXT NOT NULL CHECK(event_type IN ('admin_grant','admin_adjustment','subscription_grant','generation_spend','generation_refund','purchase','expiry','migration')),
      description TEXT NOT NULL DEFAULT '',
      reference_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS billing_ledger_user_idx ON billing_credit_ledger(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS billing_provider_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider,event_id)
    );
    CREATE TABLE IF NOT EXISTS billing_model_prices (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      capability TEXT NOT NULL,
      unit TEXT NOT NULL,
      price_micros INTEGER NOT NULL CHECK(price_micros >= 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      source_url TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider,model,capability,unit)
    );
  `);
  const existing = db.prepare("SELECT id FROM billing_plans WHERE code='free'").get();
  if (!existing) {
    db.prepare("INSERT INTO billing_plans(id,code,name,description,amount_minor,currency,interval,credits_per_period,limits_json,features_json,active) VALUES(?,?,?,?,?,?,?,?,?,?,1)")
      .run(randomUUID(), "free", "Free", "Explore the workspace and use non-billable local editing tools.", 0, "USD", "month", 0,
        safeJson({ seats: 1, concurrentJobs: 1, storageBytes: 268435456, modelAllowlist: [] }),
        safeJson(["Creative planning", "Project workspace", "Local editing and export where runtime permits"]));
  }
}

export function touchBillingAccount(db, user) {
  if (!user?.id || !user?.email) throw fail("Authenticated user identity is required.", "BILLING_USER_REQUIRED", 401);
  db.prepare(`INSERT INTO billing_accounts(user_id,email,status) VALUES(?,?,'active')
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(String(user.id), String(user.email).trim().toLowerCase());
  const active = db.prepare(`SELECT id FROM billing_subscriptions WHERE user_id=? AND status IN ('active','trialing','past_due') AND current_period_end>? ORDER BY current_period_end DESC LIMIT 1`)
    .get(String(user.id), isoNow());
  if (!active) {
    const free = db.prepare("SELECT id FROM billing_plans WHERE code='free' AND active=1").get();
    if (free) {
      const start = isoNow(), end = new Date(Date.now() + 3650 * 86400000).toISOString();
      db.prepare("INSERT INTO billing_subscriptions(id,user_id,plan_id,status,provider,current_period_start,current_period_end) VALUES(?,?,?,'active','system',?,?)")
        .run(randomUUID(), String(user.id), free.id, start, end);
    }
  }
  return db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(String(user.id));
}

export function getBillingBalance(db, userId, at = isoNow()) {
  const row = db.prepare("SELECT COALESCE(SUM(amount),0) AS balance FROM billing_credit_ledger WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)").get(userId, at);
  return Number(row?.balance || 0);
}

export function listBillingPlans(db, { activeOnly = true } = {}) {
  const rows = db.prepare("SELECT * FROM billing_plans " + (activeOnly ? "WHERE active=1 " : "") + "ORDER BY amount_minor ASC,name ASC").all();
  return rows.map(row => ({
    id: row.id, code: row.code, name: row.name, description: row.description,
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor), currency: row.currency,
    interval: row.interval, creditsPerPeriod: Number(row.credits_per_period),
    limits: parseJson(row.limits_json), features: parseJson(row.features_json), active: !!row.active
  }));
}

export function getBillingOverview(db, userId) {
  const at = isoNow();
  const subscription = db.prepare(`SELECT s.*,p.code AS plan_code,p.name AS plan_name,p.description AS plan_description,
    p.amount_minor,p.currency,p.interval,p.credits_per_period,p.limits_json,p.features_json
    FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.user_id=? AND s.status IN ('active','trialing','past_due') AND s.current_period_end>?
    ORDER BY s.current_period_end DESC LIMIT 1`).get(userId, at);
  const account = db.prepare("SELECT status FROM billing_accounts WHERE user_id=?").get(userId);
  const usage = db.prepare(`SELECT COUNT(*) AS operations,COALESCE(SUM(estimated_cost_micros),0) AS estimated_cost_micros
    FROM model_usage_events WHERE owner_id=? AND created_at>=?`).get(userId, new Date(Date.now()-30*86400000).toISOString());
  const ledger = db.prepare("SELECT id,amount,event_type,description,reference_id,expires_at,created_at FROM billing_credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 30").all(userId);
  const plan = subscription ? {
    id: subscription.plan_id, code: subscription.plan_code, name: subscription.plan_name,
    description: subscription.plan_description, amountMinor: subscription.amount_minor === null ? null : Number(subscription.amount_minor),
    currency: subscription.currency, interval: subscription.interval, creditsPerPeriod: Number(subscription.credits_per_period),
    limits: parseJson(subscription.limits_json), features: parseJson(subscription.features_json)
  } : null;
  return {
    accountStatus: account?.status || "active",
    balance: getBillingBalance(db, userId, at),
    plan,
    subscription: subscription ? { id: subscription.id, status: subscription.status, provider: subscription.provider,
      currentPeriodStart: subscription.current_period_start, currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end } : null,
    usage30d: { operations: Number(usage.operations || 0), estimatedCostMicros: Number(usage.estimated_cost_micros || 0) },
    ledger: ledger.map(row => ({ id: row.id, amount: Number(row.amount), type: row.event_type, description: row.description,
      referenceId: row.reference_id, expiresAt: row.expires_at, createdAt: row.created_at }))
  };
}

export function getAdminOverview(db) {
  const users = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) AS suspended FROM billing_accounts").get();
  const subscriptions = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN status='past_due' THEN 1 ELSE 0 END) AS past_due FROM billing_subscriptions").get();
  const jobs = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('queued','running','reviewing') THEN 1 ELSE 0 END) AS in_flight FROM jobs").get();
  const usage = db.prepare("SELECT COUNT(*) AS operations,COALESCE(SUM(estimated_cost_micros),0) AS estimated_cost_micros FROM model_usage_events WHERE created_at>=?").get(new Date(Date.now()-30*86400000).toISOString());
  return { users: { total: Number(users.total||0), active: Number(users.active||0), suspended: Number(users.suspended||0) },
    subscriptions: { total: Number(subscriptions.total||0), active: Number(subscriptions.active||0), pastDue: Number(subscriptions.past_due||0) },
    jobs: { total: Number(jobs.total||0), inFlight: Number(jobs.in_flight||0) },
    usage30d: { operations: Number(usage.operations||0), estimatedCostMicros: Number(usage.estimated_cost_micros||0) },
    billingProviderConfigured: !!(process.env.FLUTTERWAVE_SECRET_KEY || process.env.PADDLE_API_KEY),
    paymentCollectionEnabled: false };
}

export function listAdminUsers(db, { query = "", limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const term = String(query || "").trim().toLowerCase();
  const rows = term
    ? db.prepare(`SELECT a.user_id,a.email,a.status,a.created_at,a.last_seen_at,
        (SELECT p.name FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id WHERE s.user_id=a.user_id AND s.status IN ('active','trialing','past_due') ORDER BY s.current_period_end DESC LIMIT 1) AS plan_name
        FROM billing_accounts a WHERE lower(a.email) LIKE ? ORDER BY a.last_seen_at DESC LIMIT ?`).all("%"+term+"%", safeLimit)
    : db.prepare(`SELECT a.user_id,a.email,a.status,a.created_at,a.last_seen_at,
        (SELECT p.name FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id WHERE s.user_id=a.user_id AND s.status IN ('active','trialing','past_due') ORDER BY s.current_period_end DESC LIMIT 1) AS plan_name
        FROM billing_accounts a ORDER BY a.last_seen_at DESC LIMIT ?`).all(safeLimit);
  return rows.map(row => ({ id: row.user_id, email: row.email, status: row.status, createdAt: row.created_at, lastSeenAt: row.last_seen_at, planName: row.plan_name || "No active plan" }));
}

export function saveBillingPlan(db, input) {
  const code = String(input.code || "").trim().toLowerCase();
  const name = String(input.name || "").trim();
  const description = String(input.description || "").trim();
  const currency = String(input.currency || "USD").trim().toUpperCase();
  const interval = String(input.interval || "month");
  const amount = input.amountMinor === null || input.amountMinor === undefined || input.amountMinor === "" ? null : Number(input.amountMinor);
  const credits = Number(input.creditsPerPeriod ?? 0);
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code) || !name || name.length > 80 || description.length > 500) throw fail("Provide a valid plan code, name and description.", "BILLING_PLAN_INVALID");
  if (!/^[A-Z]{3}$/.test(currency) || !["month","year","one_time"].includes(interval)) throw fail("Currency or billing interval is invalid.", "BILLING_PLAN_INVALID");
  if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw fail("Price must be a non-negative integer in the smallest currency unit.", "BILLING_PLAN_INVALID");
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 100000000) throw fail("Credit allowance is invalid.", "BILLING_PLAN_INVALID");
  const limits = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits) ? input.limits : {};
  const features = Array.isArray(input.features) ? input.features.filter(x => typeof x === "string").slice(0,40) : [];
  const active = input.active === false ? 0 : 1;
  const existing = db.prepare("SELECT id FROM billing_plans WHERE code=?").get(code);
  const id = existing?.id || randomUUID();
  db.prepare(`INSERT INTO billing_plans(id,code,name,description,amount_minor,currency,interval,credits_per_period,limits_json,features_json,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET name=excluded.name,description=excluded.description,amount_minor=excluded.amount_minor,currency=excluded.currency,
    interval=excluded.interval,credits_per_period=excluded.credits_per_period,limits_json=excluded.limits_json,features_json=excluded.features_json,
    active=excluded.active,updated_at=excluded.updated_at`)
    .run(id,code,name,description,amount,currency,interval,credits,safeJson(limits),safeJson(features),active);
  return listBillingPlans(db, { activeOnly: false }).find(plan => plan.code === code);
}

export function assignManualSubscription(db, { userId, planId, periodDays = 30, status = "active", actorId }) {
  const user = db.prepare("SELECT user_id FROM billing_accounts WHERE user_id=?").get(userId);
  const plan = db.prepare("SELECT * FROM billing_plans WHERE id=? AND active=1").get(planId);
  if (!user || !plan) throw fail("User or active plan was not found.", "BILLING_TARGET_NOT_FOUND", 404);
  if (!["trialing","active","past_due","paused","cancelled","expired"].includes(status)) throw fail("Subscription status is invalid.", "BILLING_STATUS_INVALID");
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 3660) throw fail("Subscription period must be between 1 and 3660 days.", "BILLING_PERIOD_INVALID");
  const start = isoNow(), end = new Date(Date.now()+periodDays*86400000).toISOString(), id = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE billing_subscriptions SET status='cancelled',updated_at=? WHERE user_id=? AND status IN ('active','trialing','past_due')").run(start,userId);
    db.prepare("INSERT INTO billing_subscriptions(id,user_id,plan_id,status,provider,current_period_start,current_period_end,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(id,userId,planId,status,"manual",start,end,safeJson({assignedBy:actorId}));
    if (Number(plan.credits_per_period) > 0 && ["active","trialing"].includes(status)) {
      db.prepare("INSERT OR IGNORE INTO billing_credit_ledger(id,user_id,amount,event_type,description,reference_id,idempotency_key,expires_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(),userId,Number(plan.credits_per_period),"subscription_grant","Subscription allowance · "+plan.name,id,"subscription:"+id+":"+start,end,safeJson({planCode:plan.code}));
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { id, userId, planId, status, currentPeriodStart: start, currentPeriodEnd: end };
}

export function adjustBillingCredits(db, { userId, amount, description, actorId, idempotencyKey }) {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > 100000000) throw fail("Credit adjustment must be a non-zero whole number.", "BILLING_CREDIT_INVALID");
  const user = db.prepare("SELECT user_id FROM billing_accounts WHERE user_id=?").get(userId);
  if (!user) throw fail("User was not found.", "BILLING_TARGET_NOT_FOUND", 404);
  const key = String(idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 200) throw fail("A unique idempotency key is required.", "BILLING_IDEMPOTENCY_REQUIRED");
  const existing = db.prepare("SELECT id,amount FROM billing_credit_ledger WHERE idempotency_key=?").get(key);
  if (existing) return { id: existing.id, amount: Number(existing.amount), replayed: true, balance: getBillingBalance(db,userId) };
  db.exec("BEGIN IMMEDIATE");
  try {
    const balance = getBillingBalance(db,userId);
    if (balance + value < 0) throw fail("This adjustment would make the user's credit balance negative.", "BILLING_INSUFFICIENT_CREDITS", 409);
    const id = randomUUID();
    db.prepare("INSERT INTO billing_credit_ledger(id,user_id,amount,event_type,description,idempotency_key,metadata_json) VALUES(?,?,?,?,?,?,?)")
      .run(id,userId,value,value>0?"admin_grant":"admin_adjustment",String(description||"Administrator adjustment").slice(0,240),key,safeJson({actorId}));
    db.exec("COMMIT");
    return { id, amount: value, replayed: false, balance: getBillingBalance(db,userId) };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function setBillingAccountStatus(db, { userId, status }) {
  if (!["active","suspended"].includes(status)) throw fail("Account status is invalid.", "BILLING_STATUS_INVALID");
  const result = db.prepare("UPDATE billing_accounts SET status=? WHERE user_id=?").run(status,userId);
  if (!result.changes) throw fail("User was not found.", "BILLING_TARGET_NOT_FOUND", 404);
  return { userId, status };
}

export function listBillingLedger(db, userId, limit = 100) {
  return db.prepare("SELECT id,amount,event_type,description,reference_id,expires_at,created_at FROM billing_credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
    .all(userId,Math.max(1,Math.min(200,Number(limit)||100))).map(row => ({ id:row.id,amount:Number(row.amount),type:row.event_type,description:row.description,referenceId:row.reference_id,expiresAt:row.expires_at,createdAt:row.created_at }));
}

export function canUsePaidModels(db, userId) {
  const row = db.prepare(`SELECT p.limits_json FROM billing_subscriptions s JOIN billing_plans p ON p.id=s.plan_id
    WHERE s.user_id=? AND s.status IN ('active','trialing') AND s.current_period_end>? ORDER BY s.current_period_end DESC LIMIT 1`).get(userId,isoNow());
  if (!row) return false;
  const limits = parseJson(row.limits_json);
  return Array.isArray(limits.modelAllowlist) && limits.modelAllowlist.length > 0;
}
