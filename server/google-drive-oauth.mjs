import { createCipheriv, createDecipheriv, createHash, randomBytes, createPublicKey, verify as verifySignature } from "node:crypto";

const AUTH_ORIGIN = "https://accounts.google.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const OPENID_SCOPE = "openid";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const REQUIRED_SCOPES = [DRIVE_SCOPE, OPENID_SCOPE, EMAIL_SCOPE];
const MAX_RESPONSE_BYTES = 1024 * 1024;
const fail = (message, code) => Object.assign(new Error(message), { code });
const b64url = value => Buffer.from(value).toString("base64url");

function safeRedirectUri(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw fail("Google OAuth redirect URI is invalid.", "GOOGLE_OAUTH_CONFIG_INVALID"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.hash || url.search) {
    throw fail("Google OAuth redirect URI must be HTTPS (HTTP is allowed only for loopback development).", "GOOGLE_OAUTH_CONFIG_INVALID");
  }
  return url.toString();
}
function validOwner(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw fail("Google OAuth requires an authenticated application user.", "GOOGLE_OAUTH_OWNER_INVALID");
  }
  return value;
}
function decodeJwtPart(value) {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw fail("Google returned an invalid identity token.", "GOOGLE_OAUTH_ID_TOKEN_INVALID"); }
}
async function verifyGoogleIdToken(idToken, { clientId, nonce, now = Date.now(), fetchImpl }) {
  if (typeof idToken !== "string" || idToken.length > 12000) throw fail("Google did not return a valid identity token.", "GOOGLE_OAUTH_ID_TOKEN_INVALID");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw fail("Google returned an invalid identity token.", "GOOGLE_OAUTH_ID_TOKEN_INVALID");
  const header = decodeJwtPart(parts[0]), payload = decodeJwtPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" ||
      (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") ||
      payload.aud !== clientId || payload.nonce !== nonce ||
      !Number.isFinite(payload.exp) || payload.exp * 1000 <= now ||
      !Number.isFinite(payload.iat) || payload.iat * 1000 > now + 60000 ||
      typeof payload.sub !== "string" || payload.sub.length < 5 || payload.sub.length > 255 ||
      typeof payload.email !== "string" || payload.email.length > 320 || payload.email_verified !== true) {
    throw fail("Google identity token claims failed validation.", "GOOGLE_OAUTH_ID_TOKEN_INVALID");
  }
  if (typeof fetchImpl !== "function") throw fail("Google identity verification transport is unavailable.", "GOOGLE_OAUTH_UNAVAILABLE");
  let response;
  try { response = await fetchImpl("https://www.googleapis.com/oauth2/v3/certs", { redirect: "error" }); }
  catch { throw fail("Google identity signing keys could not be retrieved.", "GOOGLE_OAUTH_IDENTITY_UNAVAILABLE"); }
  if (!response.ok) throw fail("Google identity signing keys could not be retrieved.", "GOOGLE_OAUTH_IDENTITY_UNAVAILABLE");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw fail("Google identity key response is oversized.", "GOOGLE_OAUTH_RESPONSE_INVALID");
  let jwks;
  try { jwks = JSON.parse(raw); } catch { throw fail("Google identity signing keys are invalid.", "GOOGLE_OAUTH_RESPONSE_INVALID"); }
  const jwk = Array.isArray(jwks.keys) ? jwks.keys.find(item => item.kid === header.kid && item.kty === "RSA" && item.use === "sig" && item.alg === "RS256") : null;
  if (!jwk) throw fail("Google identity signing key was not found.", "GOOGLE_OAUTH_ID_TOKEN_INVALID");
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    valid = verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, Buffer.from(parts[2], "base64url"));
  } catch { valid = false; }
  if (!valid) throw fail("Google identity token signature is invalid.", "GOOGLE_OAUTH_ID_TOKEN_INVALID");
  return { subject: payload.sub, email: payload.email.toLowerCase() };
}

/**
 * Server-side Google Drive OAuth coordinator.
 * stateStore must provide one-time put/consume operations with TTL.
 * connections must persist only the encrypted refresh-token envelope.
 * verifyIdentity must cryptographically verify Google's OIDC ID token.
 */
