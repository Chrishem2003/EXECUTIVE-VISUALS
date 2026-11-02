import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, rational } from "../../src/core/timeline.ts";
import { assessRightsEvidence } from "../../src/core/rights-evidence.ts";
const now = new Date("2026-11-02T12:00:00.000Z");
function timeline() {
  let value = createTimeline("p", "t", "Rights");
  value = addTrack(value, { id: "v", name: "Video", kind: "video", enabled: true, locked: false, clips: [] });
  return addClip(value, "v", { id: "c", assetId: "a", name: "Clip", sourceRange: { start: rational(0, 24), duration: rational(24, 24) }, timelineStart: rational(0, 24), duration: rational(24, 24), enabled: true });
}
const cleared = { id: "a", metadata: { rights: { status: "cleared", reference: "contract:123" } } };
test("no clips or missing attestations never pass", () => {
  assert.equal(assessRightsEvidence(null, [], now).status, "not_run");
  const report = assessRightsEvidence(timeline(), [], now);
  assert.equal(report.status, "not_run");
  assert.equal(report.findings[0].code, "RIGHTS_SOURCE_MISSING");
});
test("explicit rights clearance with a supporting reference passes", () => {
  assert.equal(assessRightsEvidence(timeline(), [cleared], now).status, "passed");
});
test("missing or incomplete clearance remains not-run", () => {
  const report = assessRightsEvidence(timeline(), [{ id: "a", metadata: { rights: { status: "cleared" } } }], now);
  assert.equal(report.status, "not_run");
  assert.equal(report.findings[0].code, "RIGHTS_CLEARANCE_INCOMPLETE");
});
test("denied, revoked and expired rights block", () => {
  for (const rights of [{ status: "denied", reference: "x" }, { status: "revoked", reference: "x" }, { status: "cleared", reference: "x", expiresAt: "2026-11-01T00:00:00Z" }]) {
    assert.equal(assessRightsEvidence(timeline(), [{ id: "a", metadata: { rights } }], now).status, "blocked");
  }
});
test("sources requiring subject consent need a separate granted attestation", () => {
  const noConsent = assessRightsEvidence(timeline(), [{ id: "a", metadata: { rights: { status: "cleared", reference: "contract:123", requiresSubjectConsent: true } } }], now);
  assert.equal(noConsent.status, "not_run");
  assert.equal(noConsent.findings[0].code, "SUBJECT_CONSENT_INCOMPLETE");
  const granted = assessRightsEvidence(timeline(), [{ id: "a", metadata: { rights: { status: "cleared", reference: "contract:123", requiresSubjectConsent: true }, subjectConsent: { status: "granted", reference: "consent:456" } } }], now);
  assert.equal(granted.status, "passed");
});
test("denied or expired subject consent blocks", () => {
  for (const subjectConsent of [{ status: "denied", reference: "x" }, { status: "granted", reference: "x", expiresAt: "2026-11-01T00:00:00Z" }]) {
    const report = assessRightsEvidence(timeline(), [{ id: "a", metadata: { rights: { status: "cleared", reference: "contract:123", requiresSubjectConsent: true }, subjectConsent } }], now);
    assert.equal(report.status, "blocked");
  }
});
