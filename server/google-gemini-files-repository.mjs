const PROVIDER = "google-gemini-files";
const TABLE = "google_provider_files";
const ATTEMPT_TABLE = "google_provider_file_upload_attempts";

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

  async function request(query, { method = "GET", body, prefer, table = TABLE } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/" + table + query, {
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
    async createUploadAttempt(attempt) {
      if (!attempt || !/^[a-f0-9]{64}$/.test(String(attempt.attemptKey || "")) ||
          !/^[a-f0-9]{64}$/.test(String(attempt.sha256 || "")) ||
          !/^[a-f0-9]{64}$/.test(String(attempt.displayNameHash || ""))) {
        throw new Error("Google provider upload attempt metadata is invalid.");
      }
      const body = {
        attempt_key: attempt.attemptKey,
        asset_id: attempt.assetId,
        owner_id: attempt.ownerId,
        project_id: attempt.projectId || null,
        mime_type: attempt.mimeType,
        byte_size: attempt.sizeBytes,
        sha256: attempt.sha256,
        google_display_name: attempt.displayName,
        state: "PREPARED"
      };
      const params = new URLSearchParams({
        on_conflict: "attempt_key",
        select: "id,attempt_key,asset_id,owner_id,project_id,mime_type,byte_size,sha256,google_display_name,state,google_file_name,google_file_uri,provider_expires_at,last_error_code,attempt_count,created_at,updated_at,reconciled_at"
      });
      let rows = await request("?" + params.toString(), {
        method: "POST", body, table: ATTEMPT_TABLE,
        prefer: "resolution=ignore-duplicates,return=representation"
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        const lookup = new URLSearchParams({ select: "id,attempt_key,asset_id,owner_id,project_id,mime_type,byte_size,sha256,google_display_name,state,google_file_name,google_file_uri,provider_expires_at,last_error_code,attempt_count,created_at,updated_at,reconciled_at", attempt_key: "eq." + attempt.attemptKey, limit: "1" });
        rows = await request("?" + lookup.toString(), { table: ATTEMPT_TABLE });
      }
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google provider upload attempt was not durably recorded.");
      const row = rows[0];
      return {
        id: row.id, attemptKey: row.attempt_key, assetId: row.asset_id,
        ownerId: row.owner_id, projectId: row.project_id || null,
        mimeType: row.mime_type, sizeBytes: Number(row.byte_size), sha256: row.sha256,
        displayName: row.google_display_name, state: row.state,
        providerFileName: row.google_file_name || null,
        providerFileUri: row.google_file_uri || null,
        providerExpiresAt: row.provider_expires_at || null,
        lastErrorCode: row.last_error_code || null,
        attemptCount: Number(row.attempt_count || 1),
        updatedAt: row.updated_at, reconciledAt: row.reconciled_at || null
      };
    },
    async updateUploadAttempt({ attemptId, state, providerFileName, providerFileUri, providerExpiresAt, errorCode, reconciledAt } = {}) {
      if (typeof attemptId !== "string" || !/^[0-9a-f-]{36}$/i.test(attemptId) ||
          !["PREPARED", "UPLOADING", "OUTCOME_UNKNOWN", "PROVIDER_CREATED", "COMPLETED", "FAILED"].includes(state)) {
        throw new Error("Google provider upload attempt transition is invalid.");
      }
      const body = { state, updated_at: new Date().toISOString() };
      if (providerFileName !== undefined) body.google_file_name = providerFileName;
      if (providerFileUri !== undefined) body.google_file_uri = providerFileUri;
      if (providerExpiresAt !== undefined) body.provider_expires_at = providerExpiresAt;
      if (errorCode !== undefined) body.last_error_code = errorCode;
      if (reconciledAt !== undefined) body.reconciled_at = reconciledAt;
      const params = new URLSearchParams({ id: "eq." + attemptId, select: "id" });
      const rows = await request("?" + params.toString(), {
        method: "PATCH", body, table: ATTEMPT_TABLE, prefer: "return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google provider upload attempt transition did not match one record.");
      return rows[0].id;
    },
    async findProviderFile({ assetId, ownerId, projectId = null, mimeType }) {
      const params = new URLSearchParams({
        select: "id,provider,asset_id,owner_id,project_id,google_file_name,google_file_uri,mime_type,byte_size,sha256,state,uploaded_at,expires_at,source_type,source_uri",
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
        expiresAt: row.expires_at,
        sourceType: row.source_type || "upload",
        sourceUri: row.source_uri || null
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
        expires_at: record.expiresAt,
        source_type: record.sourceType || "upload",
        source_uri: record.sourceUri || null
      };
      const params = new URLSearchParams({ on_conflict: "provider,asset_id,owner_id", select: "id" });
      const rows = await request("?" + params.toString(), {
        method: "POST",
        body,
        prefer: "resolution=merge-duplicates,return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google provider-file mapping was not durably persisted.");
      return rows[0].id;
    },
    async listExpiredProviderFiles({ before = new Date().toISOString(), limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Expired Google provider-file page size is invalid.");
      const cutoff = new Date(before);
      if (!Number.isFinite(cutoff.getTime())) throw new Error("Expired Google provider-file cutoff is invalid.");
      const params = new URLSearchParams({
        select: "id,provider,asset_id,owner_id,project_id,google_file_name,google_file_uri,mime_type,byte_size,sha256,state,uploaded_at,expires_at,source_type,source_uri",
        provider: "eq." + PROVIDER,
        expires_at: "lte." + cutoff.toISOString(),
        state: "in.(ACTIVE,EXPIRED)",
        order: "expires_at.asc",
        limit: String(limit)
      });
      const rows = await request("?" + params.toString());
      if (!Array.isArray(rows)) throw new Error("Expired Google provider-file query returned an invalid result.");
      return rows.map(row => ({
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
        expiresAt: row.expires_at,
        sourceType: row.source_type || "upload",
        sourceUri: row.source_uri || null
      }));
    },
    async updateProviderFileState({ name, recordId, state } = {}) {
      if (!["ACTIVE", "EXPIRED", "DELETED", "FAILED"].includes(state)) {
        throw new Error("Google provider-file state is invalid.");
      }
      const params = new URLSearchParams({ provider: "eq." + PROVIDER, select: "id" });
      if (recordId) params.set("id", "eq." + recordId);
      else if (name) params.set("google_file_name", "eq." + name);
      else throw new Error("Google provider-file state update requires an ID or file name.");
      const rows = await request("?" + params.toString(), {
        method: "PATCH",
        body: { state, updated_at: new Date().toISOString() },
        prefer: "return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google provider-file state update did not match one record.");
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
