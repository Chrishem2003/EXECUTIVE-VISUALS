const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

function validScope({ assetId, ownerId, projectId = null } = {}) {
  if (!UUID.test(String(assetId || "")) || !UUID.test(String(ownerId || "")) ||
      (projectId !== null && projectId !== undefined && !UUID.test(String(projectId)))) {
    throw fail("GCS source asset scope is invalid.", "GEMINI_GCS_SOURCE_SCOPE_INVALID");
  }
  return { assetId, ownerId, projectId: projectId || null };
}
function validSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) ||
      !UUID.test(String(source.assetId || "")) || !UUID.test(String(source.ownerId || "")) ||
      (source.projectId !== null && source.projectId !== undefined && !UUID.test(String(source.projectId))) ||
      typeof source.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(source.bucket) ||
      source.bucket.includes("..") || source.bucket.includes(".-") || source.bucket.includes("-.") ||
      typeof source.objectName !== "string" || source.objectName.length < 1 || source.objectName.length > 1024 ||
      source.objectName.startsWith("/") || source.objectName.includes("\\") ||
      /[\u0000-\u0020\u007f?#%]/.test(source.objectName) ||
      source.objectName.split("/").some(part => !part || part === "." || part === "..") ||
      typeof source.generation !== "string" || !/^\d{1,30}$/.test(source.generation) ||
      typeof source.metageneration !== "string" || !/^\d{1,30}$/.test(source.metageneration) ||
      !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 2 * 1024 * 1024 * 1024 ||
      typeof source.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(source.mediaType) ||
      typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) {
    throw fail("Verified GCS source metadata is invalid.", "GEMINI_GCS_SOURCE_INVALID");
  }
  return source;
}
function publicSource(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    ownerId: row.owner_id,
    projectId: row.project_id || null,
    bucket: row.bucket,
    objectName: row.object_name,
    generation: String(row.generation),
    metageneration: String(row.metageneration),
    sizeBytes: Number(row.byte_size),
    mediaType: row.media_type,
    sha256: row.sha256,
    state: row.state,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at || null
  };
}

/**
 * Service-role-only PostgREST adapter for verified GCS mirror records.
 * It has no method to create arbitrary URIs or to mutate an object's identity.
 * recordVerifiedSource is called only after the GCS writer has uploaded the
 * object and independently verified its metadata and custom ownership fields.
 */
export function createGoogleGeminiGcsSourceRepository({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new TypeError("GCS source repository requires server-side Supabase credentials and fetch.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("GCS source repository timeout is invalid.");
  }
  let base;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error();
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    base = parsed.origin;
  } catch {
    throw new Error("GCS source repository URL must be a safe absolute HTTPS URL.");
  }

  async function request(path, { method = "GET", body, prefer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        apikey: serviceRoleKey,
        authorization: "Bearer " + serviceRoleKey,
        "accept-profile": "executive_visuals",
        "content-profile": "executive_visuals",
        accept: "application/json"
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (prefer) headers.prefer = prefer;
      const response = await fetchImpl(base + "/rest/v1/" + path, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: controller.signal
      });
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw fail("GCS source registry response is too large.", "GEMINI_GCS_SOURCE_RESPONSE_INVALID");
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { if (response.ok) throw fail("GCS source registry returned invalid JSON.", "GEMINI_GCS_SOURCE_RESPONSE_INVALID"); }
      }
      if (!response.ok) {
        const error = fail("GCS source registry request failed (HTTP " + response.status + ").", "GEMINI_GCS_SOURCE_REGISTRY_FAILED");
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("GCS source registry request timed out.", "GEMINI_GCS_SOURCE_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async findActiveSource(scope) {
      const { assetId, ownerId, projectId } = validScope(scope);
      const params = new URLSearchParams({
        select: "id,asset_id,owner_id,project_id,bucket,object_name,generation,metageneration,byte_size,media_type,sha256,state,verified_at,revoked_at",
        asset_id: "eq." + assetId,
        owner_id: "eq." + ownerId,
        state: "eq.ACTIVE",
        limit: "2"
      });
      params.set("project_id", projectId ? "eq." + projectId : "is.null");
      const rows = await request("google_gcs_asset_sources?" + params.toString());
      if (!Array.isArray(rows) || rows.length > 1) {
        throw fail("GCS source registry returned an ambiguous active mapping.", "GEMINI_GCS_SOURCE_AMBIGUOUS");
      }
      if (!rows.length) return null;
      const source = publicSource(rows[0]);
      if (source.assetId !== assetId || source.ownerId !== ownerId || source.projectId !== projectId || source.state !== "ACTIVE") {
        throw fail("GCS source registry returned a cross-scope mapping.", "GEMINI_GCS_SOURCE_SCOPE_MISMATCH");
      }
      return source;
    },

    async recordVerifiedSource(input) {
      const source = validSource(input);
      const { assetId, ownerId, projectId } = validScope(source);
      const rows = await request("google_gcs_asset_sources?select=id,asset_id,owner_id,project_id,bucket,object_name,generation,metageneration,byte_size,media_type,sha256,state,verified_at,revoked_at", {
        method: "POST",
        prefer: "return=representation",
        body: {
          asset_id: assetId, owner_id: ownerId, project_id: projectId,
          bucket: source.bucket, object_name: source.objectName,
          generation: source.generation, metageneration: source.metageneration,
          byte_size: source.sizeBytes, media_type: source.mediaType, sha256: source.sha256,
          state: "ACTIVE"
        }
      });
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw fail("GCS source registry did not persist exactly one verified source.", "GEMINI_GCS_SOURCE_PERSIST_FAILED");
      }
      const saved = publicSource(rows[0]);
      if (saved.assetId !== assetId || saved.ownerId !== ownerId || saved.projectId !== projectId ||
          saved.bucket !== source.bucket || saved.objectName !== source.objectName ||
          saved.generation !== source.generation || saved.metageneration !== source.metageneration ||
          saved.sizeBytes !== source.sizeBytes || saved.mediaType !== source.mediaType ||
          saved.sha256 !== source.sha256 || saved.state !== "ACTIVE") {
        throw fail("Persisted GCS source does not match the verified upload receipt.", "GEMINI_GCS_SOURCE_PERSIST_MISMATCH");
      }
      return saved;
    },

    async revokeSource({ sourceId, assetId, ownerId, projectId = null } = {}) {
      if (!UUID.test(String(sourceId || ""))) throw fail("GCS source ID is invalid.", "GEMINI_GCS_SOURCE_SCOPE_INVALID");
      const scope = validScope({ assetId, ownerId, projectId });
      const params = new URLSearchParams({
        id: "eq." + sourceId, asset_id: "eq." + scope.assetId,
        owner_id: "eq." + scope.ownerId, state: "eq.ACTIVE",
        select: "id,state,revoked_at"
      });
      params.set("project_id", scope.projectId ? "eq." + scope.projectId : "is.null");
      const rows = await request("google_gcs_asset_sources?" + params.toString(), {
        method: "PATCH",
        prefer: "return=representation",
        body: { state: "REVOKED", revoked_at: new Date().toISOString() }
      });
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== sourceId || rows[0].state !== "REVOKED" || !rows[0].revoked_at) {
        throw fail("GCS source revocation did not update exactly one active scoped record.", "GEMINI_GCS_SOURCE_REVOKE_CONFLICT");
      }
      return Object.freeze({ id: sourceId, state: "REVOKED", revokedAt: rows[0].revoked_at });
    }
  });
}
