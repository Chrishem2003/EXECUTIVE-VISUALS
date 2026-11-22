# Batch 43 — Customer credit activity and wallet transparency

## Delivered

- Added authenticated `GET /api/billing/credits/history?limit=20&offset=0` for customer-owned wallet activity.
- Reads the existing append-only `executive_visuals.billing_credit_ledger`; no parallel wallet, ledger or migration was introduced.
- Query is explicitly filtered by the authenticated owner, ordered newest-first with a stable ID tie-breaker, and bounded to 1–100 rows per request and offset 0–100,000.
- Response contains only safe display fields: ledger entry ID, signed credit amount, event type, reference ID, description and timestamp. Internal idempotency keys and evidence JSON are not returned.
- Invalid rows and pagination fail closed.
- Billing workspace now displays the latest 20 wallet entries alongside available, reserved and total balances, including grants, reservations, settlements, refunds, adjustments and expiries.
- Added API tests for owner scoping, safe field projection, pagination bounds and malformed ledger rows.

## Existing economics preserved

- Customer credits remain separate from provider credits and currency minor units.
- The existing quote policy retains server-side target margin, payment fee and support reserve assumptions.
- Existing subscription plans and proposed $9 / $29 / $79 / $199 / Enterprise test prices remain hypotheses; this batch does not set monthly credit allowances or activate paid plans.
- Existing immutable wallet and reservation RPCs remain authoritative for balance changes. The new endpoint is read-only.

## Safety

- No credit grant, debit, refund, top-up, subscription renewal, payment, provider generation or ledger mutation is performed by this feature.
- No production migration, merge, deployment or new paid infrastructure.
- History is owner-scoped and does not expose private evidence payloads or idempotency secrets.

## Verification

Exact-head CI is required before this draft batch can be considered complete. This change reuses the current schema and is additive at the API/UI layer.
