import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureAuthSecuritySchema, getLoginLockState, recordFailedLogin, clearLoginFailures,
  AUTH_BASE_LOCK_MS, AUTH_MAX_LOCK_MS, loginIdentifierHash
} from "../auth-login-security.mjs";

function setup() {
  const db = new DatabaseSync(":memory:");
  ensureAuthSecuritySchema(db);
  return db;
}

test("locks an identifier for 15 minutes after three consecutive failures", () => {
  const db = setup();
  const t = 1_800_000_000_000;
  assert.equal(recordFailedLogin(db, "User@example.com", t).locked, false);
  assert.equal(recordFailedLogin(db, "user@example.com", t + 1000).locked, false);
  const result = recordFailedLogin(db, "USER@example.com", t + 2000);
  assert.equal(result.locked, true);
  assert.equal(result.retryAfterMs, AUTH_BASE_LOCK_MS);
  assert.equal(getLoginLockState(db, "user@example.com", t + 3000).locked, true);
  db.close();
});

test("first failed attempt after a 15-minute lock expires immediately extends lock to 30 minutes", () => {
  const db = setup();
  const t = 1_800_000_000_000;
  recordFailedLogin(db, "user@example.com", t);
  recordFailedLogin(db, "user@example.com", t + 1);
  recordFailedLogin(db, "user@example.com", t + 2);
  const expiredAt = t + AUTH_BASE_LOCK_MS + 1;
  const result = recordFailedLogin(db, "user@example.com", expiredAt);
  assert.equal(result.locked, true);
  assert.equal(result.retryAfterMs, AUTH_BASE_LOCK_MS * 2);
  db.close();
});

test("progressive lock duration is capped at 24 hours", () => {
  const db = setup();
  let now = 1_800_000_000_000;
  recordFailedLogin(db, "user@example.com", now);
  recordFailedLogin(db, "user@example.com", now + 1);
  let result = recordFailedLogin(db, "user@example.com", now + 2);
  assert.equal(result.retryAfterMs, AUTH_BASE_LOCK_MS);
  for (let level = 2; level <= 12; level += 1) {
    now += result.retryAfterMs + 1;
    result = recordFailedLogin(db, "user@example.com", now);
    assert.equal(result.locked, true);
    assert.equal(result.retryAfterMs, Math.min(AUTH_BASE_LOCK_MS * (2 ** (level - 1)), AUTH_MAX_LOCK_MS));
  }
  assert.equal(result.retryAfterMs, AUTH_MAX_LOCK_MS);
  db.close();
});

test("successful authentication clears failure and lock history", () => {
  const db = setup();
  const t = 1_800_000_000_000;
  recordFailedLogin(db, "user@example.com", t);
  recordFailedLogin(db, "user@example.com", t + 1);
  recordFailedLogin(db, "user@example.com", t + 2);
  clearLoginFailures(db, "USER@example.com");
  assert.equal(getLoginLockState(db, "user@example.com", t + 3).locked, false);
  assert.equal(getLoginLockState(db, "user@example.com", t + 3).failedAttempts, 0);
  db.close();
});

test("stores only a one-way identifier digest and normalizes case/whitespace", () => {
  assert.equal(loginIdentifierHash(" User@Example.com "), loginIdentifierHash("user@example.com"));
  assert.match(loginIdentifierHash("user@example.com"), /^[a-f0-9]{64}$/);
  const db = setup();
  recordFailedLogin(db, "user@example.com", 1_800_000_000_000);
  const row = db.prepare("SELECT identifier_hash FROM auth_login_security").get();
  assert.notEqual(row.identifier_hash, "user@example.com");
  db.close();
});
