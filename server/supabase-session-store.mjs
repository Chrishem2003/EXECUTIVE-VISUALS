import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

function keyBytes(value) {
  const input = String(value || "").trim();
  const key = /^[a-f0-9]{64}$/i.test(input) ? Buffer.from(input, "hex") : Buffer.from(input, "base64url");
  if (key.length !== 32) throw new Error("SUPABASE_SESSION_ENCRYPTION_KEY must encode exactly 32 random bytes (64 hex characters or base64url).");
  return key;
}
function digest(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function seal(value, key, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function unseal(value, key, aad) {
  const [ivPart, tagPart, dataPart] = String(value || "").split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("Encrypted Supabase session material is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

export function createSupabaseSessionStore({ db, encryptionKey, now = () => Date.now(), ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite-compatible session database is required.");
  const key = keyBytes(encryptionKey);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > SESSION_TTL_SECONDS) throw new TypeError("Supabase session lifetime is invalid.");
  db.exec("CREATE TABLE IF NOT EXISTS supabase_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,access_token_ciphertext TEXT NOT NULL,refresh_token_ciphertext TEXT NOT NULL,access_expires_at TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS supabase_sessions_user_idx ON supabase_sessions(user_id); CREATE INDEX IF NOT EXISTS supabase_sessions_expiry_idx ON supabase_sessions(expires_at);");
  const insert = db.prepare("INSERT INTO supabase_sessions(token_hash,user_id,access_token_ciphertext,refresh_token_ciphertext,access_expires_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
  const update = db.prepare("UPDATE supabase_sessions SET access_token_ciphertext=?,refresh_token_ciphertext=?,access_expires_at=?,updated_at=? WHERE token_hash=? AND expires_at>?");
  const select = db.prepare("SELECT * FROM supabase_sessions WHERE token_hash=?");
  const remove = db.prepare("DELETE FROM supabase_sessions WHERE token_hash=?");
  return Object.freeze({
    create({ userId, accessToken, refreshToken, expiresIn = 3600 }) {
      if (typeof userId !== "string" || !userId || typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) throw new TypeError("A complete Supabase identity session is required.");
      const token = randomBytes(32).toString("base64url"), tokenHash = digest(token);
      const timestamp = now(), createdAt = new Date(timestamp).toISOString();
      insert.run(tokenHash, userId, seal(accessToken, key, tokenHash + ":" + userId + ":access"), seal(refreshToken, key, tokenHash + ":" + userId + ":refresh"), new Date(timestamp + Math.max(60, Number(expiresIn) || 3600) * 1000).toISOString(), new Date(timestamp + ttlSeconds * 1000).toISOString(), createdAt, createdAt);
      return { token, expiresIn: ttlSeconds };
    },
    get(token) {
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
      const tokenHash = digest(token), row = select.get(tokenHash);
      if (!row) return null;
      if (Date.parse(row.expires_at) <= now()) { remove.run(tokenHash); return null; }
      try { return { userId: row.user_id, accessToken: unseal(row.access_token_ciphertext, key, row.token_hash + ":" + row.user_id + ":access"), refreshToken: unseal(row.refresh_token_ciphertext, key, row.token_hash + ":" + row.user_id + ":refresh"), accessExpiresAt: row.access_expires_at, expiresAt: row.expires_at }; }
      catch { remove.run(tokenHash); return null; }
    },
    rotate(token, { accessToken, refreshToken, expiresIn = 3600 }) {
      if (typeof token !== "string" || !TOKEN_PATTERN.test(token) || typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken) return false;
      const timestamp = now(), iso = new Date(timestamp).toISOString(), tokenHash = digest(token);
      const row = select.get(tokenHash);
      if (!row || Date.parse(row.expires_at) <= timestamp) return false;
      const result = update.run(seal(accessToken, key, tokenHash + ":" + row.user_id + ":access"), seal(refreshToken, key, tokenHash + ":" + row.user_id + ":refresh"), new Date(timestamp + Math.max(60, Number(expiresIn) || 3600) * 1000).toISOString(), iso, tokenHash, iso);
      return result.changes === 1;
    },
    delete(token) { if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false; return remove.run(digest(token)).changes === 1; },
    cleanup() { return db.prepare("DELETE FROM supabase_sessions WHERE expires_at<=?").run(new Date(now()).toISOString()).changes; }
  });
}

export function assertSameOriginMutation({ origin, expectedOrigin, secFetchSite } = {}) {
  let supplied, expected;
  try { supplied = new URL(String(origin || "")).origin; expected = new URL(String(expectedOrigin || "")).origin; }
  catch { throw Object.assign(new Error("A same-origin request is required for this action."), { code: "CSRF_ORIGIN_REQUIRED", status: 403 }); }
  if (supplied !== expected || secFetchSite && !["same-origin", "none"].includes(String(secFetchSite).toLowerCase())) throw Object.assign(new Error("Cross-origin state changes are not allowed."), { code: "CSRF_ORIGIN_DENIED", status: 403 });
  return true;
}