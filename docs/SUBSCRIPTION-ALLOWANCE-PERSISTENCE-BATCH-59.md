# Batch 59 — Persistent subscription allowance approvals

**Status:** implementation and disposable PostgreSQL/API verification in progress.  
**Release state:** staging/review only; no plan publication or customer credit grants.

## Why this batch exists

Batch 58 introduced a deterministic proposal hash and required two distinct approvals. Batch 59 persists those proposals and decisions so that approvals survive process restarts and can be independently audited.

## Evidence bound to each proposal

The allowance simulator uses only completed jobs with exactly one immutable USD invoice attribution per usage event and exactly one settled customer-credit reservation per job. At least five complete jobs are required.

The cost evidence now includes:
- Number of complete jobs and settled platform credits.
- Total invoice-attributed provider cost in USD minor units.
- Conservative per-platform-credit cost, rounded upward.
- Reporting period and versioned attribution method.
- SHA-256 digest of the accepted job, usage-event, invoice-import, invoice-line, amount and settled-credit rows.

Changing any source invoice line, accepted usage row, credit quantity, plan price, included allowance, plan version or financial assumption changes the proposal hash and requires fresh approvals.

## Persistent database contract

Migration: `20261122150000_persistent_subscription_allowance_approvals_batch_59.sql`

Tables:
- `executive_visuals.subscription_allowance_proposals`: immutable exact proposal snapshots.
- `executive_visuals.subscription_allowance_approvals`: one immutable decision per finance/product stage, linked to the hash-chained financial audit event.

Service-role-only RPCs:
- `create_subscription_allowance_proposal`
- `record_subscription_allowance_approval`
- `get_subscription_allowance_approval_status`

The database rechecks administrator roles against `executive_visuals.platform_admins`. Finance requires `billing_admin`; product requires `platform_admin`. The proposal creator cannot approve it, and approvers must be distinct.

## Admin API

- `POST /api/admin/finance/subscription-allowance-proposals` — creates a proposal by rerunning the invoice-backed simulation server-side. The caller supplies the plan code and financial assumptions, never provider-cost evidence.
- `GET /api/admin/finance/subscription-allowance-proposals` — lists proposals and current approval states.
- `GET /api/admin/finance/subscription-allowance-proposals/:id` — reads one durable approval packet.
- `POST /api/admin/finance/subscription-allowance-proposals/:id/approvals` — records one finance or product decision. The authenticated role is checked by the API and again by PostgreSQL.

Write routes require an 8–160 character idempotency key in the request header. Approval decisions are append-only and linked to the financial audit ledger.

## Publication boundary

Even after both decisions are approved, the API returns `eligibleToPublish: true` and `publishable: false`. This is deliberate. A separate batch must implement an audited publication command that revalidates the current plan version, exact proposal hash, invoice-evidence freshness and approval records in one database transaction before changing the public plan catalogue or customer entitlements.

No production billing, live checkout, plan publication, credit wallet, provider call or deployment is activated by this batch.

## Verification

- Node API tests cover role checks, browser-evidence rejection, audit payloads, exact proposal hashes and non-publishable status.
- Evidence tests verify deterministic fingerprints and that changing an accepted invoice line changes the digest.
- A disposable PostgreSQL integration script applies the base audit ledger and Batch 59 migration, then exercises proposal creation, self-approval rejection, finance/product approvals, idempotent replay, durable status and immutable records.
