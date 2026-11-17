const API_ORIGIN = "https://api.dev.runwayml.com";
const API_VERSION = "2024-11-06";
const TOOL_BY_MODEL = Object.freeze({
  "veo3.1": "veo 3.1",
  "veo3.1_fast": "veo 3.1 fast"
});
const fail = (message, code) => Object.assign(new Error(message), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validTimestamp(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Reconcile a single Runway task against the linked workspace per-generation
 * usage ledger. The aggregate organization usage endpoint is not sufficient
 * for per-job settlement; this resolver requires the linked workspace usage
 * endpoint and exact provider task ID.
 */
export function createRunwayTaskActualCostResolver({
  apiKey = process.env.RUNWAY_API_KEY || process.env.RUNWAYML_API_SECRET,
  enabled = process.env.RUNWAY_WORKSPACE_USAGE_ENABLED === "true",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  now = () => new Date()
} = {}) {
  const key = String(apiKey || "").trim();
  if (enabled !== true) throw fail("Runway per-generation workspace usage is not enabled.", "RUNWAY_TASK_BILLING_DISABLED");
  if (!key) throw fail("Runway workspace usage requires a server-side API key.", "RUNWAY_TASK_BILLING_KEY_REQUIRED");
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw fail("Runway workspace usage client configuration is invalid.", "RUNWAY_TASK_BILLING_CONFIG_INVALID");
  }

  async function assertAvailable() {
    const end = validTimestamp(now());
    if (!end) throw fail("Runway workspace usage readiness check has an invalid clock.", "RUNWAY_TASK_BILLING_CONFIG_INVALID");
    const url = new URL(API_ORIGIN + "/v1/organization/webapp/usage");
    url.searchParams.set("from", new Date(end.getTime() - 86400000).toISOString());
    url.searchParams.set("to", new Date(end.getTime() + 60000).toISOString());
    url.searchParams.set("limit", "1");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: "Bearer " + key, "X-Runway-Version": API_VERSION, accept: "application/json" },
        signal: controller.signal, redirect: "error"
      });
    } catch (error) {
      throw fail(error?.name === "AbortError" ? "Runway workspace usage readiness check timed out." : "Runway workspace usage is unavailable.", "RUNWAY_TASK_BILLING_UNAVAILABLE");
    } finally { clearTimeout(timer); }
    if (response.status === 401 || response.status === 403) throw fail("Runway linked-workspace usage requires an authorized account link to the workspace.", "RUNWAY_TASK_BILLING_ENTERPRISE_REQUIRED");
    if (!response.ok) throw fail("Runway workspace usage readiness check failed (HTTP " + response.status + ").", "RUNWAY_TASK_BILLING_UNAVAILABLE");
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw fail("Runway workspace usage response exceeded 2 MiB.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
    let page;
    try { page = JSON.parse(raw); } catch { throw fail("Runway workspace usage returned invalid JSON.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID"); }
    if (!page || typeof page !== "object" || !Array.isArray(page.data) || page.data.length > 1 ||
        typeof page.hasMore !== "boolean" || (page.nextCursor !== null && typeof page.nextCursor !== "string") ||
        page.hasMore && !page.nextCursor) {
      throw fail("Runway workspace usage readiness response is malformed.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
    }
    return true;
  }

  const resolveRunwayTaskActualCost = async function({
    job, input, task, providerTaskId, submissionMetadata
  } = {}) {
    const model = input?.model || task?.model;
    const expectedTool = TOOL_BY_MODEL[model];
    if (input?.provider !== "runway" || task?.provider !== "runway" || task?.model !== model ||
        !expectedTool || typeof providerTaskId !== "string" || !UUID.test(providerTaskId) ||
        task?.taskId !== providerTaskId || task?.status !== "succeeded") {
      throw fail("Runway settlement requires the exact succeeded Veo task and model identity.", "RUNWAY_TASK_BILLING_INPUT_INVALID");
    }
    const submittedAt = validTimestamp(submissionMetadata?.submittedAt || job?.created_at || job?.createdAt);
    const current = validTimestamp(now());
    if (!submittedAt || !current || submittedAt.getTime() > current.getTime() + 300000 ||
        current.getTime() - submittedAt.getTime() > 90 * 86400000) {
      throw fail("Runway task settlement requires a submission timestamp within the last 90 days.", "RUNWAY_TASK_BILLING_TIMESTAMP_INVALID");
    }

    const from = new Date(submittedAt.getTime() - 5 * 60000).toISOString();
    const to = new Date(current.getTime() + 5 * 60000).toISOString();
    let cursor = null;
    let pages = 0;
    const transactions = new Map();
    let matchingTool = null;
    while (true) {
      if (++pages > 100) throw fail("Runway workspace usage pagination exceeded its safety limit.", "RUNWAY_TASK_BILLING_PAGINATION_LIMIT");
      const url = new URL(API_ORIGIN + "/v1/organization/webapp/usage");
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: "Bearer " + key, "X-Runway-Version": API_VERSION, accept: "application/json" },
          signal: controller.signal,
          redirect: "error"
        });
      } catch (error) {
        throw fail(error?.name === "AbortError" ? "Runway workspace usage lookup timed out." : "Runway workspace usage is unavailable.", "RUNWAY_TASK_BILLING_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) {
        throw fail("Runway linked-workspace usage requires an authorized Enterprise workspace connection.", "RUNWAY_TASK_BILLING_ENTERPRISE_REQUIRED");
      }
      if (response.status === 429 || response.status >= 500) {
        throw fail("Runway workspace usage is temporarily unavailable; keep the budget reservation unresolved.", "RUNWAY_TASK_BILLING_UNAVAILABLE");
      }
      if (!response.ok) throw fail("Runway workspace usage query failed (HTTP " + response.status + ").", "RUNWAY_TASK_BILLING_QUERY_FAILED");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw fail("Runway workspace usage response exceeded 2 MiB.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
      let page;
      try { page = JSON.parse(raw); } catch { throw fail("Runway workspace usage returned invalid JSON.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID"); }
      if (!page || typeof page !== "object" || !Array.isArray(page.data) || page.data.length > 100 ||
          typeof page.hasMore !== "boolean" || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
        throw fail("Runway workspace usage page is malformed.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
      }
      for (const row of page.data) {
        if (row?.taskId !== providerTaskId) continue;
        const timestamp = validTimestamp(row.timestamp);
        if (!timestamp || timestamp.getTime() < submittedAt.getTime() - 5 * 60000 || timestamp.getTime() > current.getTime() + 5 * 60000 ||
            typeof row.transactionId !== "string" || !row.transactionId.trim() || row.transactionId.length > 256 ||
            row.unit !== "credits" || row.type !== "charge" ||
            !Number.isSafeInteger(row.credits) || row.credits < 1 ||
            typeof row.tool !== "string" || row.tool.trim().toLowerCase() !== expectedTool) {
          throw fail("Runway usage row does not match the exact task, model, time window or credit schema.", "RUNWAY_TASK_BILLING_ROW_INVALID");
        }
        if (transactions.has(row.transactionId)) throw fail("Runway workspace usage repeated a transaction ID.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
        transactions.set(row.transactionId, { credits: row.credits, type: row.type });
        matchingTool = row.tool;
      }
      if (!page.hasMore) break;
      if (!page.nextCursor || page.nextCursor.length > 1000 || page.nextCursor === cursor) {
        throw fail("Runway workspace usage returned an invalid pagination cursor.", "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
      }
      cursor = page.nextCursor;
    }

    if (!transactions.size) throw fail("Runway has not reported per-generation credits for this task yet.", "RUNWAY_TASK_BILLING_NOT_SETTLED");
    const credits = [...transactions.values()].reduce((sum, row) => sum + row.credits, 0);
    if (!Number.isSafeInteger(credits) || credits < 1) throw fail("Runway task usage has no valid charge.", "RUNWAY_TASK_BILLING_ROW_INVALID");
    return Object.freeze({
      amount: Number((credits * 0.01).toFixed(2)),
      currency: "USD",
      evidenceReference: "runway-workspace-task-usage:" + providerTaskId + ":" + credits + "credits",
      creditsCharged: credits,
      transactionCount: transactions.size,
      model,
      providerTool: matchingTool
    });
  };
  resolveRunwayTaskActualCost.assertAvailable = assertAvailable;
  return resolveRunwayTaskActualCost;
}
