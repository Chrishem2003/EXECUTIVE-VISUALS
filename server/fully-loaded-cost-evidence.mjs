import { createHash } from "node:crypto";

export const FULLY_LOADED_COST_CATEGORIES = Object.freeze([
  "compute",
  "storage",
  "egress",
  "payment_processing",
  "moderation",
  "retry_allowance",
  "tax",
  "refund_reserve",
  "support"
]);

const HASH = /^[a-f0-9]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_ROWS = 9;
const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const fail = (code, reason) => Object.freeze({ ready: false, code, reason });
const isoTime = value => {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
};
const clean = value => typeof value === "string" ? value.trim() : "";

const SOURCE_BY_CATEGORY = Object.freeze({
  compute: new Set(["resource_metering_event", "invoice_cost_attribution"]),
  storage: new Set(["resource_metering_event", "invoice_cost_attribution"]),
  egress: new Set(["resource_metering_event", "invoice_cost_attribution"]),
  payment_processing: new Set(["payment_settlement_fee"]),
  moderation: new Set(["invoice_cost_attribution"]),
  retry_allowance: new Set(["invoice_cost_attribution"]),
  tax: new Set(["invoice_cost_attribution"]),
  refund_reserve: new Set(["approved_reserve_policy"]),
  support: new Set(["support_allocation_ledger"])
});

function normalizeEvidence(row, shotId, currency, now, maxAgeSeconds) {
  const category = clean(row?.category);
  if (!FULLY_LOADED_COST_CATEGORIES.includes(category)) {
    return { error: "FULLY_LOADED_COST_CATEGORY_INVALID", reason: "A required cost category is missing or unsupported." };
  }
  if (clean(row?.shotId) !== shotId || String(row?.currency || "").toUpperCase() !== currency) {
    return { error: "FULLY_LOADED_COST_IDENTITY_MISMATCH", reason: "Every cost record must match the exact shot and currency." };
  }
  const sourceKind = clean(row?.sourceKind);
  if (!SOURCE_BY_CATEGORY[category].has(sourceKind)) {
    return { error: "FULLY_LOADED_COST_SOURCE_UNTRUSTED", reason: "The evidence source is not approved for this cost category." };
  }
  const sourceRecordId = clean(row?.sourceRecordId);
  const sourceDigest = clean(row?.sourceDigest).toLowerCase();
  if (!sourceRecordId || sourceRecordId.length > 240 || !HASH.test(sourceDigest) || row?.immutable !== true || row?.verified !== true) {
    return { error: "FULLY_LOADED_COST_PROVENANCE_INVALID", reason: "Cost evidence must identify an immutable, verified source record and its SHA-256 digest." };
  }
  const amountMicros = row?.amountMicros;
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || amountMicros > MAX_MINOR ||
      row?.zeroCostEvidence !== (amountMicros === 0)) {
    return { error: "FULLY_LOADED_COST_AMOUNT_INVALID", reason: "Each cost amount must be a non-negative safe integer; zero requires explicit zero-cost evidence." };
  }
  const observedAt = isoTime(row?.observedAt);
  const expiresAt = isoTime(row?.expiresAt);
  if (observedAt === null || expiresAt === null || observedAt > now + 30_000 ||
      now - observedAt > maxAgeSeconds * 1000 || expiresAt <= now || expiresAt <= observedAt) {
    return { error: "FULLY_LOADED_COST_EVIDENCE_STALE", reason: "Cost evidence is missing, future-dated, stale or expired." };
  }
  return {
    value: Object.freeze({
      category, shotId, currency, amountMicros, sourceKind, sourceRecordId,
      sourceDigest, observedAt: new Date(observedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(), zeroCostEvidence: amountMicros === 0
    })
  };
}

/**
 * Validate the nine-category, same-currency fully-loaded variable-cost model
 * for one exact shot. This is a contract validator, not a database trust
 * boundary: only a server-side adapter that has independently loaded and
 * verified immutable source records may call it. Browser-supplied evidence
 * must never be passed to this function.
 */
