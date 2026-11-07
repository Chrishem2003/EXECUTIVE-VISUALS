const API_ORIGIN = "https://api.dev.runwayml.com";
const API_VERSION = "2024-11-06";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function validDate(value, label) {
  if (typeof value !== "string" || !DATE.test(value)) throw fail(label + " must be YYYY-MM-DD.", "RUNWAY_USAGE_DATE_INVALID");
  const parsed = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw fail(label + " is not a real UTC calendar date.", "RUNWAY_USAGE_DATE_INVALID");
  }
  return parsed;
}

export function validateRunwayUsageWindow({ startDate, beforeDate } = {}) {
  const start = validDate(startDate, "startDate");
  const before = validDate(beforeDate, "beforeDate");
  const days = (before.getTime() - start.getTime()) / 86400000;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw fail("Runway usage windows must be 1–90 days, with beforeDate exclusive.", "RUNWAY_USAGE_WINDOW_INVALID");
  }
  return Object.freeze({ startDate, beforeDate, days });
}

export function normalizeRunwayOrganizationUsage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.results)) {
    throw fail("Runway organization usage response is malformed.", "RUNWAY_USAGE_RESPONSE_INVALID", 502);
  }
  const totals = new Map();
  for (const day of payload.results) {
    const date = day?.date;
    validDate(date, "usage date");
    if (!Array.isArray(day.usedCredits)) throw fail("Runway usage day is missing usedCredits.", "RUNWAY_USAGE_RESPONSE_INVALID", 502);
    for (const item of day.usedCredits) {
      const model = typeof item?.model === "string" ? item.model.trim() : "";
      const amount = Number(item?.amount);
      if (!model || model.length > 128 || !Number.isSafeInteger(amount) || amount > 0) {
        throw fail("Runway usage entry contains an invalid model or credit amount.", "RUNWAY_USAGE_RESPONSE_INVALID", 502);
      }
      const key = date + "\u0000" + model;
      totals.set(key, (totals.get(key) || 0) - amount);
    }
  }
  return Object.freeze([...totals.entries()].map(([key, actualCredits]) => {
    const [date, model] = key.split("\u0000");
    return Object.freeze({ date, model, actualCredits });
  }).sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)));
}

export async function queryRunwayOrganizationUsage({
  apiKey = process.env.RUNWAY_API_KEY || process.env.RUNWAYML_API_SECRET,
  startDate,
  beforeDate,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  validateRunwayUsageWindow({ startDate, beforeDate });
  const key = String(apiKey || "").trim();
  if (!key) throw fail("Runway usage reconciliation requires a server-side API key.", "RUNWAY_USAGE_KEY_REQUIRED", 503);
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw fail("Runway usage client configuration is invalid.", "RUNWAY_USAGE_CONFIG_INVALID", 500);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(API_ORIGIN + "/v1/organization/usage", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "X-Runway-Version": API_VERSION,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ startDate, beforeDate }),
        signal: controller.signal,
        redirect: "error"
      });
    } catch (error) {
      throw fail(error?.name === "AbortError" ? "Runway usage query timed out." : "Runway usage service is temporarily unavailable.", "RUNWAY_USAGE_UNAVAILABLE", 503);
    }
    if (response.status === 401 || response.status === 403) throw fail("Runway API key is not authorized to query organization usage.", "RUNWAY_USAGE_ACCESS_DENIED", 403);
    if (response.status === 429) throw fail("Runway usage query was rate limited.", "RUNWAY_USAGE_RATE_LIMITED", 503);
    if (!response.ok) throw fail("Runway usage query failed (HTTP " + response.status + ").", "RUNWAY_USAGE_QUERY_FAILED", 503);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw fail("Runway usage response exceeded the 2 MB limit.", "RUNWAY_USAGE_RESPONSE_INVALID", 502);
    let payload;
    try { payload = raw ? JSON.parse(raw) : null; }
    catch { throw fail("Runway usage response was not valid JSON.", "RUNWAY_USAGE_RESPONSE_INVALID", 502); }
    const totals = normalizeRunwayOrganizationUsage(payload);
    if (totals.some(row => row.date < startDate || row.date >= beforeDate)) {
      throw fail("Runway usage response contains dates outside the requested window.", "RUNWAY_USAGE_RESPONSE_INVALID", 502);
    }
    return Object.freeze({
      window: Object.freeze({ startDate, beforeDate }),
      totals,
      evidenceType: "provider_daily_model_aggregate",
      settlementEligible: false
    });
  } finally {
    clearTimeout(timer);
  }
}

