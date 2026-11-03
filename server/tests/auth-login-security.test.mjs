import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("three consecutive failures lock the normalized identifier for 15 minutes", () => {
  const db=setup(),t=1_800_000_000_000;
  recordFailedLogin(db,"User@example.com",t);
  recordFailedLogin(db,"user@example.com",t+1000);
  const result=recordFailedLogin(db,"USER@example.com",t+2000);
  assert.equal(result.locked,true);
  assert.equal(result.retryAfterMs,AUTH_BASE_LOCK_MS);
  assert.equal(getLoginLockState(db,"user@example.com",t+3000).locked,true);
  db.close();
});

test("a wrong attempt immediately after expiry escalates the lock to 30 minutes", () => {
  const db=setup(),t=1_800_000_000_000;
  recordFailedLogin(db,"user@example.com",t);
  recordFailedLogin(db,"user@example.com",t+1);
  recordFailedLogin(db,"user@example.com",t+2);
  const result=recordFailedLogin(db,"user@example.com",t+AUTH_BASE_LOCK_MS+3);
  assert.equal(result.locked,true);
  assert.equal(result.retryAfterMs,2*AUTH_BASE_LOCK_MS);
  db.close();
});

test("progressive lockout doubles up to a 24-hour maximum", () => {
  const db=setup();let now=1_800_000_000_000;
  recordFailedLogin(db,"user@example.com",now);
  recordFailedLogin(db,"user@example.com",now+1);
  let result=recordFailedLogin(db,"user@example.com",now+2);
  assert.equal(result.retryAfterMs,AUTH_BASE_LOCK_MS);
  // The first lock was created at now+2, not at the baseline timestamp.
  now+=result.retryAfterMs+3;
  result=recordFailedLogin(db,"user@example.com",now);
  assert.equal(result.retryAfterMs,2*AUTH_BASE_LOCK_MS);
  for(let level=3;level<=12;level++){
    now+=result.retryAfterMs+1;
    result=recordFailedLogin(db,"user@example.com",now);
    assert.equal(result.retryAfterMs,Math.min(AUTH_BASE_LOCK_MS*(2**(level-1)),AUTH_MAX_LOCK_MS));
  }
  assert.equal(result.retryAfterMs,AUTH_MAX_LOCK_MS);
  db.close();
});

test("successful login clears the lockout history", () => {
  const db=setup(),t=1_800_000_000_000;
  recordFailedLogin(db,"user@example.com",t);
  recordFailedLogin(db,"user@example.com",t+1);
  recordFailedLogin(db,"user@example.com",t+2);
  clearLoginFailures(db,"USER@example.com");
  assert.equal(getLoginLockState(db,"user@example.com",t+3).locked,false);
  assert.equal(getLoginLockState(db,"user@example.com",t+3).failedAttempts,0);
  db.close();
});

test("lockout persistence stores a one-way normalized identifier digest", () => {
  const db=setup();
  assert.equal(loginIdentifierHash(" User@Example.com "),loginIdentifierHash("user@example.com"));
  recordFailedLogin(db,"user@example.com",1_800_000_000_000);
  const row=db.prepare("SELECT identifier_hash FROM auth_login_security").get();
  assert.match(row.identifier_hash,/^[a-f0-9]{64}$/);
  assert.notEqual(row.identifier_hash,"user@example.com");
  db.close();
});

test("lockout updates commit atomically and release the write lock on active-lock checks", () => {
  const db=setup(),t=1_800_000_000_000;
  recordFailedLogin(db,"atomic@example.com",t);
  recordFailedLogin(db,"atomic@example.com",t+1);
  const locked=recordFailedLogin(db,"atomic@example.com",t+2);
  assert.equal(locked.locked,true);
  const repeated=recordFailedLogin(db,"atomic@example.com",t+3);
  assert.equal(repeated.locked,true);
  assert.equal(repeated.failedAttempts,3);
  // A new immediate transaction proves every return path released its lock.
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
  db.close();
});

test("HMAC identifier mode migrates legacy SHA-256 lockout rows without resetting failures", () => {
  const db=setup(),t=1_800_000_000_000,previous=process.env.AUTH_IDENTIFIER_HMAC_KEY;
  process.env.AUTH_IDENTIFIER_HMAC_KEY="test-only-secret-key-with-at-least-32-bytes";
  try {
    const legacy=createHash("sha256").update("hmac@example.com").digest("hex");
    // Seed the pre-HMAC row using the legacy digest.
    db.prepare("INSERT INTO auth_login_security(identifier_hash,failed_attempts,lock_level,locked_until_ms,window_started_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)")
      .run(legacy,2,0,null,t,t);
    const hmac=loginIdentifierHash("hmac@example.com");
    assert.notEqual(hmac,legacy);
    const result=recordFailedLogin(db,"hmac@example.com",t+1);
    assert.equal(result.locked,true);
    assert.equal(result.failedAttempts,3);
    const rows=db.prepare("SELECT identifier_hash FROM auth_login_security").all();
    assert.deepEqual(rows,[{identifier_hash:hmac}]);
    clearLoginFailures(db,"hmac@example.com");
    assert.equal(getLoginLockState(db,"hmac@example.com",t+2).failedAttempts,0);
  } finally {
    if(previous===undefined)delete process.env.AUTH_IDENTIFIER_HMAC_KEY;
    else process.env.AUTH_IDENTIFIER_HMAC_KEY=previous;
    db.close();
  }
});

test("HMAC identifier keys reject short secrets", () => {
  assert.throws(()=>loginIdentifierHash("user@example.com","short"),/at least 32 bytes/);
});
