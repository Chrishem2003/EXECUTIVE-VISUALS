# Batch 25 — Verified Cost Reconciliation & Profitability Trends

## Delivered

- A protected, explicit posting operation for provider invoice costs.
- Posting is permitted only when every imported invoice line has exactly one matched provider-reported usage event, the exact amount/currency/provider/model/reference agree, usage periods align, and line totals equal the invoice total.
- Verified provider invoice lines are posted through the existing immutable financial service-cost ledger with stable idempotency keys.
- Customer, project and job attribution is preserved in a separate immutable link table, including shared/unattributed lines where the metering event has no customer owner.
- Repeated posting replays existing ledger entries rather than duplicating costs.
- A bounded 3–36 month profitability trend report joins captured subscription revenue snapshots to posted direct service costs and reports shared overhead separately.
- Financial Command Centre now displays monthly profitability trends alongside current contribution and margin data.
- Protected APIs:
  - `POST /api/admin/finance/ai-invoices/post-to-ledger`
  - `GET /api/admin/finance/profitability-trends?months=12`

## Accounting safeguards

- Importing or reconciling an invoice does not automatically post it to the profitability ledger. An administrator must explicitly invoke the posting operation.
- Unmatched, ambiguous, variance, incomplete or duplicate invoice evidence blocks posting.
- Only `provider_reported` AI usage costs can be posted by this path. Catalog estimates and unpriced usage are not converted into actual expenses.
- Existing invoice-to-usage reconciliation remains the source of exact matching evidence.
- The service-cost ledger remains append-only; posting uses the existing ledger writer and immutable attribution links.
- Shared costs remain visible but unallocated. This batch does not invent allocation drivers or blend currencies.
- Profitability trends use recorded monthly subscription snapshots; missing periods are not fabricated.
- No customer billing, provider routing, external notifications, production data or deployment settings are changed.

## Validation

The PostgreSQL integration test creates a disposable matched invoice/usage fixture, posts it, verifies exactly one service-cost entry and attribution link, replays posting to prove idempotency, and checks bounded trend reporting. API tests cover admin authorization, UUID validation, RPC argument binding and month-range validation.

## Rollout

Draft PR only. Apply migrations to disposable CI PostgreSQL only. Do not merge, run production migrations, deploy, change provider routing, or post real invoice costs without separate review and explicit approval.
