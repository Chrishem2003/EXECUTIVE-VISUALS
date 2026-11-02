const GATES = Object.freeze([
  ["adapterVerified", "Verified transformation adapter", "A real adapter must pass its provider/model capability and output-integrity checks."],
  ["workerAvailable", "Asynchronous transformation worker", "A scoped worker must claim, heartbeat, retry and complete transformation jobs."],
  ["privateStorageVerified", "Private media storage", "Source and derivative media must use verified private object storage."],
  ["durableCheckpointsAvailable", "Durable pipeline checkpoints", "Every finishing stage must persist idempotent, owner/project-scoped checkpoints."],
  ["costPolicyVerified", "Cost and budget enforcement", "Every remote stage needs a known estimate, explicit approval and an enforced budget."],
  ["consentVerifierAvailable", "Rights and consent verification", "Source rights and any required identity/likeness consent must be independently verified."],
  ["visualQaAvailable", "Visual quality assurance", "Frame-level checks and a human review decision must be recorded before acceptance."],
  ["cloudSchemaApplied", "Isolated cloud schema ready", "The dedicated schema, RLS policies and private bucket must be applied and verified."]
]);

/**
 * Produces a truthful, fail-closed release gate report.
 * A gate passes only when its value is explicitly true; missing configuration
 * is never inferred from a feature flag, UI state, or a draft approval.
 */
export function buildTransformationReadinessReport(readiness = {}) {
  const gates = GATES.map(([key, label, detail]) => ({
    key,
    label,
    detail,
    ready: readiness?.[key] === true
  }));
  const missing = gates.filter(gate => !gate.ready);
  return Object.freeze({
    schemaVersion: 1,
    status: missing.length === 0 ? "ready" : "blocked",
    canSubmit: missing.length === 0,
    gates,
    missing: missing.map(({ key, label }) => ({ key, label }))
  });
}
