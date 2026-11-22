# Batch 79 — Customer credit wallet API and dashboard

**Status:** draft implementation; Billing self-service, Neon integration and repository quality checks required.  
**Base:** Batch 78 customer credit expiry and wallet contract.

## Customer experience

The existing Billing & Subscription workspace now presents a customer-facing generation wallet with:

- Spendable credits.
- Credits reserved for active jobs.
- Settled/consumed credits.
- Allowance credits expiring within seven days.
- Credits pending expiry and an explicit deferred-expiry state.
- Posted ledger balance for reconciliation.
- Remaining credit lots with source type, remaining amount and expiry date.
- Recent credit activity with transaction type, date and signed amount.

The UI explains that platform credits are usage units, not cash; subscription allowances can expire at their verified period end; purchased credit packs do not expire.

## API contract

The existing authenticated `GET /api/billing/credits` endpoint remains backwards compatible for `ledgerBalance`, `reserved` and `available`. It now also returns:

- `consumed`
- `expiringWithinSevenDays`
- `pendingExpiry`
- `expiryDeferred`
- `creditLots[]`
- `recentTransactions[]`

The server calls the Batch 78 service-role-only `get_customer_credit_wallet` RPC, then the existing balance RPC. The owner ID comes only from the verified server session; no owner ID is accepted from query parameters or request bodies.

The API validates numeric values and dates, caps displayed lots at 200 and recent activity at 100, and deliberately removes raw source IDs, ledger IDs and internal evidence JSON before returning data to the customer.

## Security

- Existing `AUTH_MODE=supabase` request authentication remains the gate before billing API dispatch.
- Database RPCs are called only with server-side Supabase credentials.
- The customer cannot select another owner or call the service-role RPC directly.
- Raw provider evidence and private identifiers are not exposed in customer responses.
- No new table, public Data API grant, checkout, top-up or pricing activation is introduced.

## Verification

`npm run verify:customer-credit-wallet-dashboard` runs:
- API ownership, response-shape and evidence-redaction tests.
- Fail-closed malformed wallet tests.
- Dashboard metric, lot, transaction and expiry-state contract tests.

The Billing self-service workflow also runs the new test command after Batch 78 verification.

## Rollout

Draft and additive. No production migration, merge, deployment, provider calls, payment processing, subscription activation or public pricing changes. Batch 80 remains the separate next step for paid credit-pack checkout and verified top-up settlement.