export function buildFullyLoadedShotCostEvidence({
  shotId, currency, evidenceRows = [], now = Date.now(), maxAgeSeconds
} = {}) {
  const id = clean(shotId);
  const curr = String(currency || "").toUpperCase();
  if (!id || id.length > 180 || !CURRENCY.test(curr)) {
    return fail("FULLY_LOADED_COST_INPUT_INVALID", "A valid shot ID and ISO 4217 currency are required.");
  }
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 3600 || maxAgeSeconds > 3_888_000) {
    return fail("FULLY_LOADED_COST_FRESHNESS_POLICY_INVALID", "An explicit cost-evidence freshness window between one hour and 45 days is required.");
  }
  if (!Array.isArray(evidenceRows) || evidenceRows.length !== MAX_ROWS) {
    return fail("FULLY_LOADED_COST_COVERAGE_INCOMPLETE", "Exactly one verified evidence record is required for each of the nine variable-cost categories.");
  }
  const byCategory = new Map();
  const sourceIds = new Set();
  const normalizedRows = [];
  for (const row of evidenceRows) {
    const normalized = normalizeEvidence(row, id, curr, now, maxAgeSeconds);
    if (normalized.error) return fail(normalized.error, normalized.reason);
    const item = normalized.value;
    if (byCategory.has(item.category)) {
      return fail("FULLY_LOADED_COST_CATEGORY_DUPLICATE", "A cost category must have exactly one reconciled allocation per shot.");
    }
    if (sourceIds.has(item.sourceRecordId)) {
      return fail("FULLY_LOADED_COST_SOURCE_DOUBLE_COUNT", "One immutable source record cannot be counted in multiple cost categories.");
    }
    byCategory.set(item.category, item);
    sourceIds.add(item.sourceRecordId);
    normalizedRows.push(item);
  }
  if (FULLY_LOADED_COST_CATEGORIES.some(category => !byCategory.has(category))) {
    return fail("FULLY_LOADED_COST_COVERAGE_INCOMPLETE", "At least one required variable-cost category has no verified evidence.");
  }
  normalizedRows.sort((a, b) => FULLY_LOADED_COST_CATEGORIES.indexOf(a.category) - FULLY_LOADED_COST_CATEGORIES.indexOf(b.category));
  const total = normalizedRows.reduce((sum, row) => sum + row.amountMicros, 0);
  if (!Number.isSafeInteger(total)) {
    return fail("FULLY_LOADED_COST_OVERFLOW", "Fully-loaded variable cost exceeds safe integer precision.");
  }
  const canonical = JSON.stringify({
    version: "fully-loaded-shot-cost-v1", shotId: id, currency: curr,
    maxAgeSeconds, categories: normalizedRows
  });
  const evidenceSha256 = createHash("sha256").update(canonical).digest("hex");
  const evidenceReference = "fully-loaded-cost:v1:" + evidenceSha256;
  return Object.freeze({
    ready: true, shotId: id, currency: curr,
    additionalCostEvidence: Object.freeze({
      status: "verified", currency: curr, additionalCostMicros: total,
      evidenceSha256, evidenceReference,
      coveredCategories: Object.freeze([...FULLY_LOADED_COST_CATEGORIES])
    }),
    breakdown: Object.freeze(normalizedRows.map(row => Object.freeze({
      category: row.category, amountMicros: row.amountMicros,
      sourceKind: row.sourceKind, sourceRecordId: row.sourceRecordId,
      observedAt: row.observedAt, expiresAt: row.expiresAt,
      zeroCostEvidence: row.zeroCostEvidence
    }))),
    maxAgeSeconds, evidenceSha256, evidenceReference
  });
}

/**
 * Build per-shot cost evidence for a complete production. One blocked shot
 * blocks the entire production; costs are never blended across shots.
 */
export function buildFullyLoadedProductionCostEvidence({
  shots = [], now = Date.now(), maxAgeSeconds
} = {}) {
  if (!Array.isArray(shots) || shots.length < 1 || shots.length > 100) {
    return fail("FULLY_LOADED_COST_SHOT_SET_INVALID", "A production must contain between 1 and 100 shots.");
  }
  const seen = new Set();
  const results = [];
  for (const shot of shots) {
    const shotId = clean(shot?.shotId);
    if (!shotId || seen.has(shotId)) {
      return fail("FULLY_LOADED_COST_SHOT_ID_INVALID", "Every production shot must have a unique stable ID.");
    }
    seen.add(shotId);
    const result = buildFullyLoadedShotCostEvidence({
      shotId, currency: shot.currency, evidenceRows: shot.evidenceRows,
      now, maxAgeSeconds
    });
    if (result.ready !== true) {
      return Object.freeze({
        ready: false, code: result.code, reason: result.reason,
        blockedShotId: shotId, shotCount: shots.length
      });
    }
    results.push(result);
  }
  const currencies = new Set(results.map(row => row.currency));
  if (currencies.size !== 1) {
    return fail("FULLY_LOADED_COST_CURRENCY_MISMATCH", "Every shot in a production must use the same currency.");
  }
  return Object.freeze({
    ready: true, shotCount: results.length, currency: results[0].currency,
    additionalCostEvidenceByShot: Object.freeze(results.map(row => row.additionalCostEvidence)),
    shots: Object.freeze(results)
  });
}
