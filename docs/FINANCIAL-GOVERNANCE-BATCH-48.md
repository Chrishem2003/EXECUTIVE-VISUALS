# Batch 48 — Financial Governance & Control Intelligence

## Purpose

Provide a governance control room inside the Financial Command Centre. The assessment is deterministic and rule-based, derived only from financial evidence already loaded by the authenticated finance-admin workspace.

## Delivered capabilities

- Seven-domain control register covering liquidity, profitability/margin, cash reconciliation, dispute deadlines, audit integrity, financial close and scenario review.
- Priority findings for unresolved liquidity and margin alerts, cash reconciliation exceptions, overdue dispute deadlines and failed audit-chain verification.
- Explicit evidence-gap and not-assessed findings when required sources are unavailable or an audit verification has not been run.
- Rule-weighted triage index, critical/high/medium/low counts, source coverage and severity-ordered findings.
- Recommended owner actions and control objectives, accountable functions and monitoring cadence.
- Governance evidence JSON export.
- On-demand audit history refresh and audit-chain verification using existing protected endpoints.
- Responsive Aurora-style governance interface and mobile layouts.
- Unit/contract tests integrated into npm build and the billing CI workflow.

## Rule semantics

- Resolved/closed/matched/reconciled/complete/settled source rows are excluded from open-exception counts.
- Overdue disputes are identified only when an unresolved case has a parseable due-date field earlier than the assessment time.
- Alert severity uses source severity/riskLevel/priority when one of the supported labels is present; otherwise the rule's documented default is used.
- The triage index weights critical, high, medium and low findings and caps at 100. It is a prioritization aid, not a probability, fraud score, loss estimate, calibrated risk measure or audited rating.
- A zero finding count does not establish that no risk exists.
- Source presence is labelled evidence available, not effective control. Operating effectiveness requires separate testing and reviewer evidence.

## Data sources and gaps

The current implementation reads the command-centre reconciliation exception list, liquidity alerts, margin alerts, cash-flow reconciliation, dispute register, audit verification, audit event history, close workflow and scenario snapshots when present. The assessment does not fetch additional data independently. Audit history and chain verification are refreshed on demand.

Missing data remains explicitly unavailable/not assessed. A missing alert source is never interpreted as zero risk. Date-based dispute rules rely on known due-date properties and cannot infer deadlines absent from the source record.

## Governance and safety

- No payments, refunds, journal entries, transfers, account changes, close approvals, access changes or transaction blocking.
- No automatic control remediation or risk disposition.
- Findings are advisory and require named human owners, source verification and independent review.
- Existing audit-chain verification limitations remain: chain consistency alone cannot detect complete historical replacement without an independently retained trusted checkpoint.
- No new database migrations, production deployment or paid infrastructure are included.

## Verification

Run `npm run verify:financial-governance` for the Batch 48 deterministic rule tests. The test command is also included in the project build and the billing self-service GitHub Actions workflow. CI and browser/staging verification must pass before merge or production release.
