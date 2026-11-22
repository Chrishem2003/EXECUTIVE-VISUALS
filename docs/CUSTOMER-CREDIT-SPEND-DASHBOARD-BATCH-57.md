# Batch 57 — Customer credit spend dashboard

## Delivered

- Added an authenticated `GET /api/billing/credits/usage` endpoint backed by a service-role-only PostgreSQL summary RPC.
- Billing-period usage is derived from durable generation reservations: settled rows use provider-verified `actual_credits`; in-flight rows use active `reserved_credits`.
- Project shared-wallet generation remains visible to the paying owner because the existing reservation flow mirrors project-pool reservations into the owner-level billing reservation record.
- Customer billing now displays settled usage, reserved usage and total committed usage separately.
- When an active subscription snapshot explicitly contains `credit_allowance_published=true` and has a positive included-credit allowance, the API calculates 50%, 80% and 100% threshold warnings. Reserved work counts toward the thresholds.
- When no allowance is explicitly published, the workspace still displays actual usage but keeps allowance bars and budget alerts disabled.
- If multiple active subscriptions are detected, the summary marks the account ambiguous and does not activate an allowance.
- The summary is read-only. It does not grant credits, change subscriptions, charge payments, approve jobs, or contact providers.

## Accounting contract

The summary uses the subscription billing period when exactly one active, unexpired subscription exists. Otherwise it uses the current calendar month and publishes no allowance.

`usedCredits = settled actual credits + active reserved credits`

Released reservations are excluded. This is a generation-usage view, not a cash payment statement. Provider customer credits and provider API billing credits remain separate.

## Safety and release boundary

- Allowance thresholds require an explicit trusted publication flag in the subscription entitlement snapshot; draft price hypotheses and non-published plan values cannot activate warnings.
- The RPC is executable only by `service_role`; browser callers cannot query arbitrary owner IDs.
- API owner identity comes only from the authenticated request context.
- The UI does not calculate usage from its paginated 20-row history; it consumes the bounded server-side aggregate.
- No migration is applied to staging or production by this PR. No payment provider credentials, live charges, deployments or paid infrastructure are changed.

## Verification

- `server/tests/customer-credit-spend-dashboard-batch-57.test.mjs` covers owner scoping, settled/reserved accounting, unpublished allowance behavior, and malformed summary rejection.
- Existing server test suite includes the new tests through `verify:server`.
- Exact-head CI and isolated PostgreSQL migration validation remain required before merge or staging activation.
