# Persistent Control Remediation Operations — Batch 50

## Delivered

Batch 50 adds an additive SQLite-backed remediation register and authenticated API routes:

- `GET /api/finance/remediations` — list personal records or project records when `projectId` is supplied.
- `POST /api/finance/remediations` — create an action from a governance finding, with optional project, accountable owner, independent reviewer, due date and action plan.
- `GET /api/finance/remediations/:id` — retrieve the action with evidence metadata and chronological history.
- `PATCH /api/finance/remediations/:id` — update assignments, due date and plan using optimistic `expectedRevision`.
- `POST /api/finance/remediations/:id/evidence` — append evidence metadata.
- `POST /api/finance/remediations/:id/transitions` — move an action through the controlled remediation lifecycle.

The SQLite schema is additive and creates three tables: `control_remediation_actions`, `control_remediation_evidence`, and `control_remediation_history`. Foreign keys, state checks, indexes and optimistic revisions are enabled.

## Authorization and workflow rules

- Requests require an authenticated user identity. The HTTP server passes the identity obtained by its existing authentication middleware; request bodies cannot choose the acting identity.
- Personal records are visible only to their creator.
- Project records require project membership to read; project owner/editor access is required to create, update or add evidence.
- Assigned owners must be project owners or editors. Reviewers must be distinct project owners or reviewer-role members.
- The assigned owner must submit evidence before requesting review.
- Only the explicitly assigned, distinct reviewer may verify an action.
- Verification requires evidence. A verified action may be reopened by a project owner or reviewer.
- Stale updates return HTTP 409. Duplicate finding records return HTTP 409.
- Every creation, update, evidence addition and state transition writes an application audit event and a per-action history entry.

## Evidence boundary

Evidence entries store a label, kind, capture time, submitter, optional URI and optional SHA-256 metadata. This API does **not** upload files, fetch evidence URIs, verify file bytes, or certify a checksum supplied by a caller. Private object storage, content hashing at upload time, malware scanning, retention policy and signed download links remain separate release gates.

## Financial and operational safety

- No payment, refund, journal, ledger, subscription, role or identity-provider entitlement is modified.
- Access certification decisions are not executed by this API.
- No background escalation or notification is scheduled in this batch.
- Suggested deadlines remain management decisions; the API requires a due date but does not impose a universal SLA.
- The app's existing authenticated finance workspace loads the persisted register. Personal creation is supported; project assignment and evidence-file upload require the corresponding project and storage integrations.

## Verification

Run:

```bash
npm run verify:control-remediation-api
npm run verify:control-remediation
npm run typecheck
```

The focused API tests cover project-scoped visibility, role-aware assignment, evidence-before-review, independent reviewer verification, durable history, duplicate prevention, optimistic concurrency, malformed evidence and unrelated-route handling.

## Release status

Batch 50 is an isolated feature branch stacked on Batch 49. The PR is for review and CI; it has not been merged or deployed. The additive SQLite schema has not been applied to production. Confirm CI, type-check, staging database backup/restore, API integration and browser QA before considering release.
