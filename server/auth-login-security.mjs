import { createHash } from "node:crypto";

export const AUTH_LOCK_THRESHOLD = 3;
export const AUTH_BASE_LOCK_MS = 15 * 60 * 1000;
export const AUTH_MAX_LOCK_MS = 24 * 60 * 60 * 1000;

export function normalizeLoginIdentifier(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}

export function loginIdentifierHash(value) {
  return createHash("sha256").update(normalizeLoginIdentifier(value)).digest("hex");
}

export function ensureAuthSecuritySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_login_security (
      identifier_hash TEXT PRIMARY KEY,
      failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
      lock_level INTEGER NOT NULL DEFAULT 0 CHECK(lock_level >= 0),
      locked_until_ms INTEGER,
      window_started_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_login_security_lock_idx
      ON auth_login_security(locked_until_ms);
  `);
}

export function getLoginLockState(db, identifier, now = Date.now()) {
  const row = db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?")
    .get(loginIdentifierHash(identifier));
  if (!row || !row.locked_until_ms || row.locked_until_ms <= now) {
    return { locked: false, retryAfterMs: 0, failedAttempts: row?.failed_attempts || 0, lockLevel: row?.lock_level || 0 };
  }
  return { locked: true, retryAfterMs: row.locked_until_ms - now, failedAttempts: row.failed_attempts, lockLevel: row.lock_level };
}

export function recordFailedLogin(db, identifier, now = Date.now()) {
  const key = loginIdentifierHash(identifier);
  const current = db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(key);
  if (current?.locked_until_ms && current.locked_until_ms > now) {
    return { locked: true, retryAfterMs: current.locked_until_ms - now, failedAttempts: current.failed_attempts, lockLevel: current.lock_level };
  }
  const attempts = current?.locked_until_ms && current.locked_until_ms <= now ? 1 : (current?.failed_attempts || 0) + 1;
  let level = current?.lock_level || 0;
  let lockedUntil = null;
  if (attempts >= AUTH_LOCK_THRESHOLD) {
    level += 1;
    const duration = Math.min(AUTH_BASE_LOCK_MS * (2 ** (level - 1)), AUTH_MAX_LOCK_MS);
    lockedUntil = now + duration;
  }
  db.prepare(`INSERT INTO auth_login_security(identifier_hash,failed_attempts,lock_level,locked_until_ms,window_started_at_ms,updated_at_ms)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(identifier_hash) DO UPDATE SET failed_attempts=excluded.failed_attempts,
      lock_level=excluded.lock_level,locked_until_ms=excluded.locked_until_ms,
      window_started_at_ms=excluded.window_started_at_ms,updated_at_ms=excluded.updated_at_ms`)
    .run(key, attempts, level, lockedUntil, now, now);
  return { locked: !!lockedUntil, retryAfterMs: lockedUntil ? lockedUntil - now : 0, failedAttempts: attempts, lockLevel: level };
}

export function clearLoginFailures(db, identifier) {
  db.prepare("DELETE FROM auth_login_security WHERE identifier_hash=?").run(loginIdentifierHash(identifier));
}
