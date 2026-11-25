import test from "node:test";
import assert from "node:assert/strict";
import {
  FULLY_LOADED_COST_CATEGORIES,
  buildFullyLoadedShotCostEvidence,
  buildFullyLoadedProductionCostEvidence
} from "../fully-loaded-cost-evidence.mjs";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const maxAgeSeconds = 2_592_000;
const sourceByCategory = {
  compute: "resource_metering_event",
  storage: "resource_metering_event",
  egress: "resource_metering_event",
  payment_processing: "payment_settlement_fee",
  moderation: "invoice_cost_attribution",
  retry_allowance: "invoice_cost_attribution",
  tax: "invoice_cost_attribution",
  refund_reserve: "approved_reserve_policy",
  support: "support_allocation_ledger"
};
function fixture(shotId = "shot-001") {
  return FULLY_LOADED_COST_CATEGORIES.map((category, index) => ({
    category, shotId, currency: "USD", amountMicros: (index + 1) * 100,
    sourceKind: sourceByCategory[category],
    sourceRecordId: "source-record-" + (index + 1),
    sourceDigest: String(index + 1).padStart(64, "0"),
    immutable: true, verified: true, zeroCostEvidence: false,
    observedAt: "2026-11-24T12:00:00.000Z",
    expiresAt: "2026-12-01T12:00:00.000Z"
  }));
}
function evaluate(rows = fixture(), shotId = "shot-001") {
  return buildFullyLoadedShotCostEvidence({
    shotId, currency: "USD", evidenceRows: rows, now, maxAgeSeconds
  });
}

test("verifies exactly nine same-currency immutable cost categories for one shot", () => {
  const result = evaluate();
  assert.equal(result.ready, true);
  assert.equal(result.additionalCostEvidence.status, "verified");
  assert.equal(result.additionalCostEvidence.additionalCostMicros, 4_500);
  assert.deepEqual(result.additionalCostEvidence.coveredCategories, [...FULLY_LOADED_COST_CATEGORIES]);
  assert.equal(result.breakdown.length, 9);
  assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.additionalCostEvidence.evidenceSha256, result.evidenceSha256);
});

test("canonical evidence digest is stable regardless of input row order", () => {
  const rows = fixture();
  const first = evaluate(rows);
  const second = evaluate([...rows].reverse());
  assert.equal(first.evidenceSha256, second.evidenceSha256);
});

test("blocks missing categories and duplicate category allocations", () => {
  assert.equal(evaluate(fixture().slice(0, 8)).code, "FULLY_LOADED_COST_COVERAGE_INCOMPLETE");
  const rows = fixture();
  rows[8] = { ...rows[0], sourceRecordId: "different-record" };
  assert.equal(evaluate(rows).code, "FULLY_LOADED_COST_CATEGORY_DUPLICATE");
});

test("blocks double counting one immutable source record across categories", () => {
  const rows = fixture();
  rows[1].sourceRecordId = rows[0].sourceRecordId;
  assert.equal(evaluate(rows).code, "FULLY_LOADED_COST_SOURCE_DOUBLE_COUNT");
});

test("blocks untrusted source types, mutable records and missing source digests", () => {
  const wrongSource = fixture();
  wrongSource[0].sourceKind = "operator_estimate";
  assert.equal(evaluate(wrongSource).code, "FULLY_LOADED_COST_SOURCE_UNTRUSTED");
  const mutable = fixture();
  mutable[0].immutable = false;
  assert.equal(evaluate(mutable).code, "FULLY_LOADED_COST_PROVENANCE_INVALID");
  const noDigest = fixture();
  noDigest[0].sourceDigest = "not-a-digest";
  assert.equal(evaluate(noDigest).code, "FULLY_LOADED_COST_PROVENANCE_INVALID");
});

