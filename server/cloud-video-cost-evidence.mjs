const SCHEMA = "executive_visuals";

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Cost evidence URL must be a valid absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Cost evidence URL must use HTTPS and must not contain credentials, query parameters or fragments.");
  }
  return url.origin;
}

/**
 * Reads only immutable, owner-reviewed evidence receipts. It never estimates,
 * aggregates provider usage, or promotes an estimate to actual spend.
 */
export function createCloudVideoCostEvidenceResolver({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!url || !serviceRoleKey) throw new Error("Cost evidence resolver requires server-side Supabase credentials.");
  if (typeof fetchImpl !== "function") throw new Error("Cost evidence resolver requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Cost evidence timeout is invalid.");
  const base = endpoint(url);

  return async function resolveActualCost({ job, providerTaskId, task } = {}) {
    if (!job?.id || !job?.owner_id || typeof providerTaskId !== "string" ||
        !providerTaskId.trim() || task?.status !== "succeeded") {
      throw Object.assign(new Error("A completed owned provider task is required for cost evidence lookup."), { code: "VIDEO_COST_EVIDENCE_LOOKUP_INVALID" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/rpc/get_video_generation_cost_evidence", {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: "Bearer " + serviceRoleKey,
          "content-type": "application/json",
          "accept-profile": SCHEMA,
          "content-profile": SCHEMA,
          accept: "application/json"
        },
        body: JSON.stringify({ p_job_id: job.id }),
        signal: controller.signal
      });
      const raw = await response.text();
      let rows = null;
      if (raw) {
        try { rows = JSON.parse(raw); }
        catch { throw new Error("Cost evidence service returned invalid JSON."); }
      }
      if (!response.ok) {
        const error = new Error("Cost evidence lookup failed (HTTP " + response.status + ").");
        error.code = "VIDEO_COST_EVIDENCE_LOOKUP_FAILED";
        throw error;
      }
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw Object.assign(new Error("No unique owner-reviewed cost evidence receipt exists."), { code: "VIDEO_BUDGET_COST_UNRESOLVED" });
      }
      const row = rows[0];
      if (row.job_id !== job.id || row.owner_id !== job.owner_id ||
          row.provider_task_id !== providerTaskId ||
          typeof row.actual_amount !== "string" && typeof row.actual_amount !== "number" ||
          !Number.isFinite(Number(row.actual_amount)) || Number(row.actual_amount) < 0 ||
          typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) ||
          typeof row.evidence_reference !== "string" || !row.evidence_reference.trim() ||
          typeof row.evidence_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.evidence_sha256) ||
          typeof row.reviewer_id !== "string" || !row.reviewer_id ||
          !["provider_invoice", "provider_export", "provider_portal", "provider_support"].includes(row.source_type) ||
          typeof row.reviewed_at !== "string" || !Number.isFinite(Date.parse(row.reviewed_at))) {
        throw Object.assign(new Error("Cost evidence receipt does not match the job and provider task."), { code: "VIDEO_BUDGET_COST_UNRESOLVED" });
      }
      return Object.freeze({
        amount: Number(row.actual_amount),
        currency: row.currency,
        evidenceReference: row.evidence_reference,
        evidenceSha256: row.evidence_sha256,
        reviewerId: row.reviewer_id,
        reviewedAt: row.reviewed_at,
        sourceType: row.source_type
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw Object.assign(new Error("Cost evidence lookup timed out."), { code: "VIDEO_COST_EVIDENCE_LOOKUP_TIMEOUT" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
