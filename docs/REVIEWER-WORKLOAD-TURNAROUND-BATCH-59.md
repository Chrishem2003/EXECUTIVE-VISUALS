# Reviewer Workload and Turnaround Intelligence — Batch 59

## Delivered

- Adds authenticated `GET /api/finance/remediations/reviewer-performance`.
- Scopes results to reviewer assignments in currently accessible, non-archived projects.
- Excludes personal records and inaccessible/archived projects.
- Aggregates reviewer assignment count, current review queue, overdue action deadlines, verified decisions, median and average measured turnaround, and median age of the current review queue.
- Adds project-level queue summaries.
- Integrates the analytics panel into the Financial Command Centre and refreshes it with the existing finance workspace.
- Displays opaque reviewer account IDs only; no names or email addresses are exposed.
- Adds tests for turnaround calculations, project/member scope, archived project exclusion, and PII omission.

## Metric definitions and limits

- **Measured turnaround:** elapsed calendar hours from the latest `pending_review` history event preceding a verification event performed by the assigned reviewer.
- **Current pending age:** elapsed calendar hours from the latest submission event for an action currently in `pending_review`.
- **Overdue action deadline awaiting review:** a pending-review action whose remediation `dueAt` is earlier than server time. This is an action deadline, not a reviewer-specific deadline.
- **SLA status:** no contractual or business-hours reviewer SLA is configured. The panel does not claim a reviewer has breached an SLA.
- Unverified or unverifiable review intervals are excluded from turnaround statistics. Personal actions are excluded because they do not have an independent project reviewer.

## Security and privacy

Identity comes from authenticated server context. Project membership and archived state are checked in the server query. The endpoint returns opaque reviewer IDs only, not email addresses, names, private evidence paths or evidence bytes. No automatic reassignment, notifications, or writes are performed by this analytics endpoint.

## Standards context

The design draws on NIST SP 800-53 AU-6 (audit record review, analysis and reporting), AU-7 (report generation without altering source records), and AU-8 (timestamps). These are design references, not a claim of certification or compliance.

- NIST SP 800-53: https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
- NIST audit trail definition: https://csrc.nist.gov/glossary/term/audit_trail

## Verification

GitHub Actions checks:
- Reviewer workload and turnaround API tests.
- Existing remediation API and lifecycle tests.
- Batch 58 assurance report integrity tests and offline verifier syntax.
- Audit export verifier.
- Financial Command Centre TypeScript type-check.

No passing result is claimed until the Batch 59 workflow completes.

## Release boundary

Draft PR stacked on Batch 58. No merge, production deployment, database migration, paid infrastructure, automatic reassignment, notifications, financial posting, payments, subscription or entitlement changes.
