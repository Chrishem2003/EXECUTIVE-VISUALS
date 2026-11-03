import { createHash, createHmac } from "node:crypto";

export const AUTH_LOCK_THRESHOLD = 3;
export const AUTH_BASE_LOCK_MS = 15 * 60 * 1000;
export const AUTH_MAX_LOCK_MS = 24 * 60 * 60 * 1000;

export function normalizeLoginIdentifier(value) {
  return String(value || "").trim().toLowerCase().slice(0, 320);
}
export function loginIdentifierHash(value, secret = process.env.AUTH_IDENTIFIER_HMAC_KEY) {
  const normalized=normalizeLoginIdentifier(value);
  if(secret) {
    if(typeof secret!=="string"||Buffer.byteLength(secret)<32)throw new Error("AUTH_IDENTIFIER_HMAC_KEY must contain at least 32 bytes.");
    return createHmac("sha256",secret).update(normalized).digest("hex");
  }
  return createHash("sha256").update(normalized).digest("hex");
}
function legacyLoginIdentifierHash(value) {
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
    CREATE INDEX IF NOT EXISTS auth_login_security_lock_idx ON auth_login_security(locked_until_ms);
  `);
}
export function getLoginLockState(db, identifier, now = Date.now()) {
  const key=loginIdentifierHash(identifier);
  const legacyKey=process.env.AUTH_IDENTIFIER_HMAC_KEY?legacyLoginIdentifierHash(identifier):key;
  const row = db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(key)
    || (legacyKey!==key?db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(legacyKey):null);
  if (!row || !row.locked_until_ms || row.locked_until_ms <= now) return { locked:false,retryAfterMs:0,failedAttempts:row?.failed_attempts||0,lockLevel:row?.lock_level||0 };
  return { locked:true,retryAfterMs:row.locked_until_ms-now,failedAttempts:row.failed_attempts,lockLevel:row.lock_level };
}
export function recordFailedLogin(db, identifier, now = Date.now()) {
  const key=loginIdentifierHash(identifier);
  // Serialize the read/modify/write sequence across concurrent requests and
  // SQLite connections. Without an immediate write lock, parallel failures
  // can both observe the same counter and lose an increment.
  db.exec("BEGIN IMMEDIATE");
  try {
    let current=db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(key);
    if(!current&&process.env.AUTH_IDENTIFIER_HMAC_KEY) {
      const legacyKey=legacyLoginIdentifierHash(identifier);
      current=db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(legacyKey);
      if(current)db.prepare("UPDATE auth_login_security SET identifier_hash=? WHERE identifier_hash=?").run(key,legacyKey);
    }
    if(current?.locked_until_ms&&current.locked_until_ms>now) {
      db.exec("COMMIT");
      return {locked:true,retryAfterMs:current.locked_until_ms-now,failedAttempts:current.failed_attempts,lockLevel:current.lock_level};
    }
    const attempts=current?.locked_until_ms&&current.locked_until_ms<=now?AUTH_LOCK_THRESHOLD:(current?.failed_attempts||0)+1;
    const level=current?.lock_level||0;
    const nextLevel=attempts>=AUTH_LOCK_THRESHOLD?level+1:level;
    const lockedUntil=attempts>=AUTH_LOCK_THRESHOLD?now+Math.min(AUTH_BASE_LOCK_MS*(2**(nextLevel-1)),AUTH_MAX_LOCK_MS):null;
    db.prepare(`INSERT INTO auth_login_security(identifier_hash,failed_attempts,lock_level,locked_until_ms,window_started_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?) ON CONFLICT(identifier_hash) DO UPDATE SET failed_attempts=excluded.failed_attempts,
      lock_level=excluded.lock_level,locked_until_ms=excluded.locked_until_ms,window_started_at_ms=excluded.window_started_at_ms,updated_at_ms=excluded.updated_at_ms`)
      .run(key,attempts,nextLevel,lockedUntil,now,now);
    db.exec("COMMIT");
    return {locked:!!lockedUntil,retryAfterMs:lockedUntil?lockedUntil-now:0,failedAttempts:attempts,lockLevel:nextLevel};
  } catch(error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
export function clearLoginFailures(db, identifier) {
  const key=loginIdentifierHash(identifier);
  db.prepare("DELETE FROM auth_login_security WHERE identifier_hash=?").run(key);
  if(process.env.AUTH_IDENTIFIER_HMAC_KEY)db.prepare("DELETE FROM auth_login_security WHERE identifier_hash=?").run(legacyLoginIdentifierHash(identifier));
}
