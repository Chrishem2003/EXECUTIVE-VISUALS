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
    CREATE TABLE IF NOT EXISTS auth_security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier_hash TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('login_failed','account_locked','login_blocked_by_lockout','login_succeeded')),
      failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
      lock_level INTEGER NOT NULL DEFAULT 0 CHECK(lock_level >= 0),
      locked_until_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_security_events_created_idx ON auth_security_events(created_at_ms DESC);
    CREATE INDEX IF NOT EXISTS auth_security_events_identifier_idx ON auth_security_events(identifier_hash,created_at_ms DESC);
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_hash TEXT NOT NULL,
      action TEXT NOT NULL,
      target_hash TEXT,
      detail TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log(created_at_ms DESC);
  `);
}

/** Number of accounts that are locked right now (no identities, just a count). */
export function countActiveLocks(db, now = Date.now()) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM auth_login_security WHERE locked_until_ms IS NOT NULL AND locked_until_ms>?").get(now).n) || 0;
}

/**
 * An administrator clears the lock and failure history for one sign-in address.
 * The action is written to the audit log using hashes only (no raw emails).
 */
export function adminUnlockLogin(db, identifier, actorIdentifier, now = Date.now()) {
  if (!normalizeLoginIdentifier(identifier)) throw Object.assign(new Error("An email address is required."), { code: "INVALID_UNLOCK_TARGET" });
  const key = loginIdentifierHash(identifier);
  db.exec("BEGIN IMMEDIATE");
  try {
    const hashes = new Set([key]);
    if (process.env.AUTH_IDENTIFIER_HMAC_KEY) hashes.add(legacyLoginIdentifierHash(identifier));
    let changes = 0;
    let wasLocked = false;
    for (const hash of hashes) {
      const row = db.prepare("SELECT locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(hash);
      if (row?.locked_until_ms && row.locked_until_ms > now) wasLocked = true;
      changes += Number(db.prepare("DELETE FROM auth_login_security WHERE identifier_hash=?").run(hash).changes) || 0;
    }
    db.prepare("INSERT INTO admin_audit_log(actor_hash,action,target_hash,detail,created_at_ms) VALUES(?,?,?,?,?)")
      .run(loginIdentifierHash(actorIdentifier), "unlock_account", key, wasLocked ? "was_locked" : changes ? "cleared_failures" : "nothing_to_clear", now);
    db.prepare("DELETE FROM admin_audit_log WHERE created_at_ms < ?").run(now - 365 * 24 * 60 * 60 * 1000);
    db.exec("COMMIT");
    return { wasLocked, cleared: changes > 0 };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/** Newest-first admin actions (hashes only). */
export function listAdminAudit(db, limit = 20) {
  const safe = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 20)));
  return db.prepare("SELECT id,action,target_hash AS targetHash,detail,created_at_ms AS createdAtMs FROM admin_audit_log ORDER BY id DESC LIMIT ?").all(safe)
    .map(row => ({ id: Number(row.id), action: row.action, targetHash: row.targetHash, detail: row.detail, createdAtMs: Number(row.createdAtMs) }));
}
function writeAuthSecurityEvent(db, identifier, eventType, state = {}, now = Date.now()) {
  const identifierHash=loginIdentifierHash(identifier);
  db.prepare("INSERT INTO auth_security_events(identifier_hash,event_type,failed_attempts,lock_level,locked_until_ms,created_at_ms) VALUES(?,?,?,?,?,?)")
    .run(identifierHash,eventType,Math.max(0,Number(state.failedAttempts)||0),Math.max(0,Number(state.lockLevel)||0),state.lockedUntilMs||null,now);
  db.prepare("DELETE FROM auth_security_events WHERE created_at_ms < ?").run(now-90*24*60*60*1000);
  db.prepare("DELETE FROM auth_security_events WHERE id NOT IN (SELECT id FROM auth_security_events ORDER BY id DESC LIMIT 50000)").run();
}
export function recordLoginLockoutEvent(db, identifier, state, now = Date.now()) {
  writeAuthSecurityEvent(db,identifier,"login_blocked_by_lockout",state,now);
}
export function getLoginLockState(db, identifier, now = Date.now()) {
  const key=loginIdentifierHash(identifier);
  const legacyKey=process.env.AUTH_IDENTIFIER_HMAC_KEY?legacyLoginIdentifierHash(identifier):key;
  const row = db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(key)
    || (legacyKey!==key?db.prepare("SELECT failed_attempts,lock_level,locked_until_ms FROM auth_login_security WHERE identifier_hash=?").get(legacyKey):null);
  if (!row || !row.locked_until_ms || row.locked_until_ms <= now) return { locked:false,retryAfterMs:0,failedAttempts:row?.failed_attempts||0,lockLevel:row?.lock_level||0,lockedUntilMs:null };
  return { locked:true,retryAfterMs:row.locked_until_ms-now,failedAttempts:row.failed_attempts,lockLevel:row.lock_level,lockedUntilMs:row.locked_until_ms };
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
      writeAuthSecurityEvent(db,identifier,"login_blocked_by_lockout",{failedAttempts:current.failed_attempts,lockLevel:current.lock_level,lockedUntilMs:current.locked_until_ms},now);
      db.exec("COMMIT");
      return {locked:true,retryAfterMs:current.locked_until_ms-now,failedAttempts:current.failed_attempts,lockLevel:current.lock_level,lockedUntilMs:current.locked_until_ms};
    }
    const attempts=current?.locked_until_ms&&current.locked_until_ms<=now?AUTH_LOCK_THRESHOLD:(current?.failed_attempts||0)+1;
    const level=current?.lock_level||0;
    const nextLevel=attempts>=AUTH_LOCK_THRESHOLD?level+1:level;
    const lockedUntil=attempts>=AUTH_LOCK_THRESHOLD?now+Math.min(AUTH_BASE_LOCK_MS*(2**(nextLevel-1)),AUTH_MAX_LOCK_MS):null;
    db.prepare(`INSERT INTO auth_login_security(identifier_hash,failed_attempts,lock_level,locked_until_ms,window_started_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?) ON CONFLICT(identifier_hash) DO UPDATE SET failed_attempts=excluded.failed_attempts,
      lock_level=excluded.lock_level,locked_until_ms=excluded.locked_until_ms,window_started_at_ms=excluded.window_started_at_ms,updated_at_ms=excluded.updated_at_ms`)
      .run(key,attempts,nextLevel,lockedUntil,now,now);
    writeAuthSecurityEvent(db,identifier,lockedUntil?"account_locked":"login_failed",{failedAttempts:attempts,lockLevel:nextLevel,lockedUntilMs:lockedUntil},now);
    db.exec("COMMIT");
    return {locked:!!lockedUntil,retryAfterMs:lockedUntil?lockedUntil-now:0,failedAttempts:attempts,lockLevel:nextLevel};
  } catch(error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
export function clearLoginFailures(db, identifier) {
  const key=loginIdentifierHash(identifier);
  db.exec("BEGIN IMMEDIATE");
  try {
    writeAuthSecurityEvent(db,identifier,"login_succeeded",{},Date.now());
    db.prepare("DELETE FROM auth_login_security WHERE identifier_hash=?").run(key);
    if(process.env.AUTH_IDENTIFIER_HMAC_KEY)db.prepare("DELETE FROM auth_login_security WHERE identifier_hash=?").run(legacyLoginIdentifierHash(identifier));
    db.exec("COMMIT");
  } catch(error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function listAuthSecurityEvents(db, { limit = 50, beforeId = null, eventType = null } = {}) {
  const safeLimit=Math.max(1,Math.min(100,Math.trunc(Number(limit)||50)));
  const validTypes=new Set(["login_failed","account_locked","login_blocked_by_lockout","login_succeeded"]);
  if(eventType&&!validTypes.has(eventType))throw new Error("Unsupported authentication security event type.");
  const cursor=beforeId===null||beforeId===""?null:Number(beforeId);
  if(cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<1))throw new Error("Invalid authentication security event cursor.");
  const where=[],params=[];
  if(cursor!==null){where.push("id < ?");params.push(cursor);}
  if(eventType){where.push("event_type = ?");params.push(eventType);}
  const rows=db.prepare(`SELECT id,identifier_hash,event_type,failed_attempts,lock_level,locked_until_ms,created_at_ms
    FROM auth_security_events ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY id DESC LIMIT ?`).all(...params,safeLimit);
  return rows.map(row=>({id:row.id,identifierHash:row.identifier_hash,eventType:row.event_type,failedAttempts:row.failed_attempts,lockLevel:row.lock_level,lockedUntilMs:row.locked_until_ms,createdAtMs:row.created_at_ms}));
}

export function getAuthSecuritySummary(db, now = Date.now()) {
  const dayAgo=now-24*60*60*1000;
  const recentAgo=now-15*60*1000;
  const totals=db.prepare(`SELECT
    COUNT(*) AS totalEvents,
    SUM(CASE WHEN event_type IN ('login_failed','account_locked','login_blocked_by_lockout') THEN 1 ELSE 0 END) AS failedSignIns,
    SUM(CASE WHEN event_type='account_locked' THEN 1 ELSE 0 END) AS newLockouts,
    SUM(CASE WHEN event_type='login_blocked_by_lockout' THEN 1 ELSE 0 END) AS blockedByLockout,
    SUM(CASE WHEN event_type='login_succeeded' THEN 1 ELSE 0 END) AS successfulSignIns
    FROM auth_security_events WHERE created_at_ms>=?`).get(dayAgo);
  const suspicious=db.prepare(`SELECT identifier_hash,
    SUM(CASE WHEN created_at_ms>=? AND event_type IN ('login_failed','account_locked','login_blocked_by_lockout') THEN 1 ELSE 0 END) AS attempts15m,
    SUM(CASE WHEN event_type IN ('account_locked','login_blocked_by_lockout') THEN 1 ELSE 0 END) AS lockoutEvents24h,
    MAX(created_at_ms) AS lastEventAtMs
    FROM auth_security_events WHERE created_at_ms>=?
    GROUP BY identifier_hash
    HAVING attempts15m>=5 OR lockoutEvents24h>=3
    ORDER BY attempts15m DESC,lockoutEvents24h DESC,lastEventAtMs DESC LIMIT 10`).all(recentAgo,dayAgo);
  return {
    window:"rolling_24_hours",
    totals:{
      totalEvents:Number(totals.totalEvents)||0,
      failedSignIns:Number(totals.failedSignIns)||0,
      newLockouts:Number(totals.newLockouts)||0,
      blockedByLockout:Number(totals.blockedByLockout)||0,
      successfulSignIns:Number(totals.successfulSignIns)||0
    },
    suspiciousIdentifiers:suspicious.map(row=>({
      identifierHash:row.identifier_hash,
      attempts15m:Number(row.attempts15m)||0,
      lockoutEvents24h:Number(row.lockoutEvents24h)||0,
      lastEventAtMs:Number(row.lastEventAtMs)||0
    })),
    detectionPolicy:{attemptThreshold:5,attemptWindowMinutes:15,lockoutThreshold:3,lockoutWindowHours:24},
    generatedAtMs:now
  };
}
