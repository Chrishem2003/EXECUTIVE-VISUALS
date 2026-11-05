const TABLE = "google_video_interactions";
const MODEL = "gemini-omni-1.1-flash";
const ID = /^v1_[A-Za-z0-9_-]{6,200}$/;
const OUTPUT_URI = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+(?::download\?alt=media)?$/;
const STATES = new Set(["running", "waiting", "succeeded", "failed", "canceled", "incomplete", "unknown", "deleting", "deleted"]);

function safeOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Google interaction repository URL is invalid."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Google interaction repository URL must be HTTPS without credentials or query parameters.");
  }
  return parsed.origin;
}
function required(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(label + " is required and bounded.");
  return value;
}
function iso(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(label + " must be a valid timestamp.");
  return date.toISOString();
}
function mapRow(row) {
  if (!row || typeof row !== "object" || !ID.test(String(row.interaction_id || "")) ||
      row.model !== MODEL || !STATES.has(row.state)) {
    throw new Error("Google interaction repository returned an invalid record.");
  }
  return Object.freeze({
    id: row.id,
    provider: row.provider,
    model: row.model,
    interactionId: row.interaction_id,
    jobId: row.job_id,
    ownerId: row.owner_id,
    projectId: row.project_id || null,
    requestHash: row.request_hash,
    parentInteractionId: row.parent_interaction_id || null,
    state: row.state,
    outputFileName: row.output_file_name || null,
    outputUri: row.output_uri || null,
    submittedAt: row.submitted_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at || null,
    metadata: row.metadata || {}
  });
}

/** Service-role-only repository. It stores ownership and lifecycle metadata, never video bytes. */
export function createGoogleVideoInteractionRepository({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") {
    throw new Error("Google interaction repository requires server-side Supabase credentials and fetch.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("Google interaction repository timeout is invalid.");
  }
  const base = safeOrigin(url);
  const columns = "id,provider,model,interaction_id,job_id,owner_id,project_id,request_hash,parent_interaction_id,state,output_file_name,output_uri,submitted_at,expires_at,deleted_at,metadata";

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
          accept: "application/json",
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
        catch { if (response.ok) throw new Error("Google interaction repository returned invalid JSON."); }
      }
      if (!response.ok) {
        const error = new Error("Google interaction repository request failed (HTTP " + response.status + ").");
        error.code = "GOOGLE_INTERACTION_REPOSITORY_HTTP_" + response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Google interaction repository request timed out.");
        timeout.code = "GOOGLE_INTERACTION_REPOSITORY_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  function scopeParams({ interactionId, ownerId, projectId = null, jobId } = {}) {
    required(interactionId, "Interaction ID", 220);
    if (!ID.test(interactionId)) throw new Error("Google interaction ID is invalid.");
    required(ownerId, "Owner ID");
    required(jobId, "Job ID");
    const params = new URLSearchParams({
      select: columns,
      interaction_id: "eq." + interactionId,
      owner_id: "eq." + ownerId,
      job_id: "eq." + jobId,
      limit: "1"
    });
    params.set("project_id", projectId ? "eq." + required(projectId, "Project ID") : "is.null");
    return params;
  }

  return Object.freeze({
    async recordInteraction(record = {}) {
      const interactionId = required(record.interactionId, "Interaction ID", 220);
      if (!ID.test(interactionId)) throw new Error("Google interaction ID is invalid.");
      if (record.provider !== "google" || record.model !== MODEL) throw new Error("Google interaction provider/model is invalid.");
      const ownerId = required(record.ownerId, "Owner ID");
      const jobId = required(record.jobId, "Job ID");
      const projectId = record.projectId ? required(record.projectId, "Project ID") : null;
      const requestHash = required(record.requestHash, "Request hash", 64);
      if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error("Google interaction request hash is invalid.");
      const parent = record.parentInteractionId || null;
      if (parent !== null && (typeof parent !== "string" || !ID.test(parent))) throw new Error("Parent interaction ID is invalid.");
      if (!STATES.has(record.state) || record.state === "deleted") throw new Error("Initial Google interaction state is invalid.");
      const expiresAt = iso(record.expiresAt, "Interaction expiry");
      if (Date.parse(expiresAt) <= Date.now()) throw new Error("Interaction expiry must be in the future.");
      const outputUri = record.outputUri ?? null;
      if (outputUri !== null && (typeof outputUri !== "string" || !OUTPUT_URI.test(outputUri))) throw new Error("Google output URI is invalid.");
      const metadata = record.metadata ?? {};
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 4000) {
        throw new Error("Google interaction metadata must be a bounded JSON object.");
      }
      const body = {
        provider: "google", model: MODEL, interaction_id: interactionId, job_id: jobId,
        owner_id: ownerId, project_id: projectId, request_hash: requestHash,
        parent_interaction_id: parent, state: record.state,
        output_file_name: record.outputFileName || null,
        output_uri: outputUri,
        submitted_at: iso(record.submittedAt || new Date().toISOString(), "Submission time"),
        expires_at: expiresAt, metadata
      };
      const params = new URLSearchParams({ select: columns });
      const rows = await request("?" + params.toString(), {
        method: "POST", body, prefer: "return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google interaction ownership record was not durably persisted.");
      return mapRow(rows[0]);
    },

    async findInteraction(scope = {}) {
      const rows = await request("?" + scopeParams(scope).toString());
      if (!Array.isArray(rows) || rows.length > 1) throw new Error("Google interaction lookup returned an invalid result.");
      return rows.length ? mapRow(rows[0]) : null;
    },

    async updateInteraction({ interactionId, ownerId, projectId = null, jobId, state, outputFileName, outputUri, metadata } = {}) {
      const scope = { interactionId, ownerId, projectId, jobId };
      if (!STATES.has(state)) throw new Error("Google interaction state is invalid.");
      const body = { state, updated_at: new Date().toISOString() };
      if (outputFileName !== undefined) body.output_file_name = outputFileName;
      if (outputUri !== undefined) {
        if (outputUri !== null && (typeof outputUri !== "string" || !OUTPUT_URI.test(outputUri))) throw new Error("Google output URI is invalid.");
        body.output_uri = outputUri;
      }
      if (metadata !== undefined) {
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 4000) {
          throw new Error("Google interaction metadata must be a bounded JSON object.");
        }
        body.metadata = metadata;
      }
      const params = scopeParams(scope);
      params.delete("select");
      const rows = await request("?" + params.toString() + "&select=" + encodeURIComponent(columns), {
        method: "PATCH", body, prefer: "return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google interaction update did not match one authorized job record.");
      return mapRow(rows[0]);
    },

    async markInteractionDeleted({ interactionId, ownerId, projectId = null, jobId } = {}) {
      const scope = { interactionId, ownerId, projectId, jobId };
      const params = scopeParams(scope);
      params.delete("select");
      const rows = await request("?" + params.toString() + "&select=" + encodeURIComponent(columns), {
        method: "PATCH",
        body: { state: "deleted", deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        prefer: "return=representation"
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Google interaction deletion did not match one authorized job record.");
      return mapRow(rows[0]);
    },

    async listExpired({ before = new Date().toISOString(), limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Expired interaction page size is invalid.");
      const params = new URLSearchParams({
        select: columns,
        expires_at: "lte." + iso(before, "Expiry cutoff"),
        state: "not.eq.deleted",
        order: "expires_at.asc",
        limit: String(limit)
      });
      const rows = await request("?" + params.toString());
      if (!Array.isArray(rows)) throw new Error("Expired Google interaction query returned an invalid result.");
      return rows.map(mapRow);
    }
  });
}
