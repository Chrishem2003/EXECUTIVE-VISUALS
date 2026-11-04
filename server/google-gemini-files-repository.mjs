const PROVIDER = "google-gemini-files";
const TABLE = "google_provider_files";

function safeOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Google provider-file repository URL is invalid."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Google provider-file repository URL must be HTTPS without credentials or query parameters.");
  }
  return parsed.origin;
}

/** Service-role-only PostgREST repository for Gemini's temporary file references. */
export function createGoogleGeminiFilesRepository({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Google provider-file repository requires server-side Supabase credentials and fetch.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Google provider-file repository timeout is invalid.");
  }
  const base = safeOrigin(url);

  async function request(query, { method = "GET", body, prefer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/" + TABLE + query, {
        method,
        headers: {
          apikey: serviceRoleKey,
          authorization: "Bearer " + serviceRoleKey,
          "accept-profile": "executive_visuals",
          "content-profile": "executive_visuals",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(prefer ? { prefer } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error"
      });
      const raw = await response.text();
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { if (response.ok) throw new Error("Google provider-file repository returned invalid JSON."); }
      }
      if (!response.ok) {
        const error = new Error("Google provider-file repository request failed (HTTP " + response.status + ").");
        error.code = "GOOGLE_PROVIDER_FILE_REPOSITORY_HTTP_" + response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Google provider-file repository request timed out.");
        timeout.code = "GOOGLE_PROVIDER_FILE_REPOSITORY_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async findProviderFile({ assetId, ownerId, projectId = null, mimeType }) {
      const params = new URLSearchParams({
        select: "id,provider,asset_id,owner_id,project_id,google_file_name,google_file_uri,mime_type,byte_size,sha256,state,uploaded_at,expires_at",
        provider: "eq." + PROVIDER,
        asset_id: "eq." + assetId,
        owner_id: "eq." + ownerId,
        mime_type: "eq." + mimeType,
        limit: "1"
      });
      params.set("project_id", projectId ? "eq." + projectId : "is.null");
      const rows = await request("?" + params.toString());
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        provider: row.provider,
        assetId: row.asset_id,
        ownerId: row.owner_id,
        projectId: row.project_id || null,
        name: row.google_file_name,
        uri: row.google_file_uri,
        mimeType: row.mime_type,
        sizeBytes: Number(row.byte_size),
        sha256: row.sha256,
        state: row.state,
        uploadedAt: row.uploaded_at,
        expiresAt: row.expires_at
      };
    },
    async recordProviderFile(record) {
      if (!record || record.provider !== PROVIDER) throw new Error("Google provider-file record has an invalid provider.");
      const body = {
        provider: PROVIDER,
        asset_id: record.assetId,
        owner_id: record.ownerId,
        project_id: record.projectId || null,
        google_file_name: record.name,
        google_file_uri: record.uri,
        mime_type: record.mimeType,
        byte_size: record.sizeBytes,
        sha256: record.sha256,
        state: record.state,
        uploaded_at: record.uploadedAt,
        expires_at: record.expiresAt
      };
      const params = new URLSearchParams({ on_conflict: "provider,asset_id", select: "id" });
      const rows = await request("?" + params.toString(), {
        method: "POST",
        body,
        prefer: "resolution=merge-duplicates,return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google provider-file mapping was not durably persisted.");
      return rows[0].id;
    },
    async deleteProviderFileRecord({ name, recordId } = {}) {
      const params = new URLSearchParams({ provider: "eq." + PROVIDER });
      if (recordId) params.set("id", "eq." + recordId);
      else if (name) params.set("google_file_name", "eq." + name);
      else throw new Error("Google provider-file record deletion requires an ID or file name.");
      await request("?" + params.toString(), { method: "DELETE", prefer: "return=minimal" });
      return true;
    }
  });
}
