# Batch 29 — Continuous Financial Close & Audit Intelligence

## Scope

Batch 29 introduces an administrator-only, deterministic, read-only close-readiness assessment for a supplied financial period. It consolidates task completion, independent review, reconciliation status and evidence references into one explainable assessment.

## API

`POST /api/admin/finance/close/readiness`

The route requires an authenticated owner, platform_admin or billing_admin and is subject to the existing financial API enablement gate.

### Request shape

```json
{
  "period": "2026-10",
  "asOf": "2026-11-04T10:00:00Z",
  "tasks": [
    {
      "taskId": "cash-reconciliation",
      "title": "Cash reconciliation",
      "ownerId": "preparer-user-id",
      "reviewerId": "independent-reviewer-user-id",
      "status": "completed",
      "dueAt": "2026-11-03T17:00:00Z",
      "completedAt": "2026-11-02T12:00:00Z",
      "evidenceRefs": ["bank-statement-oct"],
      "approval": {
        "preparedBy": "preparer-user-id",
        "approvedBy": "independent-reviewer-user-id",
        "approvedAt": "2026-11-02T14:00:00Z",
        "decision": "approved"
      }
    }
  ],
  "reconciliations": [
    {
      "reconciliationId": "cash-ledger",
      "status": "approved",
      "currency": "UGX",
      "varianceMinor": 0,
      "preparedBy": "preparer-user-id",
      "reviewedBy": "independent-reviewer-user-id",
      "evidenceRefs": ["bank-statement-oct"]
    }
  ],
  "evidence": [
    {
      "evidenceId": "bank-statement-oct",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sourceType": "bank_statement",
      "sourceReference": "statement-reference",
      "period": "2026-10",
      "recordedAt": "2026-11-01T10:00:00Z",
      "recordedBy": "preparer-user-id"
    }
  ]
}
```

### Rules

- Period uses `YYYY-MM`; evidence records must belong to that period.
- Tasks are bounded to 300, reconciliations to 500, and evidence records to 1,000.
- Task states are `not_started`, `in_progress`, `completed`, `blocked`, or `waived`.
- Completed tasks require a completion timestamp, preparer attestation, independent reviewer approval, supporting evidence and no self-approval.
- Attestation identities must match the assigned preparer and reviewer.
- Waived tasks require a recorded reason.
- Reconciliations in `open`, `variance`, or `rejected` state block sign-off eligibility.
- Reconciliations marked `matched` or `approved` require independent review and evidence.
- Reconciliation amounts use integer minor units; currencies are validated as three-letter ISO codes.
- Duplicate task, reconciliation and evidence identifiers fail closed.
- The evidence manifest is sorted and hashed deterministically with SHA-256 for reproducibility.

## Output and safety

- `eligible_for_human_signoff` means only that the supplied control population passed these readiness checks.
- The output never signs off or closes the period.
- It never locks accounting periods, drafts or posts journals, modifies ledgers, initiates payments, or persists the supplied evidence.
- Evidence SHA-256 values are format-checked and included in the deterministic manifest digest; this preview does not retrieve source files or independently recompute their hashes.
- No bank, payment-provider, ledger or storage integration is called by this batch.
- The assessment is not an audit opinion or statutory financial statement.

## Validation

Unit tests cover successful readiness, incomplete and overdue tasks, evidence gaps, self-approval, identity mismatches, invalid periods, duplicate identifiers, invalid currencies and amounts, and stable evidence digests. API tests cover admin authorization, the read-only contract, blocked assessments and human-signoff-only outcomes.

## Deployment

No database migration, production configuration change, production deployment or automatic financial action is included. This batch is proposed as a draft PR stacked on Batch 28 for CI and review.
