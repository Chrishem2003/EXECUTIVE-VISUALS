# Independent Reviewer Inbox and SLA Visibility — Batch 55

## Delivered

Batch 55 builds on the existing independent review workflow.

- Adds an authenticated `GET /api/finance/remediations/inbox` endpoint.
- Returns only records explicitly assigned to the authenticated reviewer, in projects they can currently access.
- Excludes personal records, unassigned actions, inaccessible projects, archived projects and memberships that have been removed.
- Supports bounded status/project filters and a maximum page size of 100 (default 50).
- Computes SLA state server-side from persisted due dates: overdue, due soon (within 72 hours), on track, completed, or unknown.
- Returns aggregate counts across the full matching queue, not just the bounded result page.
- Adds a reviewer inbox in the Financial Command Centre with queue metrics, due-state indicators, evidence file links and navigation to the relevant project register.
- Exposes a verify-after-review action for pending items; the existing API still enforces distinct assigned reviewer identity and evidence requirements.
- Adds tests for assignment scope, membership removal, invalid project filters and server-derived SLA buckets.

## SLA and escalation boundary

The 72-hour due-soon window is a visibility policy, not a contractual SLA or compliance determination. Overdue means the stored due date is earlier than server time. Completed actions are excluded from overdue and due-soon counts.

This batch does **not** automatically reassign owners, change reviewer assignments, send notifications, or mutate action status. Automated escalation requires an approved operational scheduler, policy ownership, delivery channel, retry semantics, idempotency and audit/monitoring controls. No scheduler or new paid service is introduced here.

The reviewer inbox returns at most 100 rows per request; summary counts cover all matching records. Use filters to narrow larger queues. No user email, session data or evidence contents are added to the inbox response.

## Security and audit

Reviewer identity is derived from the authenticated server account, never from a caller-supplied reviewer ID. Project membership is rechecked on every inbox request. Existing transition authorization remains authoritative for verification and request-for-change actions.

Application audit events remain database-backed and are not claimed to be immutable or non-repudiable. OWASP recommends recording attributable events, protecting log access and integrity, and testing logging controls: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html.

## Verification

GitHub Actions runs:
- `npm run verify:control-remediation-api`
- `npm run verify:control-remediation`
- `node --check server/control-remediation-api.mjs`
- `npm run typecheck`

Batch 55 verification **passed** on commit `a51fabba344eeb0d5d7cb422015c2a68825bc124`: remediation API/role-boundary tests, lifecycle tests, API syntax check and Financial Command Centre TypeScript check all succeeded. Workflow: https://github.com/Chrishem2003/EXECUTIVE-VISUALS/actions/runs/42883497830.

## Release boundary

Branch: `feat/reviewer-inbox-sla-batch-55`, stacked on `feat/evidence-access-audit-batch-54`.

Draft PR only. No merge, production deployment, database migration, new paid infrastructure, billing, payment, journal, subscription, entitlement or production configuration change.
