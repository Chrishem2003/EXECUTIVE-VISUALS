# Remediation Audit Integrity Export — Batch 56

## Delivered

- Adds authenticated `GET /api/finance/remediations/:id/audit-export`.
- Reuses the existing action visibility rules: project membership/access is rechecked, and personal records are owner-only.
- Exports the remediation snapshot, review history, audit-event metadata and evidence metadata (including stored SHA-256 values), without exporting evidence file bytes, credentials, session identifiers or private download URLs.
- Computes a SHA-256 digest over the exact UTF-8 `JSON.stringify(payload)` representation and includes counts for history, audit events and evidence.
- Adds an offline verifier: `node scripts/verify-remediation-audit-export.mjs <export.json>`.
- Adds an in-product per-action export control and regression coverage for access denial, digest verification, payload tampering and manifest-count tampering.
- Adds the verifier test to the remediation GitHub Actions workflow.

## Integrity semantics and limitations

This is a **post-export integrity check**, not a digital signature and not a tamper-proof source-of-truth ledger.

The verifier detects changes to an export when compared with its embedded digest and manifest counts. Anyone who can replace both the payload and digest can produce a new internally consistent export. It does not prove who created the export, when the underlying event occurred, that a database record was never changed before export, or that records were not deleted before export.

For stronger assurance, preserve the downloaded export and digest in a separately controlled, append-only or write-once destination. A future signed export requires a managed signing key, key rotation/revocation and independent custody. No key or new storage service is configured by this batch.

The export is a point-in-time snapshot. It includes action history and related audit events available at export time. It does not include raw evidence file bytes. Evidence SHA-256 values are copied from stored asset metadata and are not recalculated from the original file during export.

## Security

- Export access is scoped to the same authorized action visibility as the remediation detail route.
- Export metadata is bounded by one remediation record; no bulk account-wide audit dump is introduced.
- The UI downloads a JSON document; the offline verifier reports digest and record-count consistency.
- No database migration, schema change, new paid infrastructure, billing, payment, journal, subscription or entitlement change is included.

OWASP recommends protecting log integrity, restricting access, detecting tampering and validating logging functionality in tests: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html.

## Verification

GitHub Actions runs:
- `npm run verify:control-remediation-api`
- `npm run verify:control-remediation`
- `npm run verify:remediation-audit-export`
- `node --check server/control-remediation-api.mjs`
- `node --check scripts/verify-remediation-audit-export.mjs`
- `npm run typecheck`

No CI pass is claimed until the branch workflow completes.

## Release boundary

Branch: `feat/audit-integrity-export-batch-56`, stacked on Batch 55.

Draft PR only. No merge, production deployment, database migration, new paid infrastructure, production configuration changes, automated notifications, automatic reassignment or scheduler activation.
