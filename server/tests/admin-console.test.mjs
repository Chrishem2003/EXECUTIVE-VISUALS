import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { adminEmails, isAdminUser } from "../admin-access.mjs";
import {
  ensureAuthSecuritySchema, recordFailedLogin, getLoginLockState, countActiveLocks, adminUnlockLogin, listAdminAudit
} from "../auth-login-security.mjs";

const setup = () => { const db = new DatabaseSync(":memory:"); ensureAuthSecuritySchema(db); return db; };

test("nobody is an administrator until their email is listed", () => {
  assert.equal(isAdminUser({ email: "boss@example.com" }, {}), false);
  assert.equal(isAdminUser(null, { ADMIN_EMAILS: "boss@example.com" }), false);
  assert.equal(isAdminUser({ email: "" }, { ADMIN_EMAILS: "" }), false);
  assert.equal(isAdminUser({ email: "boss@example.com" }, { ADMIN_EMAILS: "boss@example.com" }), true);
});

test("matching ignores case and spaces, and accepts several addresses and the older setting", () => {
  const env = { ADMIN_EMAILS: " Boss@Example.com , second@example.com ", AUTH_SECURITY_ADMIN_EMAILS: "legacy@example.com" };
  assert.deepEqual([...adminEmails(env)].sort(), ["boss@example.com", "legacy@example.com", "second@example.com"]);
  assert.equal(isAdminUser({ email: "BOSS@example.com" }, env), true);
  assert.equal(isAdminUser({ email: "legacy@example.com" }, env), true);
  assert.equal(isAdminUser({ email: "boss@example.com.evil.test" }, env), false);
  assert.equal(isAdminUser({ email: "other@example.com" }, env), false);
});

test("an administrator can unlock a locked account, and the action is audited without raw emails", () => {
  const db = setup(), t = 1_800_000_000_000;
  for (let i = 0; i < 3; i++) recordFailedLogin(db, "Victim@Example.com", t + i);
  assert.equal(getLoginLockState(db, "victim@example.com", t + 10).locked, true);
  assert.equal(countActiveLocks(db, t + 10), 1);

  const result = adminUnlockLogin(db, "victim@example.com", "boss@example.com", t + 20);
  assert.deepEqual(result, { wasLocked: true, cleared: true });
  assert.equal(getLoginLockState(db, "victim@example.com", t + 30).locked, false);
  assert.equal(countActiveLocks(db, t + 30), 0);

  const audit = listAdminAudit(db);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "unlock_account");
  assert.equal(audit[0].detail, "was_locked");
  assert.ok(!JSON.stringify(audit).includes("victim") && !JSON.stringify(audit).includes("boss"), "no raw emails in the audit log");
  db.close();
});

test("after an unlock the next wrong password starts fresh instead of escalating", () => {
  const db = setup(), t = 1_800_000_000_000;
  for (let i = 0; i < 3; i++) recordFailedLogin(db, "a@example.com", t + i);
  adminUnlockLogin(db, "a@example.com", "boss@example.com", t + 10);
  const next = recordFailedLogin(db, "a@example.com", t + 20);
  assert.equal(next.locked, false);
  assert.equal(next.failedAttempts, 1);
  db.close();
});

test("unlocking an account with nothing to clear is harmless and still audited", () => {
  const db = setup();
  assert.deepEqual(adminUnlockLogin(db, "nobody@example.com", "boss@example.com"), { wasLocked: false, cleared: false });
  assert.equal(listAdminAudit(db)[0].detail, "nothing_to_clear");
  assert.throws(() => adminUnlockLogin(db, "   ", "boss@example.com"), e => e.code === "INVALID_UNLOCK_TARGET");
  db.close();
});