test("requires explicit proof for zero-cost categories", () => {
  const rows = fixture();
  rows[0].amountMicros = 0;
  rows[0].zeroCostEvidence = false;
  assert.equal(evaluate(rows).code, "FULLY_LOADED_COST_AMOUNT_INVALID");
  rows[0].zeroCostEvidence = true;
  assert.equal(evaluate(rows).ready, true);
  assert.equal(evaluate(rows).breakdown[0].zeroCostEvidence, true);
});

test("blocks stale, future-dated and expired category evidence", () => {
  const stale = fixture();
  stale[0].observedAt = "2026-09-01T00:00:00.000Z";
  assert.equal(evaluate(stale).code, "FULLY_LOADED_COST_EVIDENCE_STALE");
  const future = fixture();
  future[0].observedAt = "2026-11-26T00:00:00.000Z";
  assert.equal(evaluate(future).code, "FULLY_LOADED_COST_EVIDENCE_STALE");
  const expired = fixture();
  expired[0].expiresAt = "2026-11-25T11:59:59.000Z";
  assert.equal(evaluate(expired).code, "FULLY_LOADED_COST_EVIDENCE_STALE");
});

test("requires exact shot identity and one currency", () => {
  const rows = fixture();
  rows[0].shotId = "another-shot";
  assert.equal(evaluate(rows).code, "FULLY_LOADED_COST_IDENTITY_MISMATCH");
  const wrongCurrency = fixture();
  wrongCurrency[0].currency = "EUR";
  assert.equal(evaluate(wrongCurrency).code, "FULLY_LOADED_COST_IDENTITY_MISMATCH");
});

test("requires an explicit bounded freshness policy and safe integer amounts", () => {
  assert.equal(buildFullyLoadedShotCostEvidence({
    shotId: "shot-001", currency: "USD", evidenceRows: fixture(), now
  }).code, "FULLY_LOADED_COST_FRESHNESS_POLICY_INVALID");
  const overflow = fixture();
  overflow[0].amountMicros = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(evaluate(overflow).code, "FULLY_LOADED_COST_AMOUNT_INVALID");
});

test("production evidence blocks the entire production when any shot is incomplete", () => {
  const result = buildFullyLoadedProductionCostEvidence({
    shots: [
      { shotId: "shot-001", currency: "USD", evidenceRows: fixture("shot-001") },
      { shotId: "shot-002", currency: "USD", evidenceRows: fixture("shot-002").slice(0, 8) }
    ],
    now, maxAgeSeconds
  });
  assert.equal(result.ready, false);
  assert.equal(result.blockedShotId, "shot-002");
});

test("production evidence preserves shot-level costs and rejects mixed currencies or duplicate IDs", () => {
  const rows = buildFullyLoadedProductionCostEvidence({
    shots: [
      { shotId: "shot-001", currency: "USD", evidenceRows: fixture("shot-001") },
      { shotId: "shot-002", currency: "USD", evidenceRows: fixture("shot-002") }
    ],
    now, maxAgeSeconds
  });
  assert.equal(rows.ready, true);
  assert.equal(rows.shotCount, 2);
  assert.equal(rows.additionalCostEvidenceByShot.length, 2);
  assert.equal(rows.additionalCostEvidenceByShot[0].additionalCostMicros, 4_500);
  const mixed = buildFullyLoadedProductionCostEvidence({
    shots: [
      { shotId: "shot-001", currency: "USD", evidenceRows: fixture("shot-001") },
      { shotId: "shot-002", currency: "EUR", evidenceRows: fixture("shot-002").map(row => ({ ...row, currency: "EUR" })) }
    ],
    now, maxAgeSeconds
  });
  assert.equal(mixed.code, "FULLY_LOADED_COST_CURRENCY_MISMATCH");
  const duplicate = buildFullyLoadedProductionCostEvidence({
    shots: [
      { shotId: "shot-001", currency: "USD", evidenceRows: fixture("shot-001") },
      { shotId: "shot-001", currency: "USD", evidenceRows: fixture("shot-001") }
    ],
    now, maxAgeSeconds
  });
  assert.equal(duplicate.code, "FULLY_LOADED_COST_SHOT_ID_INVALID");
});
