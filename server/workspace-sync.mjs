// Durable workspace saving for signed-in users.
//
// The server talks to Supabase as the signed-in user: the user's own access token plus
// the public (publishable) key. No secret or service-role key is used or needed. A
// row-level security rule in the database (see supabase/migrations) limits every request
// to that user's own row, so a bug here cannot expose another person's work.
//
// One row per user holds one workspace snapshot, guarded by a revision number so a stale
// device cannot silently overwrite newer work.

export const WORKSPACE_TABLE = "ev_workspace_snapshots";
export const MAX_WORKSPACE_BYTES = 900_000;

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

function checkToken(accessToken) {
  if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192) {
    throw fail(401, "INVALID_ACCESS_TOKEN", "Sign in to save your work to your account.");
  }
}

/** Returns a clean { json, bytes } or throws a 400/413 error. */
export function validateSnapshot(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw fail(400, "INVALID_WORKSPACE", "Workspace data must be an object.");
  let json;
  try { json = JSON.stringify(data); } catch { throw fail(400, "INVALID_WORKSPACE", "Workspace data could not be read."); }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_WORKSPACE_BYTES) {
    throw fail(413, "WORKSPACE_TOO_LARGE", "Your workspace is too large to save (" + Math.ceil(bytes / 1000) + " KB; the limit is " + Math.floor(MAX_WORKSPACE_BYTES / 1000) + " KB). Remove unused items and try again.");
  }
  return { json, bytes };
}

export function createWorkspaceStore({
  url = process.env.SUPABASE_URL,
  publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000
} = {}) {
  if (!url || !publishableKey) throw new Error("Workspace saving requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
  if (typeof fetchImpl !== "function") throw new Error("Workspace saving requires fetch.");
  let base;
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !local) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("bad");
    base = parsed.origin;
  } catch { throw new Error("SUPABASE_URL must be a plain HTTPS URL."); }

  async function request(accessToken, query, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/" + WORKSPACE_TABLE + query, {
        method,
        headers: {
          apikey: publishableKey,
          authorization: "Bearer " + accessToken,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET" ? {} : { prefer: "return=representation" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      const raw = await response.text();
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch { throw fail(502, "WORKSPACE_BAD_RESPONSE", "The storage service returned an invalid response."); } }
      return { status: response.status, ok: response.ok, data };
    } catch (error) {
      if (error && error.name === "AbortError") throw fail(504, "WORKSPACE_TIMEOUT", "The storage service took too long to respond.");
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** Translate a failed storage response into a safe, plain error. */
  function storageError(result) {
    const code = result.data && typeof result.data === "object" ? String(result.data.code || "") : "";
    if (result.status === 401 || result.status === 403) return fail(401, "SESSION_EXPIRED", "Your sign-in has expired. Sign in again to keep saving.");
    // 42P01 / PGRST205: the table has not been created yet. Tell the operator what to do.
    if (code === "42P01" || code === "PGRST205" || result.status === 404) return fail(503, "WORKSPACE_NOT_SET_UP", "Cloud saving is not set up yet. The site owner needs to run the one-time database setup.");
    return fail(502, "WORKSPACE_STORAGE_ERROR", "Your work could not be saved right now. It is still safe on this device.");
  }

  const shape = row => ({ found: true, revision: Number(row.revision), updatedAt: row.updated_at, data: row.data && typeof row.data === "object" ? row.data : {} });

  const store = {
    async get(accessToken) {
      checkToken(accessToken);
      const result = await request(accessToken, "?select=data,revision,updated_at&limit=1");
      if (!result.ok) throw storageError(result);
      const row = Array.isArray(result.data) ? result.data[0] : null;
      return row ? shape(row) : { found: false, revision: 0, updatedAt: null, data: null };
    },

    async put(accessToken, { data, expectedRevision } = {}) {
      checkToken(accessToken);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 1_000_000_000) {
        throw fail(400, "INVALID_REVISION", "A valid revision number is required.");
      }
      validateSnapshot(data);

      let result;
      if (expectedRevision === 0) {
        // First save for this account. The primary key makes a second concurrent first save fail.
        result = await request(accessToken, "?select=revision,updated_at", { method: "POST", body: { data, revision: 1 } });
      } else {
        result = await request(accessToken, "?revision=eq." + expectedRevision + "&select=revision,updated_at", {
          method: "PATCH",
          body: { data, revision: expectedRevision + 1, updated_at: new Date().toISOString() }
        });
        if (result.ok && (!Array.isArray(result.data) || result.data.length === 0)) result = { status: 409, ok: false, data: null };
      }

      if (result.status === 409 || (result.data && typeof result.data === "object" && String(result.data.code) === "23505")) {
        // Someone (another device) saved first. Report the current revision so the client can choose.
        const current = await store.get(accessToken);
        throw fail(409, "WORKSPACE_CONFLICT", "A newer version of your workspace was saved from another device.", { currentRevision: current.revision, currentUpdatedAt: current.updatedAt });
      }
      if (!result.ok) throw storageError(result);
      const row = Array.isArray(result.data) ? result.data[0] : null;
      if (!row) throw fail(502, "WORKSPACE_BAD_RESPONSE", "The storage service returned an invalid response.");
      return { revision: Number(row.revision), updatedAt: row.updated_at };
    }
  };
  return Object.freeze(store);
}
