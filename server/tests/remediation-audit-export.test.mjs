import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyAuditExport } from "../../scripts/verify-remediation-audit-export.mjs";

function fixture() {
  const payload = {
    schemaVersion: 1,
    action: { id: "test-action", status: "pending_review" },
    history: [{ id: 1, event: "created" }],
    auditEvents: [{ id: 1, event: "control_remediation.created" }],
    evidence: [{ id: "evidence-1", sha256: "a".repeat(64) }]
  };
  const sha256 = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return {
    payload,
    integrity: {
      algorithm: "SHA-256",
      sha256,
      historyCount: payload.history.length,
      auditEventCount: payload.auditEvents.length,
      evidenceCount: payload.evidence.length
    }
  };
}

test("verifier accepts an intact SHA-256 audit export", () => {
  const result = verifyAuditExport(fixture());
  assert.equal(result.valid, true);
  assert.equal(result.historyCount, 1);
  assert.equal(result.auditEventCount, 1);
  assert.equal(result.evidenceCount, 1);
});

test("verifier detects altered payloads and manifest counts", () => {
  const alteredPayload = structuredClone(fixture());
  alteredPayload.payload.auditEvents[0].event = "tampered";
  assert.equal(verifyAuditExport(alteredPayload).valid, false);

  const alteredCount = structuredClone(fixture());
  alteredCount.integrity.evidenceCount += 1;
  assert.equal(verifyAuditExport(alteredCount).valid, false);
});

test("verifier rejects unsupported schemas and missing manifests", () => {
  assert.equal(verifyAuditExport({ payload: { schemaVersion: 99 }, integrity: {} }).valid, false);
  assert.equal(verifyAuditExport(null).valid, false);
});
