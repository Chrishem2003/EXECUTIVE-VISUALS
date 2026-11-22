# Batch 70 — Verified job cost and credit-usage coverage

## Purpose

Connect immutable provider-invoice reconciliation evidence to settled generation-credit reservations at the job level. This is a read-only finance-admin report and a prerequisite to publishing trustworthy profitability.

## Evidence rules

- Provider actual cost is included only when an immutable ai_provider_invoice_reconciliation_events row is matched, its invoice import is fully matched, and the linked usage event belongs to the reporting month and a job.
- Customer credit consumption comes only from settled billing_credit_reservations with a recorded actual_credits amount.
- Job costs are grouped by currency. A mixed-currency job is flagged and its amounts are never added together.
- The report does not convert credits into money. Recognized revenue and gross margin remain null; profitabilityAvailable remains false until a separately verified revenue-allocation ledger is implemented.
- Missing invoice-backed cost or settled credit evidence is surfaced as an exception rather than silently treated as zero.

## API

Finance-admin-only endpoint:

GET /api/admin/finance/job-cost-coverage?periodMonth=2026-11-01&limit=50

The month must be the first day of a real calendar month. Page size is bounded to 1–100. The server passes the authenticated administrator ID to get_verified_job_cost_coverage.

## Release and safety boundaries

- Uses existing provider invoice, reconciliation, usage-event and generation-credit reservation records.
- Adds one read-only SQL report function; no new ledger or parallel accounting source.
- No credit grant/debit/refund, subscription entitlement, customer price, payment, provider generation or live provider call.
- No automatic FX conversion, shared overhead allocation or guessed revenue-per-credit ratio.
- No production migration, deployment or paid infrastructure. Apply only to disposable CI/staging after review and separate approval.

## Next gate

Implement a trusted revenue-allocation ledger that distinguishes paid top-ups, subscription revenue, included credits, promotional grants, refunds and chargebacks. Allocate recognized revenue to settled job consumption with explicit evidence and currency handling. Only then may the existing verified-job profitability calculator produce gross-margin results for these jobs.