export function loadRunwayBillingEstimates(db, { startDate, beforeDate } = {}) {
  validateRunwayUsageWindow({ startDate, beforeDate });
  if (!db || typeof db.prepare !== "function") throw fail("Billing database is required for Runway reconciliation.", "RUNWAY_USAGE_DB_REQUIRED", 500);
  const rows = db.prepare(`
    SELECT substr(created_at,1,10) AS date,
      json_extract(metadata_json,'$.costEstimate.model') AS model,
      SUM(CASE
        WHEN json_extract(metadata_json,'$.costEstimate.providerCostCredits') IS NOT NULL
          THEN CAST(json_extract(metadata_json,'$.costEstimate.providerCostCredits') AS REAL)
        WHEN json_extract(metadata_json,'$.costEstimate.rawCostMicros') IS NOT NULL
          THEN CAST(json_extract(metadata_json,'$.costEstimate.rawCostMicros') AS REAL) / 10000.0
        ELSE 0 END) AS estimatedCredits,
      COUNT(*) AS jobCount
    FROM billing_credit_ledger
    WHERE event_type='generation_spend'
      AND json_extract(metadata_json,'$.costEstimate.provider')='runway'
      AND created_at >= ? AND created_at < ?
    GROUP BY substr(created_at,1,10), json_extract(metadata_json,'$.costEstimate.model')
    ORDER BY date, model
  `).all(startDate + "T00:00:00.000Z", beforeDate + "T00:00:00.000Z");
  return rows.map(row => Object.freeze({
    date: row.date,
    model: row.model,
    estimatedCredits: Number(row.estimatedCredits || 0),
    jobCount: Number(row.jobCount || 0)
  })).filter(row => row.model);
}

export function reconcileRunwayDailyUsage({ actualUsage = [], billingEstimates = [] } = {}) {
  if (!Array.isArray(actualUsage) || !Array.isArray(billingEstimates)) {
    throw fail("Runway reconciliation inputs must be arrays.", "RUNWAY_USAGE_INPUT_INVALID");
  }
  const map = new Map();
  for (const row of actualUsage) {
    validDate(row?.date, "actual usage date");
    const model = String(row?.model || "").trim();
    const credits = Number(row?.actualCredits);
    if (!model || !Number.isFinite(credits) || credits < 0) throw fail("Actual usage row is invalid.", "RUNWAY_USAGE_INPUT_INVALID");
    const key = row.date + "\u0000" + model;
    const current = map.get(key) || { date: row.date, model, actualCredits: 0, estimatedCredits: null, jobCount: 0 };
    current.actualCredits += credits;
    map.set(key, current);
  }
  for (const row of billingEstimates) {
    validDate(row?.date, "billing estimate date");
    const model = String(row?.model || "").trim();
    const credits = Number(row?.estimatedCredits);
    const jobCount = Number(row?.jobCount || 0);
    if (!model || !Number.isFinite(credits) || credits < 0 || !Number.isSafeInteger(jobCount) || jobCount < 0) {
      throw fail("Billing estimate row is invalid.", "RUNWAY_USAGE_INPUT_INVALID");
    }
    const key = row.date + "\u0000" + model;
    const current = map.get(key) || { date: row.date, model, actualCredits: null, estimatedCredits: 0, jobCount: 0 };
    current.estimatedCredits += credits;
    current.jobCount += jobCount;
    map.set(key, current);
  }
  return Object.freeze([...map.values()].map(row => {
    const matched = row.actualCredits !== null && row.estimatedCredits !== null;
    const varianceCredits = matched ? row.actualCredits - row.estimatedCredits : null;
    return Object.freeze({
      ...row,
      varianceCredits,
      variancePercent: matched && row.estimatedCredits > 0 ? Math.round(varianceCredits / row.estimatedCredits * 10000) / 100 : null,
      status: matched ? "aggregate_compared" : row.actualCredits === null ? "platform_estimate_only" : "provider_usage_only",
      evidenceType: "provider_daily_model_aggregate",
      settlementEligible: false
    });
  }).sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)));
}
