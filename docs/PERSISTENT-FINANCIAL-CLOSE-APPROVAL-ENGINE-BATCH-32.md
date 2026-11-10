# Batch 32 — Persistent Financial Close Execution & Multi-Level Approval

## What changed

Batch 32 introduces durable close-period, task and approval records in the \`executive_visuals\` schema. The close workbench in the Financial Command Centre calls server-side administrator APIs; browser clients never receive service-role database credentials.

### API

- \`GET /api/admin/finance/close?ownerId=<uuid>\` returns periods, tasks and approvals scoped to the requested account.
- \`POST /api/admin/finance/close/commands\` accepts a command, idempotency key and JSON payload.
- Supported commands: \`create_period\`, \`assign_task\`, \`complete_task\`, \`waive_task\`, \`submit_for_approval\`, \`record_approval\`, \`lock_period\`, \`reopen_period\`.

## Atomicity and audit

The command RPC appends the versioned financial audit event and performs the corresponding close-state mutation in one PostgreSQL transaction. If validation or a state transition fails, both the domain write and audit append roll back. Replayed idempotency keys return the original audit result without repeating the state mutation. Competing audit-head writes are rejected by the existing sequence/hash-head check and must be retried with a fresh head.

## Controls

- Period creation requires at least two distinct reviewer identities; the creator cannot be assigned as a reviewer.
- Required tasks must be completed with at least one evidence reference or explicitly waived with a reason before submission.
- Submission moves an open period to \`in_review\`.
- An approval can only be recorded by the assigned reviewer, and a preparer cannot approve their own period.
- Locking requires all required tasks to be completed/waived and every assigned approval stage to be approved by at least two distinct reviewers.
- Reopening a locked or in-review period requires a documented reason and resets approvals to pending.
- Pending approval stages can be reassigned while the period is open; the new reviewer must be distinct from the preparer and other stage reviewers.
- Close commands are administrator-only and all tables are inaccessible to anon/authenticated roles; access is through server-side service-role functions.

## Explicit limitations

- Evidence references are identifiers/URIs only; this workflow does not fetch or cryptographically validate the referenced file bytes.
- Reconciliation readiness is still a separate read-only assessment and must be connected to persisted reconciliation records before close locking can represent full accounting close completion.
- This batch does not post journals, create accounting entries, execute payments, calculate tax, or replace a qualified human controller's review.
- Approval reassignment is supported only while the period is open; in-review periods must first be reopened with a reason.
- Notifications, timed escalations, delegated approvals and a full approval-policy editor remain future work.

## Validation

The billing quality workflow applies the Batch 32 migration after the Batch 30 audit-ledger migration, then runs PostgreSQL integration tests for the full create → assign → complete → submit → approve (two reviewers) → lock → reopen → reassign → resubmit → relock lifecycle, duplicate-command idempotency and rollback of failed transitions. API tests cover authorization, validation and the event-envelope binding.
