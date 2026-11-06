// Credits: a simple, fair way to keep paid AI usage under control.
//
// Every signed-in person gets a free daily top-up. Using a paid provider costs credits. An
// administrator can add credits for someone by email. Everything is stored in the app database
// and is checked on the server, never in the browser.
//
// Turned on with CREDITS_ENABLED=true. Settings (all optional):
//   CREDITS_DAILY_FREE   credits topped up each day, default 20 (0 means no free credits)
//
// Note: on hosting without a persistent disk the database resets on redeploy, so balances do too.

import { createHash, createHmac, randomUUID } from "node:crypto";

export const DEFAULT_DAILY_FREE = 20;
export const MAX_GRANT = 100000;

/** What each kind of paid request costs. Unknown kinds cost 1. */
export const CREDIT_COSTS = Object.freeze({
  "text.generate": 1,
  "text.summarize": 1,
  "text.translate": 1,
  "voice.generate": 2,
  "voice.transcribe": 1,
  "image.generate": 3,
  "video.generate": 15
});

export function creditsEnabled(env = process.env) {
  return env.CREDITS_ENABLED === "true";
}

export function dailyFreeCredits(env = process.env) {
  const raw = env.CREDITS_DAILY_FREE;
  if (raw === undefined || raw === "") return DEFAULT_DAILY_FREE;
  if (!/^[0-9]+$/.test(String(raw)) || Number(raw) > 10000) throw Object.assign(new Error("CREDITS_DAILY_FREE must be a whole number from 0 to 10000."), { code: "CREDITS_CONFIG_INVALID" });
  return Number(raw);
}

export function costFor(capability) {
  return Object.prototype.hasOwnProperty.call(CREDIT_COSTS, capability) ? CREDIT_COSTS[capability] : 1;
}

const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const nextDayMs = ms => Date.parse(dayKey(ms) + "T00:00:00.000Z") + 24 * 60 * 60 * 1000;

export function emailHash(email, secret = process.env.AUTH_IDENTIFIER_HMAC_KEY) {
  const normalized = String(email || "").trim().toLowerCase().slice(0, 320);
  return secret ? createHmac("sha256", secret).update(normalized).digest("hex") : createHash("sha256").update(normalized).digest("hex");
}