export function createGoogleDriveOAuth({
  clientId = process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI,
  encryptionKey = process.env.GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY,
  stateStore,
  connections,
  fetchImpl = globalThis.fetch,
  verifyIdentity,
  timeoutMs = 10000,
  now = Date.now
} = {}) {
  const id = String(clientId || "").trim(), secret = String(clientSecret || "");
  const callback = safeRedirectUri(redirectUri);
  if (!id || id.length > 512 || !secret || secret.length > 2048) throw fail("Configure Google OAuth client credentials.", "GOOGLE_OAUTH_CONFIG_INVALID");
  if (typeof encryptionKey !== "string" || encryptionKey.length < 32 || encryptionKey.length > 4096) {
    throw fail("GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY must contain at least 32 characters.", "GOOGLE_OAUTH_CONFIG_INVALID");
  }
  if (!stateStore || typeof stateStore.put !== "function" || typeof stateStore.consume !== "function" ||
      !connections || typeof connections.get !== "function" || typeof connections.upsert !== "function" || typeof connections.delete !== "function") {
    throw fail("Google OAuth requires one-time state storage and a private connection repository.", "GOOGLE_OAUTH_CONFIG_INVALID");
  }
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw fail("Google OAuth transport configuration is invalid.", "GOOGLE_OAUTH_CONFIG_INVALID");
  }
  const identityVerifier = verifyIdentity || ((token, options) => verifyGoogleIdToken(token, { ...options, fetchImpl }));
  const key = createHash("sha256").update(encryptionKey, "utf8").digest();
  const accessCache = new Map();
  const refreshInFlight = new Map();

  function encryptRefreshToken(token) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return "gdrive:v1:" + [b64url(iv), b64url(cipher.getAuthTag()), b64url(encrypted)].join(".");
  }
  function decryptRefreshToken(envelope) {
    if (typeof envelope !== "string" || envelope.length > 12000) throw fail("Stored Google connection is invalid.", "GOOGLE_OAUTH_STORED_TOKEN_INVALID");
    const parts = envelope.split(":");
    if (parts.length !== 3 || parts[0] !== "gdrive" || parts[1] !== "v1") throw fail("Stored Google connection has an unsupported encryption envelope.", "GOOGLE_OAUTH_STORED_TOKEN_INVALID");
    try {
      const fields = parts[2].split(".");
      if (fields.length !== 3) throw new Error("invalid envelope");
      const iv = Buffer.from(fields[0], "base64url"), tag = Buffer.from(fields[1], "base64url"), data = Buffer.from(fields[2], "base64url");
      if (iv.length !== 12 || tag.length !== 16 || data.length < 1 || data.length > 8192) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch { throw fail("Stored Google connection could not be decrypted.", "GOOGLE_OAUTH_STORED_TOKEN_INVALID"); }
  }

  async function request(url, options) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try { response = await fetchImpl(url, { ...options, redirect: "error", signal: controller.signal }); }
      catch (error) { throw fail(error?.name === "AbortError" ? "Google OAuth request timed out." : "Google OAuth service is temporarily unavailable.",
        error?.name === "AbortError" ? "GOOGLE_OAUTH_TIMEOUT" : "GOOGLE_OAUTH_UNAVAILABLE"); }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw fail("Google OAuth response exceeded its size limit.", "GOOGLE_OAUTH_RESPONSE_INVALID");
      let data = {};
      if (raw) { try { data = JSON.parse(raw); } catch { throw fail("Google OAuth returned invalid JSON.", "GOOGLE_OAUTH_RESPONSE_INVALID"); } }
      return { ok: response.ok, status: response.status, data };
    } finally { clearTimeout(timer); }
  }
  async function exchange(form) {
    const result = await request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString()
    });
    if (!result.ok) throw fail("Google authorization could not be completed. Reconnect your Google account.",
      result.status === 400 || result.status === 401 ? "GOOGLE_OAUTH_CODE_REJECTED" : "GOOGLE_OAUTH_UNAVAILABLE");
    return result.data;
  }
  function validateTokenResponse(data) {
    if (!data || typeof data.access_token !== "string" || data.access_token.length < 20 ||
        typeof data.id_token !== "string" || !data.id_token ||
        !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) < 1 ||
        typeof data.scope !== "string") throw fail("Google returned an incomplete OAuth token response.", "GOOGLE_OAUTH_RESPONSE_INVALID");
    const scopes = [...new Set(data.scope.split(/\s+/).filter(Boolean))].sort();
    if (!REQUIRED_SCOPES.every(scope => scopes.includes(scope))) throw fail("Google did not grant all required narrow Drive permissions.", "GOOGLE_OAUTH_SCOPE_MISSING");
    return { accessToken: data.access_token, idToken: data.id_token, expiresAt: now() + Math.min(Number(data.expires_in), 3600) * 1000, scopes };
  }

  return Object.freeze({
    async begin({ ownerId } = {}) {
      ownerId = validOwner(ownerId);
      const state = b64url(randomBytes(32)), verifier = b64url(randomBytes(48)), nonce = b64url(randomBytes(32));
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      await stateStore.put(state, { ownerId, verifier, nonce, expiresAt: now() + 10 * 60 * 1000 });
      const url = new URL(AUTH_ORIGIN + "/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: id, redirect_uri: callback, response_type: "code",
        scope: REQUIRED_SCOPES.join(" "), access_type: "offline", prompt: "consent",
        include_granted_scopes: "true", state, nonce, code_challenge: challenge, code_challenge_method: "S256"
      }).toString();
      return { authorizationUrl: url.toString(), expiresInSeconds: 600 };
    },

    async complete({ ownerId, state, code } = {}) {
      if (ownerId !== undefined && ownerId !== null) ownerId = validOwner(ownerId);
      if (typeof state !== "string" || state.length < 32 || state.length > 256 ||
          typeof code !== "string" || code.length < 1 || code.length > 4096) {
        throw fail("Google OAuth callback is incomplete.", "GOOGLE_OAUTH_CALLBACK_INVALID");
      }
      const pending = await stateStore.consume(state);
      if (!pending || (ownerId && pending.ownerId !== ownerId) || !Number.isFinite(pending.expiresAt) ||
          pending.expiresAt <= now() || typeof pending.verifier !== "string" || typeof pending.nonce !== "string") {
        throw fail("Google OAuth state is invalid, expired, or belongs to another user.", "GOOGLE_OAUTH_STATE_INVALID");
      }
      ownerId = validOwner(pending.ownerId);
      const data = await exchange({
        code, client_id: id, client_secret: secret, redirect_uri: callback,
        grant_type: "authorization_code", code_verifier: pending.verifier
      });
      const token = validateTokenResponse(data);
      const identity = await identityVerifier(token.idToken, { clientId: id, nonce: pending.nonce, now: now() });
      if (!identity || typeof identity.subject !== "string" || typeof identity.email !== "string") {
        throw fail("Google account identity could not be verified.", "GOOGLE_OAUTH_IDENTITY_INVALID");
      }
      let refreshToken = data.refresh_token;
      if (!refreshToken) {
        const previous = await connections.get(ownerId);
        if (!previous || previous.ownerId !== ownerId) throw fail("Google did not issue a refresh token. Reconnect and approve offline access.", "GOOGLE_OAUTH_REFRESH_TOKEN_MISSING");
        refreshToken = decryptRefreshToken(previous.encryptedRefreshToken);
      }
      if (typeof refreshToken !== "string" || refreshToken.length < 20 || refreshToken.length > 8192) {
        throw fail("Google returned an invalid refresh token.", "GOOGLE_OAUTH_RESPONSE_INVALID");
      }
      await connections.upsert({
        ownerId, googleSubject: identity.subject, email: identity.email,
        encryptedRefreshToken: encryptRefreshToken(refreshToken), grantedScopes: token.scopes
      });
      accessCache.set(ownerId, { accessToken: token.accessToken, expiresAt: token.expiresAt });
      return { connected: true, email: identity.email, grantedScopes: token.scopes };
    },

    async getAccessToken({ ownerId } = {}) {
      ownerId = validOwner(ownerId);
      const cached = accessCache.get(ownerId);
      if (cached && cached.expiresAt > now() + 60000) return cached.accessToken;
      const inFlight = refreshInFlight.get(ownerId);
      if (inFlight) return inFlight;
      const pending = (async () => {
        const connection = await connections.get(ownerId);
        if (!connection || connection.ownerId !== ownerId) throw fail("Connect a Google Drive account before using private Drive files.", "GOOGLE_OAUTH_NOT_CONNECTED");
        const refreshToken = decryptRefreshToken(connection.encryptedRefreshToken);
        const data = await exchange({ client_id: id, client_secret: secret, refresh_token: refreshToken, grant_type: "refresh_token" });
        if (typeof data.access_token !== "string" || data.access_token.length < 20 ||
            !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) < 1) {
          throw fail("Google returned an incomplete refreshed access token.", "GOOGLE_OAUTH_RESPONSE_INVALID");
        }
        if (data.refresh_token) {
          if (typeof data.refresh_token !== "string" || data.refresh_token.length < 20 || data.refresh_token.length > 8192) {
            throw fail("Google returned an invalid rotated refresh token.", "GOOGLE_OAUTH_RESPONSE_INVALID");
          }
          await connections.upsert({ ...connection, encryptedRefreshToken: encryptRefreshToken(data.refresh_token) });
        }
        const result = { accessToken: data.access_token, expiresAt: now() + Math.min(Number(data.expires_in), 3600) * 1000 };
        accessCache.set(ownerId, result);
        return result.accessToken;
      })();
      refreshInFlight.set(ownerId, pending);
      try { return await pending; }
      finally { refreshInFlight.delete(ownerId); }
    },

    async disconnect({ ownerId } = {}) {
      ownerId = validOwner(ownerId);
      const connection = await connections.get(ownerId);
      if (!connection || connection.ownerId !== ownerId) { accessCache.delete(ownerId); return { disconnected: true, revoked: false }; }
      const refreshToken = decryptRefreshToken(connection.encryptedRefreshToken);
      let revoked = false;
      try {
        const result = await request(REVOKE_URL, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }).toString()
        });
        revoked = result.ok;
      } catch { revoked = false; } finally {
        await connections.delete(ownerId);
        accessCache.delete(ownerId);
      }
      return { disconnected: true, revoked };
    }
  });
}
