const SCHEMA = "executive_visuals";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = value => Array.isArray(value) ? "[" + value.map(stable).join(",") + "]" : plain(value) ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}" : JSON.stringify(value);
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * Immutable cloud checkpoint store. All requests use the server-only service role;
 * owner and project filters are mandatory on every read and write receipt.
 */
export function createCloudVideoPipelineCheckpointStore({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cloud video checkpoints require server-side Supabase credentials.");
  if (typeof fetchImpl !== "function") throw new Error("Cloud video checkpoints require fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error("Cloud video checkpoint timeout is invalid.");
  const base = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname.toLowerCase());
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) || base.username || base.password || base.search || base.hash) throw new Error("Cloud video checkpoint URL must be HTTPS without embedded credentials.");
  const origin = base.origin;

  async function request(path, { method = "GET", body = null, prefer = "return=representation" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        apikey: serviceRoleKey, authorization: "Bearer " + serviceRoleKey,
        "accept-profile": SCHEMA, "content-profile": SCHEMA,
        accept: "application/json", prefer
      };
      if (body !== null) headers["content-type"] = "application/json";
      const response = await fetchImpl(origin + "/rest/v1/" + path, {
        method, headers, ...(body === null ? {} : { body: JSON.stringify(body) }), signal: controller.signal
      });
      const raw = await response.text();
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch { throw fail("Cloud checkpoint service returned invalid JSON.", "CLOUD_CHECKPOINT_INVALID_RESPONSE"); } }
      if (!response.ok) throw fail("Cloud checkpoint request failed (HTTP " + response.status + ").", "CLOUD_CHECKPOINT_HTTP_ERROR");
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("Cloud checkpoint request timed out.", "CLOUD_CHECKPOINT_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }

  function validateScope(ownerId, projectId) {
    if (!UUID.test(ownerId || "") || !UUID.test(projectId || "")) throw fail("Authenticated owner and project UUIDs are required.", "CLOUD_CHECKPOINT_SCOPE_INVALID");
  }
  function map(row) {
    let outputAsset;
    try { outputAsset = row.output_json; if (typeof outputAsset === "string") outputAsset = JSON.parse(outputAsset); }
    catch { throw fail("Stored cloud checkpoint is corrupt.", "CLOUD_CHECKPOINT_CORRUPT"); }
    if (!plain(outputAsset)) throw fail("Stored cloud checkpoint output is invalid.", "CLOUD_CHECKPOINT_CORRUPT");
    return {
      pipelineId: row.pipeline_id, stepId: row.step_id, status: row.status,
      inputAssetId: row.input_asset_id, inputSha256: row.input_sha256,
      idempotencyKey: row.idempotency_key, outputAsset, approvalId: row.approval_id,
      createdAt: row.created_at
    };
  }
  const filters = ({ ownerId, projectId, pipelineId, stepId }) =>
    "owner_id=eq." + encodeURIComponent(ownerId) +
    "&project_id=eq." + encodeURIComponent(projectId) +
    "&pipeline_id=eq." + encodeURIComponent(pipelineId) +
    "&step_id=eq." + encodeURIComponent(stepId);

  return Object.freeze({
    async get({ ownerId, projectId, pipelineId, stepId }) {
      validateScope(ownerId, projectId);
      if (typeof pipelineId !== "string" || !pipelineId.trim() || pipelineId.length > 160 || typeof stepId !== "string" || !stepId.trim() || stepId.length > 120) throw fail("Pipeline and step IDs are invalid.", "CLOUD_CHECKPOINT_INVALID");
      const rows = await request("video_pipeline_checkpoints?select=owner_id,project_id,pipeline_id,step_id,status,input_asset_id,input_sha256,idempotency_key,output_json,approval_id,created_at&" + filters({ ownerId, projectId, pipelineId, stepId }) + "&limit=2");
      if (!Array.isArray(rows) || rows.length > 1) throw fail("Cloud checkpoint lookup returned an invalid result.", "CLOUD_CHECKPOINT_INVALID_RESPONSE");
      if (!rows.length || rows[0].owner_id !== ownerId || rows[0].project_id !== projectId) return null;
      return map(rows[0]);
    },
    async save({ ownerId, projectId, record }) {
      validateScope(ownerId, projectId);
      if (!plain(record) || typeof record.pipelineId !== "string" || !record.pipelineId.trim() || record.pipelineId.length > 160 ||
          typeof record.stepId !== "string" || !record.stepId.trim() || record.stepId.length > 120 ||
          record.status !== "succeeded" || !UUID.test(record.inputAssetId || "") ||
          !SHA256.test(record.inputSha256 || "") || !SHA256.test(record.idempotencyKey || "") ||
          !plain(record.outputAsset) || !UUID.test(record.outputAsset.id || "") ||
          !UUID.test(record.outputAsset.derivativeOf || "") || record.outputAsset.derivativeOf !== record.inputAssetId ||
          typeof record.outputAsset.mediaType !== "string" || !record.outputAsset.mediaType.startsWith("video/") ||
          !SHA256.test(record.outputAsset.sha256 || "")) throw fail("Cloud checkpoint receipt is invalid.", "CLOUD_CHECKPOINT_INVALID");
      const outputJson = JSON.stringify(record.outputAsset);
      if (!outputJson || Buffer.byteLength(outputJson) > 32000) throw fail("Cloud checkpoint output exceeds 32 KB.", "CLOUD_CHECKPOINT_INVALID");
      await request("video_pipeline_checkpoints", {
        method: "POST",
        prefer: "resolution=ignore-duplicates,return=minimal",
        body: {
          owner_id: ownerId, project_id: projectId, pipeline_id: record.pipelineId, step_id: record.stepId,
          status: "succeeded", input_asset_id: record.inputAssetId,
          input_sha256: record.inputSha256.toLowerCase(), idempotency_key: record.idempotencyKey.toLowerCase(),
          output_json: record.outputAsset, approval_id: record.approvalId || null
        }
      });
      const stored = await this.get({ ownerId, projectId, pipelineId: record.pipelineId, stepId: record.stepId });
      if (!stored || stored.idempotencyKey !== record.idempotencyKey.toLowerCase() ||
          stored.inputAssetId !== record.inputAssetId || stored.inputSha256 !== record.inputSha256.toLowerCase() ||
          stable(stored.outputAsset) !== stable(record.outputAsset) || stored.approvalId !== (record.approvalId || null)) {
        throw fail("A conflicting cloud checkpoint already exists for this pipeline step.", "CLOUD_CHECKPOINT_CONFLICT");
      }
      return stored;
    }
  });
}
