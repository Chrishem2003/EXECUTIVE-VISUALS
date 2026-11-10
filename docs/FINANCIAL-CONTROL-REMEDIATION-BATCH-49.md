# Financial Control Remediation & Assurance — Batch 49

## Delivered in this batch

This batch establishes a deterministic, typed domain engine for the next control-remediation workflow:

- Converts actionable governance findings into stable remediation work items; evidence gaps and unassessed controls are deliberately not presented as assigned remediation.
- Carries forward existing workflow state rather than resetting an owner's progress on refresh.
- Applies severity-based suggested due dates (critical 1 day, high 5, medium 15, low 30, unknown 14). These are defaults for human confirmation, not policy commitments.
- Enforces a constrained lifecycle: unassigned → open → in progress → pending review → verified, with explicit reopen handling.
- Requires evidence before review and distinct reviewer/approver/auditor identity plus evidence before verification.
- Tracks append-only transition history in the domain object, evidence metadata, verification identity and reopen count.
- Validates control-test samples and distinguishes failed, inconclusive and passing results.
- Summarizes overdue, critical, awaiting-review, reopened and aging exposure without treating a source-present control as independently effective.
- Validates access-certification rows and separates recommendations to retain/revoke/modify access from execution.

## Safety and assurance boundaries

- No transaction, journal, payment, subscription or account-access action is executed.
- No user, role or access-provider directory is queried; certification only evaluates supplied records.
- Evidence URIs/checksums are metadata supplied by the caller; this module does not fetch or cryptographically validate evidence bytes.
- The in-memory domain engine is not a durable persistence layer. API authorization, database migrations, audit-ledger integration, browser UI, staging QA and end-to-end persistence are explicit follow-on gates before this workflow is presented as production-ready.
- A remediation item may be verified only by an independent actor with evidence. The caller must additionally enforce authenticated identity and authorization at the API boundary.

## Verification

Run:

```bash
npm run verify:control-remediation
npm run typecheck
```

The batch test covers stable register generation, state preservation, evidence gating, independent verification, invalid transitions, overdue risk summaries, control-test validation and access-certification separation.

## Release status

Implementation is delivered on an isolated feature branch for review. It is not merged or deployed. Do not interpret these domain tests as browser, database, staging or production verification.
