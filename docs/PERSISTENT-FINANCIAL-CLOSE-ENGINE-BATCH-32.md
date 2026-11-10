# Batch 32 — Persistent Financial Close Execution & Approval Engine

## Delivered

Batch 32 turns the prior read-only close-readiness assessment into a persistent workflow for accounting periods and close tasks.

- Durable accounting periods scoped by account and YYYY-MM period.
- Named task assignees and ordered independent approvers (1–5).
- Task dependencies that must be approved or waived before work can start or be submitted.
- Evidence-reference requirements before task submission.
- Multi-level task approval with comments and explicit rejection/rework cycles.
- Reason-required task waivers and period reopening.
- Period submission, independent final approval, locking and controlled reopening.
- Versioned records and append-only approval history.
- Every successful state transition is committed in the same PostgreSQL transaction as its financial audit event.

## API

### Read periods and tasks

\`GET /api/admin/finance/close/periods\`

Optional query: \`period=YYYY-MM\`.

### Execute a command

\`POST /api/admin/finance/close/periods\`

Example:

\`\`\`json
{
  "action": "period.open",
  "period": "2026-10",
  "idempotencyKey": "close-open-2026-10",
  "payload": {
    "currency": "UGX",
    "label": "October close"
  }
}
\`\`\`

Supported actions:

- \`period.open\`
- \`task.create\`
- \`task.assign\`
- \`task.start\`
- \`task.submit\`
- \`task.approve\`
- \`task.reject\`
- \`task.waive\`
- \`period.submit\`
- \`period.approve\`
- \`period.lock\`
- \`period.reopen\`

## Control model

- A task assignee cannot be one of its approvers.
- Approvers are processed in configured order; all levels must approve.
- Task submission requires at least one evidence reference.
- Dependencies must be approved or waived before a dependent task can start or submit.
- Rejection preserves the prior approval record and starts a fresh approval cycle on resubmission.
- A close period cannot be submitted until every task is approved or explicitly waived with a reason.
- The period submitter cannot approve their own close.
- A period can only be locked after final approval.
- Reopening a locked period requires a reason and is itself audited.
- API operations require an authenticated finance administrator role. Database tables are not directly writable by application roles; the service-role RPC performs validated transitions.

## Atomicity and audit

The server prepares the versioned canonical audit event, then calls one PostgreSQL function. That function appends the hash-chained event and applies the close state transition in one database transaction. A failed transition rolls back the audit append; an idempotent retry does not apply the state change twice. Concurrent head changes fail closed and must be retried with a fresh audit head.

## Boundaries

- This engine manages close workflow state; it does not create or post journal entries, execute payments, alter invoices, or certify financial statements.
- Evidence references are recorded but source-file bytes are not fetched or cryptographically re-hashed by this workflow.
- Period locking is an application-level close control, not a lock on every underlying revenue, payment or cost source table.
- Task and period changes require a finance administrator in the current API; finer-grained preparer/reviewer product roles and delegated authority are future work.
- Final approval is distinct from the submitter; the task workflow supports multiple ordered reviewers.
- A close readiness assessment remains a separate evidence/reconciliation assessment. This engine does not silently infer reconciliation completion from a task status.

## Validation

- Unit tests cover command validation, period/currency shape, reviewer separation, evidence requirements and action taxonomy.
- API tests cover admin authorization, account scoping, atomic RPC envelope construction and rejection before database writes.
- PostgreSQL integration tests exercise idempotency, rollback of failed transitions, dependencies, evidence-backed submissions, multi-level approval, rejection/rework, independent period approval, lock and reopen.
- No production migration or deployment is performed by this pull request.
