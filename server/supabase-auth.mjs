import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const COOKIE_VERSION = "v1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw fail("Configure a valid Supabase project URL.", "SUPABASE_AUTH_CONFIG_INVALID"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw fail("Supabase Auth must use an HTTPS project origin (HTTP is allowed only for loopback tests).", "SUPABASE_AUTH_CONFIG_INVALID");
  }
  return url.origin;
}

function safeUser(value) {
  if (!value || typeof value.id !== "string" || !value.id || value.id.length > 128) {
    throw fail("Supabase Auth returned an invalid user record.", "SUPABASE_AUTH_INVALID_RESPONSE");
  }
  return { id: value.id, email: typeof value.email === "string" ? value.email.slice(0, 320) : "" };
}

function readTokenResponse(data) {
  if (!data || typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token) {
    throw fail("Supabase Auth returned an incomplete session.", "SUPABASE_AUTH_INVALID_RESPONSE");
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    user: safeUser(data.user)
  };
}

export function createSupabaseAuth({
  url,
  publishableKey,
  sessionSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  const base = normalizeBaseUrl(url);
  const key = String(publishableKey || "").trim();
  const secret = String(sessionSecret || "");
  if (!key || key.length > 512) throw fail("Configure the Supabase publishable key.", "SUPABASE_AUTH_CONFIG_INVALID");
  if (secret.length < 32 || secret.length > 4096) {
    throw fail("SUPABASE_SESSION_SECRET must contain at least 32 characters.", "SUPABASE_AUTH_CONFIG_INVALID");
  }
  if (typeof fetchImpl !== "function") throw fail("Supabase Auth requires a fetch implementation.", "SUPABASE_AUTH_CONFIG_INVALID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw fail("Supabase Auth timeout must be between 1000 and 60000 milliseconds.", "SUPABASE_AUTH_CONFIG_INVALID");
  }

  const encryptionKey = createHash("sha256").update(secret, "utf8").digest();

  function seal(session) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const plaintext = Buffer.from(JSON.stringify({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt
    }), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [COOKIE_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  function open(cookie) {
    if (typeof cookie !== "string" || cookie.length < 40 || cookie.length > 12000) return null;
    const [version, ivText, tagText, ciphertextText, extra] = cookie.split(".");
    if (version !== COOKIE_VERSION || !ivText || !tagText || !ciphertextText || extra !== undefined) return null;
    try {
      const iv = Buffer.from(ivText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      const ciphertext = Buffer.from(ciphertextText, "base64url");
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 8192) return null;
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const value = JSON.parse(plaintext.toString("utf8"));
      if (typeof value.accessToken !== "string" || !value.accessToken ||
          typeof value.refreshToken !== "string" || !value.refreshToken ||
          !Number.isFinite(value.expiresAt)) return null;
      return value;
    } catch { return null; }
  }

  async function request(path, body, accessToken = "", method = "POST") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(base + path, {
          method,
          headers: {
            apikey: key,
            "content-type": "application/json",
            ...(accessToken ? { authorization: "Bearer " + accessToken } : {})
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) }),
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Supabase Auth request timed out." : "Supabase Auth is temporarily unavailable.",
          error?.name === "AbortError" ? "SUPABASE_AUTH_TIMEOUT" : "SUPABASE_AUTH_UNAVAILABLE");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
        throw fail("Supabase Auth returned an oversized response.", "SUPABASE_AUTH_INVALID_RESPONSE");
      }
      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { throw fail("Supabase Auth returned an invalid response.", "SUPABASE_AUTH_INVALID_RESPONSE"); }
      }
      return { status: response.status, ok: response.ok, data };
    } finally { clearTimeout(timer); }
  }

  async function refreshSession(session) {
    const result = await request("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refreshToken });
    if (!result.ok) {
      if (result.status === 400 || result.status === 401) return null;
      throw fail("Supabase could not refresh the session. Try again shortly.", "SUPABASE_AUTH_UNAVAILABLE");
    }
    const next = readTokenResponse(result.data);
    return { user: next.user, cookie: seal(next), maxAge: SESSION_MAX_AGE_SECONDS };
  }

  return Object.freeze({
    async signIn(email, password) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const pass = String(password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || pass.length < 12 || pass.length > 256) {
        throw fail("Enter a valid email and a password of at least 12 characters.", "INVALID_CREDENTIALS");
      }
      const result = await request("/auth/v1/token?grant_type=password", { email: normalizedEmail, password: pass });
      if (!result.ok) {
        if (result.status === 400 || result.status === 401) throw fail("Email or password is incorrect.", "INVALID_CREDENTIALS");
        throw fail("Supabase sign-in is temporarily unavailable.", "SUPABASE_AUTH_UNAVAILABLE");
      }
      const session = readTokenResponse(result.data);
      return { user: session.user, cookie: seal(session), maxAge: SESSION_MAX_AGE_SECONDS };
    },

    async signUp(email, password) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const pass = String(password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || pass.length < 12 || pass.length > 256) {
        throw fail("Enter a valid email and a password of at least 12 characters.", "INVALID_CREDENTIALS");
      }
      const result = await request("/auth/v1/signup", { email: normalizedEmail, password: pass });
      if (!result.ok) {
        if (result.status === 400 || result.status === 409) throw fail("Account registration could not be completed. Check the email and password requirements.", "SIGNUP_REJECTED");
        throw fail("Supabase registration is temporarily unavailable.", "SUPABASE_AUTH_UNAVAILABLE");
      }
      const user = safeUser(result.data.user);
      if (typeof result.data.access_token !== "string" || typeof result.data.refresh_token !== "string") {
        return { user, cookie: null, maxAge: 0, confirmationRequired: true };
      }
      const session = readTokenResponse(result.data);
      return { user: session.user, cookie: seal(session), maxAge: SESSION_MAX_AGE_SECONDS, confirmationRequired: false };
    },

    async getUser(cookie) {
      const session = open(cookie);
      if (!session) return null;
      if (session.expiresAt <= Date.now() + 60000) return refreshSession(session);
      const result = await request("/auth/v1/user", {}, session.accessToken, "GET");
      if (result.ok) return { user: safeUser(result.data), cookie: null, maxAge: SESSION_MAX_AGE_SECONDS };
      if (result.status === 401) return refreshSession(session);
      throw fail("Supabase session verification is temporarily unavailable.", "SUPABASE_AUTH_UNAVAILABLE");
    },

    async signOut(cookie) {
      const session = open(cookie);
      if (session) {
        try { await request("/auth/v1/logout", {}, session.accessToken); }
        catch { /* Clear the local session even when the remote logout endpoint is unavailable. */ }
      }
    }
  });
}

export const SUPABASE_SESSION_COOKIE = "ev_supabase_session";
export const SUPABASE_SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_SECONDS;
