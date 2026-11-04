const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code) => Object.assign(new Error(message), { code });

/** Service-role-only persistence adapter. Refresh tokens must arrive already AES-GCM encrypted. */
export function createGoogleDriveConnectionStore({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000
} = {}) {
  let base;
  try {
    const parsed = new URL(String(url || ""));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error();
    base = parsed.origin;
  } catch { throw fail("Google connection store requires a safe Supabase project URL.", "GOOGLE_CONNECTION_STORE_CONFIG_INVALID"); }
  if (typeof serviceRoleKey !== "string" || serviceRoleKey.length < 20 || serviceRoleKey.length > 8192 ||
      typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw fail("Google connection store configuration is invalid.", "GOOGLE_CONNECTION_STORE_CONFIG_INVALID");
  }
  async function request(query, { method = "GET", body, prefer } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(base + "/rest/v1/google_drive_connections?" + query, {
          method,
          headers: {
            apikey: serviceRoleKey, authorization: "Bearer " + serviceRoleKey,
            "accept-profile": "executive_visuals", "content-profile": "executive_visuals",
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(prefer ? { prefer } : {})
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal, redirect: "error"
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Google connection store timed out." : "Google connection store is unavailable.",
          error?.name === "AbortError" ? "GOOGLE_CONNECTION_STORE_TIMEOUT" : "GOOGLE_CONNECTION_STORE_UNAVAILABLE");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw fail("Google connection store response is oversized.", "GOOGLE_CONNECTION_STORE_RESPONSE_INVALID");
      let data = [];
      if (raw) { try { data = JSON.parse(raw); } catch { throw fail("Google connection store returned invalid JSON.", "GOOGLE_CONNECTION_STORE_RESPONSE_INVALID"); } }
      if (!response.ok) throw fail("Google connection store rejected the operation (HTTP " + response.status + ").", "GOOGLE_CONNECTION_STORE_WRITE_FAILED");
      return data;
    } finally { clearTimeout(timer); }
  }
  function owner(value) {
    if (typeof value !== "string" || !UUID.test(value)) throw fail("Google connection owner ID is invalid.", "GOOGLE_CONNECTION_STORE_OWNER_INVALID");
    return value;
  }
  function map(row) {
    if (!row || typeof row.owner_id !== "string" || !UUID.test(row.owner_id) ||
        typeof row.encrypted_refresh_token !== "string" || !row.encrypted_refresh_token.startsWith("gdrive:v1:") ||
        typeof row.google_subject !== "string" || typeof row.google_email !== "string" ||
        !Array.isArray(row.granted_scopes) || !row.granted_scopes.includes("https://www.googleapis.com/auth/drive.file")) {
      throw fail("Google connection record failed validation.", "GOOGLE_CONNECTION_STORE_RESPONSE_INVALID");
    }
    return {
      ownerId: row.owner_id, googleSubject: row.google_subject, email: row.google_email,
      encryptedRefreshToken: row.encrypted_refresh_token, grantedScopes: row.granted_scopes
    };
  }
  return Object.freeze({
    async get(ownerId) {
      ownerId = owner(ownerId);
      const rows = await request("owner_id=eq." + encodeURIComponent(ownerId) + "&select=owner_id,google_subject,google_email,encrypted_refresh_token,granted_scopes&limit=1");
      if (!Array.isArray(rows)) throw fail("Google connection lookup returned an invalid response.", "GOOGLE_CONNECTION_STORE_RESPONSE_INVALID");
      return rows.length ? map(rows[0]) : null;
    },
    async upsert(value) {
      const ownerId = owner(value?.ownerId);
      if (typeof value.googleSubject !== "string" || value.googleSubject.length < 5 || value.googleSubject.length > 255 ||
          typeof value.email !== "string" || value.email.length < 3 || value.email.length > 320 ||
          typeof value.encryptedRefreshToken !== "string" || !/^gdrive:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.encryptedRefreshToken) ||
          !Array.isArray(value.grantedScopes) || !value.grantedScopes.includes("https://www.googleapis.com/auth/drive.file")) {
        throw fail("Google connection record is incomplete or invalid.", "GOOGLE_CONNECTION_STORE_RECORD_INVALID");
      }
      const rows = await request("on_conflict=owner_id&select=owner_id,google_subject,google_email,encrypted_refresh_token,granted_scopes", {
        method: "POST", prefer: "resolution=merge-duplicates,return=representation",
        body: { owner_id: ownerId, google_subject: value.googleSubject, google_email: value.email,
          encrypted_refresh_token: value.encryptedRefreshToken, granted_scopes: value.grantedScopes }
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw fail("Google connection upsert did not return one record.", "GOOGLE_CONNECTION_STORE_RESPONSE_INVALID");
      return map(rows[0]);
    },
    async delete(ownerId) {
      ownerId = owner(ownerId);
      await request("owner_id=eq." + encodeURIComponent(ownerId), { method: "DELETE", prefer: "return=minimal" });
      return true;
    }
  });
}