export function ensureCreditTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_accounts (
      owner_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
      last_refill_day TEXT,
      email_hash TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credit_accounts_email_idx ON credit_accounts(email_hash);
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference TEXT,
      balance_after INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credit_ledger_owner_idx ON credit_ledger(owner_id, created_at_ms DESC);
  `);
}

function addLedger(db, ownerId, delta, reason, reference, balanceAfter, now) {
  db.prepare("INSERT INTO credit_ledger(id,owner_id,delta,reason,reference,balance_after,created_at_ms) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(), ownerId, delta, reason, reference ? String(reference).slice(0, 120) : null, balanceAfter, now);
  db.prepare("DELETE FROM credit_ledger WHERE owner_id=? AND id NOT IN (SELECT id FROM credit_ledger WHERE owner_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 200)").run(ownerId, ownerId);
}

/** Runs fn inside one write transaction so two requests can never spend the same credit. */
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}

/** Applies today's free top-up (never lowers a balance) and returns the account row. Call inside a transaction. */
function accountWithRefill(db, ownerId, now, env, email) {
  let row = db.prepare("SELECT balance,last_refill_day,email_hash FROM credit_accounts WHERE owner_id=?").get(ownerId);
  const today = dayKey(now), free = dailyFreeCredits(env);
  if (!row) {
    db.prepare("INSERT INTO credit_accounts(owner_id,balance,last_refill_day,email_hash,updated_at_ms) VALUES(?,?,?,?,?)").run(ownerId, free, today, email ? emailHash(email) : null, now);
    if (free > 0) addLedger(db, ownerId, free, "daily_free", today, free, now);
    return { balance: free, last_refill_day: today };
  }
  if (email && !row.email_hash) db.prepare("UPDATE credit_accounts SET email_hash=? WHERE owner_id=?").run(emailHash(email), ownerId);
  if (row.last_refill_day !== today) {
    const topUp = Math.max(0, free - row.balance);
    const balance = row.balance + topUp;
    db.prepare("UPDATE credit_accounts SET balance=?,last_refill_day=?,updated_at_ms=? WHERE owner_id=?").run(balance, today, now, ownerId);
    if (topUp > 0) addLedger(db, ownerId, topUp, "daily_free", today, balance, now);
    row = { balance, last_refill_day: today };
  }
  return row;
}

/** Balance, next top-up time and recent activity for one person. */
export function getCredits(db, { ownerId, email = null, now = Date.now(), env = process.env }) {
  ensureCreditTables(db);
  return transaction(db, () => {
    const row = accountWithRefill(db, ownerId, now, env, email);
    const recent = db.prepare("SELECT delta,reason,reference,balance_after AS balanceAfter,created_at_ms AS createdAtMs FROM credit_ledger WHERE owner_id=? ORDER BY created_at_ms DESC, rowid DESC LIMIT 20").all(ownerId)
      .map(item => ({ delta: Number(item.delta), reason: item.reason, reference: item.reference, balanceAfter: Number(item.balanceAfter), createdAtMs: Number(item.createdAtMs) }));
    return { balance: Number(row.balance), dailyFree: dailyFreeCredits(env), nextRefillAtMs: nextDayMs(now), costs: { ...CREDIT_COSTS }, recent };
  });
}

/** Take credits for one request. Throws INSUFFICIENT_CREDITS (402) when the balance is too low. */
export function spendCredits(db, { ownerId, capability, reference = null, email = null, now = Date.now(), env = process.env }) {
  ensureCreditTables(db);
  const cost = costFor(capability);
  return transaction(db, () => {
    const row = accountWithRefill(db, ownerId, now, env, email);
    if (row.balance < cost) {
      throw Object.assign(new Error("Not enough credits for this. You have " + row.balance + " and it needs " + cost + ". Free credits refill daily."), {
        code: "INSUFFICIENT_CREDITS", status: 402, balance: Number(row.balance), cost, nextRefillAtMs: nextDayMs(now)
      });
    }
    const balance = row.balance - cost;
    db.prepare("UPDATE credit_accounts SET balance=?,updated_at_ms=? WHERE owner_id=?").run(balance, now, ownerId);
    addLedger(db, ownerId, -cost, "spent:" + String(capability).slice(0, 60), reference, balance, now);
    return { charged: cost, balance };
  });
}

/** Give credits back, for example when a paid request failed. */
export function refundCredits(db, { ownerId, amount, reason = "refund", reference = null, now = Date.now() }) {
  ensureCreditTables(db);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_GRANT) throw Object.assign(new Error("Refund must be a whole number of credits."), { code: "INVALID_CREDIT_AMOUNT" });
  return transaction(db, () => {
    const row = db.prepare("SELECT balance FROM credit_accounts WHERE owner_id=?").get(ownerId);
    if (!row) return { balance: 0, refunded: 0 };
    const balance = row.balance + amount;
    db.prepare("UPDATE credit_accounts SET balance=?,updated_at_ms=? WHERE owner_id=?").run(balance, now, ownerId);
    addLedger(db, ownerId, amount, reason, reference, balance, now);
    return { balance, refunded: amount };
  });
}

/**
 * Administrator adds credits for a person, found by the email they signed in with.
 * That person must have opened the app at least once (so their account exists).
 */
export function adminGrantCredits(db, { email, amount, note = "", now = Date.now() }) {
  ensureCreditTables(db);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_GRANT) throw Object.assign(new Error("Enter a whole number of credits from 1 to " + MAX_GRANT + "."), { code: "INVALID_CREDIT_AMOUNT", status: 400 });
  const hash = emailHash(email);
  return transaction(db, () => {
    const row = db.prepare("SELECT owner_id,balance FROM credit_accounts WHERE email_hash=?").get(hash);
    if (!row) throw Object.assign(new Error("No account with that email has opened the app yet. Ask them to sign in once, then try again."), { code: "CREDIT_ACCOUNT_NOT_FOUND", status: 404 });
    const balance = row.balance + amount;
    db.prepare("UPDATE credit_accounts SET balance=?,updated_at_ms=? WHERE owner_id=?").run(balance, now, row.owner_id);
    addLedger(db, row.owner_id, amount, "admin_grant", String(note || "").slice(0, 80) || null, balance, now);
    return { balance, granted: amount, targetHash: hash };
  });
}
