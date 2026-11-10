# Batch 34 — Forecast-to-Actual Cost Variance & Accepted-Output Economics

## Purpose

Close the Batch 27 feedback loop by comparing a forecast with source-evidenced actual cost lines after a workload completes. Measure cost per accepted deliverable, not merely per attempt.

## Delivered

- Deterministic comparison of a typed Batch 27 forecast with actual cost lines.
- Strict same-currency comparison; no implicit FX.
- Required unique source identifiers, source types, observed timestamps, evidence references and SHA-256 digests.
- Low/base/high forecast-range classification and signed minor-unit variance.
- Basis-point variance against forecast base cost.
- Accepted/rejected attempt counts, acceptance rate and actual cost per accepted output.
- Admin-only API: `POST /api/admin/finance/workload-variance`.
- In-memory analysis only: no ledger posting, invoice creation, customer plan change or provider routing.

## Evidence and accounting boundaries

- Supported actual source types: provider invoice, usage meter and infrastructure meter.
- The API validates supplied evidence metadata and digest shape; it does not independently retrieve private evidence bytes or recompute their hashes.
- A SHA-256 digest is an integrity reference, not proof of source authenticity.
- Actual cost lines must be supplied in the same currency as the forecast. Foreign currency lines are rejected rather than converted.
- The analysis does not overwrite forecast records or mutate the immutable cost ledger.
- A favourable variance is not automatically a reason to lower customer pricing; quality, utilization, support and shared overhead remain separate decisions.

## Validation

- Unit tests cover within-range, favourable and adverse outcomes, unit economics, duplicate source rejection, currency mismatch, invalid evidence and invalid forecast/output counts.
- The API delegates to the pure analysis module only after the existing finance administrator authorization check.

## Rollout

Draft PR only. No production migration, deployment, billing action, provider call or automatic routing change.
