# Batch 33 — Persisted Reconciliations & Evidence-Backed Close Gates

## Scope

Batch 33 makes reconciliation a durable prerequisite for closing a financial period. The close overview now includes reconciliation rows, and the existing Financial Command Centre command workbench can record and review reconciliations.

## API

The existing administrator endpoint remains:

\`POST /api/admin/finance/close/commands\`

New commands:

- \`record_reconciliation\`: create or revise a period/account reconciliation while the period is open.
- \`review_reconciliation\`: independently approve or flag an exception while the period is in review.

A reconciliation stores the account key/name, currency, ledger and statement balances in integer minor units, computed variance, evidence reference, SHA-256 evidence manifest, preparer, assigned reviewer and review outcome.

## Hard close gate

A period cannot transition to \`locked\` unless:

1. At least one reconciliation exists for the period.
2. Every reconciliation is independently approved.
3. Every reconciliation has exactly zero variance.
4. The existing required-task and multi-reviewer approval gates also pass.

The database enforces this through a trigger on the period state transition, so the gate cannot be bypassed by calling the period command RPC directly.

## Separation of duties

- The preparer cannot be the assigned reconciliation reviewer.
- Only the assigned reviewer can approve or flag the reconciliation.
- Non-zero variance cannot be approved.
- An exception requires a reason and blocks period locking.
- Reconciliation changes after reopening are recorded as new audit events and reset the row to pending review.

## Integrity and limitations

- Ledger and statement balances use integer minor units to avoid floating-point rounding.
- The stored variance is a generated database value, not a client-supplied figure.
- Evidence references and SHA-256 manifests are retained in the database and audit trail.
- The current deployment does not retrieve private evidence bytes to independently recompute the SHA-256 digest. A supplied digest is not proof that the source document is authentic.
- The reconciliation register does not yet import bank feeds or accounting-platform statements automatically.
- No journal posting, payment execution, tax calculation or production migration is performed by this batch.

## Validation

The billing quality workflow applies the Batch 33 migration and runs the complete close lifecycle with a reviewed zero-variance reconciliation, reviewer reassignment, period reopening and relocking. It also verifies that a period with no reconciliation cannot be locked and that the failed lock's audit append rolls back. API tests cover administrator authorization and the dedicated reconciliation RPC route.


## Example command payloads

Record a bank reconciliation before submitting the period:

\`\`\`json
{
  "command": "record_reconciliation",
  "idempotencyKey": "recon-operating-bank-2026-11",
  "payload": {
    "periodId": "PERIOD_UUID",
    "reconciliationKey": "operating_bank",
    "accountName": "Operating bank",
    "currency": "UGX",
    "ledgerBalanceMinor": 100000,
    "statementBalanceMinor": 100000,
    "evidenceReference": "private://evidence/bank-statement",
    "evidenceSha256": "64-character-lowercase-hex-digest",
    "reviewerId": "REVIEWER_UUID"
  }
}
\`\`\`

After submission, the assigned reviewer independently records the decision:

\`\`\`json
{
  "command": "review_reconciliation",
  "idempotencyKey": "recon-operating-bank-review-2026-11",
  "payload": {
    "periodId": "PERIOD_UUID",
    "reconciliationId": "RECONCILIATION_UUID",
    "decision": "approved"
  }
}
\`\`\`

All identifiers are placeholders. Amounts are minor units, so the UI/API must not send floating-point major-unit values.
