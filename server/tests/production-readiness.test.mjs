import test from "node:test";
import assert from "node:assert/strict";
import { buildProductionReadinessReport } from "../../src/core/production-readiness.ts";

test("missing evidence remains not-run and prevents a ready decision", () => {
  const report = buildProductionReadinessReport();
  assert.equal(report.decision, "review_required");
  assert.equal(report.counts.notRun, 9);
  assert.equal(report.policy.allRequiredChecksPassed, false);
  assert.equal(report.policy.humanApprovalGranted, false);
  assert.ok(report.checks.every(check => check.status === "not_run"));
});

test("all nine evidence-backed checks can reach human-approval readiness only", () => {
  const checks = Object.fromEntries([
    "sequence", "source_media", "derivative_integrity", "shot_capability", "continuity",
    "rights", "captions", "audio", "delivery",
  ].map(id => [id, { status: "passed", summary: id + " verified", evidenceRef: "evidence:" + id }]));
  const report = buildProductionReadinessReport({ checks });
  assert.equal(report.decision, "ready_for_human_approval");
  assert.equal(report.counts.passed, 9);
  assert.equal(report.policy.humanApprovalGranted, false);
  assert.equal(report.policy.mediaRendered, false);
  assert.equal(report.policy.providerSubmitted, false);
});

test("a blocker dominates review and passed checks", () => {
  const report = buildProductionReadinessReport({ checks: {
    sequence: { status: "passed", summary: "Sequence valid" },
    rights: { status: "blocked", summary: "Identity permission missing", findings: [{ code: "RIGHTS_REQUIRED", detail: "Presenter permission is not documented." }] },
    audio: { status: "review", summary: "Peak needs review" },
  }});
  assert.equal(report.decision, "blocked");
  assert.equal(report.counts.blocked, 1);
  assert.equal(report.counts.review, 1);
  assert.equal(report.counts.notRun, 6);
  assert.equal(report.checks.find(check => check.id === "rights")?.findings[0].code, "RIGHTS_REQUIRED");
});

test("trims untrusted evidence strings and does not infer a pass from an empty record", () => {
  const report = buildProductionReadinessReport({ checks: {
    delivery: { status: "passed", summary: "  Export preset verified  ", findings: [{ code: "x".repeat(100), detail: "d".repeat(1200) }] },
    rights: { status: "not_run", summary: " " },
  }});
  const delivery = report.checks.find(check => check.id === "delivery");
  const rights = report.checks.find(check => check.id === "rights");
  assert.equal(delivery.summary, "Export preset verified");
  assert.equal(delivery.findings[0].code.length, 80);
  assert.equal(delivery.findings[0].detail.length, 1000);
  assert.equal(rights.status, "not_run");
  assert.equal(rights.summary, "Not run — evidence is not available.");
});
