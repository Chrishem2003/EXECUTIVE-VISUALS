import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  CREDIT_COSTS, costFor, creditsEnabled, dailyFreeCredits, ensureCreditTables,
  getCredits, spendCredits, refundCredits, adminGrantCredits
} from "../credits.mjs";
import { ensureRemoteUsageTable, reserveRemoteRequest } from "../usage-guardrails.mjs";

const DAY = 24 * 60 * 60 * 1000;
const T = Date.parse("2026-11-06T10:00:00Z");
const setup = () => { const db = new DatabaseSync(":memory:"); ensureCreditTables(db); return db; };
const env = (extra = {}) => ({ CREDITS_ENABLED: "true", ...extra });

test("credits are off unless switched on, and settings are validated", () => {
  assert.equal(creditsEnabled({}), false);
  assert.equal(creditsEnabled({ CREDITS_ENABLED: "true" }), true);
  assert.equal(dailyFreeCredits({}), 20);
  assert.equal(dailyFreeCredits({ CREDITS_DAILY_FREE: "0" }), 0);
  assert.throws(() => dailyFreeCredits({ CREDITS_DAILY_FREE: "-5" }), e => e.code === "CREDITS_CONFIG_INVALID");
  assert.throws(() => dailyFreeCredits({ CREDITS_DAILY_FREE: "lots" }), e => e.code === "CREDITS_CONFIG_INVALID");
});

test("a new account starts with the free daily credits and unknown kinds cost one", () => {
  const db = setup();
  const view = getCredits(db, { ownerId: "u1", now: T, env: env() });
  assert.equal(view.balance, 20);
  assert.equal(view.recent[0].reason, "daily_free");
  assert.equal(costFor("video.generate"), CREDIT_COSTS["video.generate"]);
  assert.equal(costFor("something.new"), 1);
  assert.equal(costFor("constructor"), 1, "prototype names are not costs");
});

test("spending lowers the balance and is refused, without changing anything, when too low", () => {
  const db = setup();
  assert.deepEqual(spendCredits(db, { ownerId: "u1", capability: "image.generate", now: T, env: env() }), { charged: 3, balance: 17 });
  spendCredits(db, { ownerId: "u1", capability: "video.generate", now: T, env: env() }); // 15 -> 2 left
  assert.throws(() => spendCredits(db, { ownerId: "u1", capability: "image.generate", now: T, env: env() }), e => {
    assert.equal(e.code, "INSUFFICIENT_CREDITS");
    assert.equal(e.status, 402);
    assert.equal(e.balance, 2);
    assert.equal(e.cost, 3);
    assert.equal(e.nextRefillAtMs, Date.parse("2026-11-07T00:00:00Z"));
    return true;
  });
  assert.equal(getCredits(db, { ownerId: "u1", now: T, env: env() }).balance, 2);
});

test("free credits refill once a day but never take away extra credits", () => {
  const db = setup();
  spendCredits(db, { ownerId: "u1", capability: "video.generate", now: T, env: env() }); // 5 left
  assert.equal(getCredits(db, { ownerId: "u1", now: T + 1000, env: env() }).balance, 5, "no refill on the same day");
  assert.equal(getCredits(db, { ownerId: "u1", now: T + DAY, env: env() }).balance, 20, "refilled to the daily amount");
  assert.equal(getCredits(db, { ownerId: "u1", now: T + DAY + 5, env: env() }).balance, 20, "only once per day");

  getCredits(db, { ownerId: "rich", email: "rich@example.com", now: T, env: env() });
  adminGrantCredits(db, { email: "rich@example.com", amount: 500, now: T });
  assert.equal(getCredits(db, { ownerId: "rich", now: T + DAY, env: env() }).balance, 520, "a top-up is never reduced to the daily amount");
});

test("an administrator adds credits by email, with clear refusals", () => {
  const db = setup();
  assert.throws(() => adminGrantCredits(db, { email: "ghost@example.com", amount: 10, now: T }), e => e.code === "CREDIT_ACCOUNT_NOT_FOUND" && e.status === 404);
  getCredits(db, { ownerId: "u9", email: "Ann@Example.com", now: T, env: env() });
  const result = adminGrantCredits(db, { email: " ann@example.com ", amount: 50, note: "launch bonus", now: T });
  assert.equal(result.balance, 70);
  assert.equal(result.granted, 50);
  assert.ok(!JSON.stringify(result).includes("ann@"), "no raw email is returned");
  for (const bad of [0, -3, 1.5, NaN, 1e9]) assert.throws(() => adminGrantCredits(db, { email: "ann@example.com", amount: bad, now: T }), e => e.code === "INVALID_CREDIT_AMOUNT");
  assert.equal(getCredits(db, { ownerId: "u9", now: T, env: env() }).recent[0].reason, "admin_grant");
});

test("refunds give credits back and cannot be abused", () => {
  const db = setup();
  spendCredits(db, { ownerId: "u1", capability: "image.generate", now: T, env: env() });
  assert.equal(refundCredits(db, { ownerId: "u1", amount: 3, now: T }).balance, 20);
  assert.deepEqual(refundCredits(db, { ownerId: "nobody", amount: 3, now: T }), { balance: 0, refunded: 0 });
  assert.throws(() => refundCredits(db, { ownerId: "u1", amount: -1 }), e => e.code === "INVALID_CREDIT_AMOUNT");
});

test("paid requests spend credits and a refused request does not use up a request slot", () => {
  const previous = process.env.CREDITS_ENABLED;
  process.env.CREDITS_ENABLED = "true";
  try {
    const db = new DatabaseSync(":memory:");
    ensureRemoteUsageTable(db); ensureCreditTables(db);
    const remote = { remote: true, provider: "test-provider" };
    const local = { remote: false, provider: "local" };

    assert.equal(reserveRemoteRequest(db, { ownerId: "u1", provider: local, capability: "video.generate", limit: 50 }).reserved, false);
    assert.equal(getCredits(db, { ownerId: "u1" }).balance, 20, "local providers are free");

    const ok = reserveRemoteRequest(db, { ownerId: "u1", provider: remote, capability: "video.generate", limit: 50 });
    assert.equal(ok.credits.charged, 15);
    assert.equal(ok.credits.balance, 5);

    assert.throws(() => reserveRemoteRequest(db, { ownerId: "u1", provider: remote, capability: "video.generate", limit: 50 }), e => e.code === "INSUFFICIENT_CREDITS");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM remote_usage_reservations WHERE owner_id='u1'").get().n, 1, "the refused request left no slot behind");
    assert.equal(getCredits(db, { ownerId: "u1" }).balance, 5);
  } finally {
    if (previous === undefined) delete process.env.CREDITS_ENABLED; else process.env.CREDITS_ENABLED = previous;
  }
});

test("with credits off, paid requests behave exactly as before", () => {
  const previous = process.env.CREDITS_ENABLED;
  delete process.env.CREDITS_ENABLED;
  try {
    const db = new DatabaseSync(":memory:");
    ensureRemoteUsageTable(db);
    const result = reserveRemoteRequest(db, { ownerId: "u1", provider: { remote: true, provider: "p" }, capability: "video.generate", limit: 5 });
    assert.equal(result.reserved, true);
    assert.equal(result.credits, null);
  } finally {
    if (previous !== undefined) process.env.CREDITS_ENABLED = previous;
  }
});
