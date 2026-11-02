import test from "node:test";
import assert from "node:assert/strict";
import { buildTransformationReadinessReport } from "../transformation-readiness.mjs";

const allReady = {
  adapterVerified: true,
  workerAvailable: true,
  privateStorageVerified: true,
  durableCheckpointsAvailable: true,
  costPolicyVerified: true,
  consentVerifierAvailable: true,
  visualQaAvailable: true,
  cloudSchemaApplied: true
};

test("transformation readiness fails closed when no verified release evidence is supplied", () => {
  const report = buildTransformationReadinessReport();
  assert.equal(report.status, "blocked");
  assert.equal(report.canSubmit, false);
  assert.equal(report.gates.length, 8);
  assert.equal(report.missing.length, 8);
});

test("transformation readiness requires every gate to be explicitly true", () => {
  const report = buildTransformationReadinessReport({ ...allReady, visualQaAvailable: "yes" });
  assert.equal(report.canSubmit, false);
  assert.deepEqual(report.missing.map(item => item.key), ["visualQaAvailable"]);
});

test("transformation readiness opens only when all eight release gates pass", () => {
  const report = buildTransformationReadinessReport(allReady);
  assert.equal(report.status, "ready");
  assert.equal(report.canSubmit, true);
  assert.deepEqual(report.missing, []);
});
