# Executive Visuals — financial intelligence implementation

**Status:** foundation batch committed on `feat/financial-intelligence-refunds-disputes`; not yet a live billing integration.  
**Deployment posture:** feature-disabled by default; sandbox only; no production merchant settings or database were changed.  
**Budget posture:** no paid infrastructure or provider credits are activated by this work.

## Scope

This workstream covers:

1. Flutterwave full and partial refunds.
2. Refund webhook verification and reconciliation.
3. Chargeback cases and private evidence management.
4. Automatic credit reversal after confirmed refunds.
5. Admin revenue/refund/dispute intelligence.
6. Customer transaction history and invoices.
7. Failed-payment recovery and notifications.

## Provider contract verified

The adapter targets Flutterwave API v4:

- Authenticate API calls with OAuth 2.0 client credentials (`FLW_CLIENT_ID` + `FLW_CLIENT_SECRET`) through Flutterwave’s token endpoint; access tokens expire and are cached server-side.
- Sandbox base URL: `https://developersandbox-api.flutterwave.com`; production v4 base URL: `https://f4bexperience.flutterwave.com` (requires explicit `FLW_ALLOW_LIVE=true`).
- Create refund: `POST /refunds`, with `charge_id`, `amount`, and `reason`.
- Include a unique `X-Idempotency-Key` and `X-Trace-Id` for each refund request.
- Partial refunds are supported; multiple partial refunds may be made until the total equals the original charge.
- Refund lifecycle states include `new`, `pending`, `succeeded`, and `failed`.
- v4 webhook signature is HMAC-SHA256 over the exact raw request body, base64-encoded and sent as `flutterwave-signature`.
- v3 used a `verif-hash` header. The foundation has a separate legacy verifier so deployments can explicitly choose the matching webhook contract.
- Flutterwave chargeback webhooks must be enabled with the provider; documentation currently directs merchants to contact Flutterwave support to enable them.

Official references:

- https://developer.flutterwave.com/v4.0.0/docs/refunds
- https://developer.flutterwave.com/v4.0/docs/webhooks
- https://developer.flutterwave.com/docs/chargebacks

## Implemented in this batch

### Database migration

`supabase/migrations/20261110120000_financial_intelligence_foundation.sql` adds:

- `payment_transactions`
- `payment_refunds`
- `payment_webhook_events`
- `chargeback_cases`
- `chargeback_evidence`
- `credit_ledger`
- `billing_invoices`
- `payment_attempts`
- `payment_reconciliation_runs`
- `billing_notification_outbox`
- `platform_admins`

Customer-facing tables are owner-scoped and read-only to authenticated users. Provider callbacks, admin role data, reconciliation records and all financial writes are service-role only. The migration is not applied automatically and must be reviewed/applied only to the isolated Executive Visuals project.

### Server-side primitives

`server/payment-intelligence.mjs` provides:

- Exact-raw-body Flutterwave v4 HMAC verification with timing-safe comparison.
- Legacy v3 secret-hash verification.
- Webhook payload SHA-256 fingerprinting.
- v3/v4 refund status normalization. In particular, v3 `completed` is treated as processing because the provider describes it as initiated/pending disbursement.
- Currency precision validation and minor-to-major amount conversion (UGX has zero decimal places).
- Partial-refund amount validation with cumulative refunded/reserved amount input.
- Proportional cumulative credit reversal using integer arithmetic.
- Conservative transient-only retry classification and exponential retry scheduling.
- A server-side v4 refund request using provider idempotency and trace headers.

### Tests

`server/tests/payment-intelligence.test.mjs` covers signature tampering, payload hashing, status normalization, currency precision, partial refunds, over-refund prevention, proportional credit reversals, retry classification and the sandbox refund request contract.

The repository's existing `verify:server` script discovers this test through its `server/tests/*.test.mjs` glob.

## Financial invariants

1. A refund request is not a completed refund.
2. Do not reverse credits on refund initiation, webhook receipt alone, or an unverified status.
3. Reverse credits only after verifying the refund with Flutterwave and recording a terminal successful refund state.
4. Use a unique ledger idempotency key derived from the refund record; duplicate webhook deliveries must not create another reversal.
5. Partial credit reversal is cumulative: target reversed credits = floor(original credit grant × cumulative confirmed refund / original payment amount). Apply only the delta from credits already reversed. A full refund reverses the complete original grant.
6. Include pending/in-flight refund amounts when checking remaining refundable balance so concurrent requests cannot over-refund.
7. Use immutable compensating ledger entries; never edit or delete historical ledger entries.
8. Never trust a webhook payload for transaction amount, currency, owner, charge ID or final status without a provider API verification.
9. Record every webhook delivery by a stable provider event key and payload hash. A duplicate is acknowledged without replaying financial side effects.
10. Unknown currency precision, unknown provider states, missing signatures and ambiguous transaction matches fail closed.
11. Retry only transient payment failures. Hard declines and insufficient-funds responses require customer action; do not repeatedly charge without consent.
12. Keep dispute evidence in private object storage, verify ownership and file hashes, and track provider deadlines.

## Remaining implementation batches

### Batch 2 — server API integration

- Add authenticated, owner-scoped transaction history and refund-request routes.
- Add raw-body webhook route before JSON parsing, v4 signature checks and idempotent event persistence.
- Verify provider transaction/refund status server-to-server before state changes.
- Add atomic refund reservation so concurrent partial refunds cannot exceed the paid amount.
- Add transactional credit-ledger reversal and audit events.
- Add reconciliation worker for pending refunds and webhook gaps.

### Batch 3 — disputes and customer billing

- Ingest chargeback lifecycle webhooks; expose a manual case refresh path when webhooks are unavailable.
- Add private evidence upload, hashing, case deadlines and status history.
- Generate immutable invoice snapshots and downloadable PDF invoices.
- Add customer transaction and invoice screens.

### Batch 4 — admin and recovery

- Add role-checked admin metrics and financial exception queue.
- Define gross revenue, net collected, provider fees, refunded amount, refund rate and outstanding dispute exposure separately.
- Add transient failure recovery, capped retries, customer notifications and notification outbox worker.
- Add audit/export controls and reconciliation reports.

## Launch gates

- Keep `BILLING_API_ENABLED=false` until the isolated Supabase schema, authenticated server persistence and private evidence storage are verified.
- Keep Flutterwave API base URL on sandbox until a merchant owner explicitly approves live mode.
- Do not create real payment plans, subscriptions, refunds or charges in automated tests.
- Do not expose Flutterwave secret keys, webhook secrets, service-role keys or private evidence URLs to browser code.
- Do not claim financial dashboard figures are authoritative until reconciliation against provider records is passing.
- Do not merge or deploy this branch to production without review, staging tests and explicit approval.


## Batch 2 — authenticated API integration

Added on `feat/financial-intelligence-api-integration`:

- `server/flutterwave-auth.mjs`: OAuth client-credentials token provider with concurrent-request coalescing and a one-minute refresh buffer.
- `server/financial-intelligence-api.mjs`: owner-scoped customer transaction/refund reads, billing-admin role checks, admin financial summary, refund initiation, provider verification, pending-refund reconciliation and webhook idempotency.
- `server/index.mjs`: authenticated route mounting, a public raw-body webhook endpoint at `POST /api/webhooks/flutterwave`, and a bounded in-process reconciliation schedule. Financial routes are only mounted when `BILLING_API_ENABLED=true`; enabling them also requires `AUTH_MODE=supabase`.
- `supabase/migrations/20261110130000_financial_refund_atomicity.sql`: row-locked refund reservation RPC and provider-confirmed settlement RPC. The settlement RPC inserts immutable compensating ledger entries in the same database transaction and is executable only by `service_role`.
- `server/tests/financial-intelligence-api.test.mjs`: tests owner scoping, admin authorization, invalid signatures, duplicate webhook deliveries, provider verification mismatches and OAuth token caching.

### Routes added

- `GET /api/billing/transactions`
- `GET /api/billing/refunds`
- `POST /api/admin/finance/refunds` (billing admin only; requires `Idempotency-Key`)
- `GET /api/admin/finance/summary` (owner/platform/billing admin only)
- `POST /api/admin/finance/reconcile` (owner/platform/billing admin only)
- Scheduled reconciliation runs every 60 minutes by default when billing is enabled; configure `PAYMENT_RECONCILIATION_INTERVAL_MINUTES` (5–1440) or disable with `PAYMENT_RECONCILIATION_ENABLED=false`.
- `POST /api/webhooks/flutterwave` (public, raw-body signature verified)

### Refund safety sequence

1. A billing admin selects a successful payment and requests a refund.
2. The database locks the payment row and atomically reserves the requested amount. Pending and successful refunds count against the remaining refundable amount.
3. The server calls Flutterwave using OAuth and the same idempotency key.
4. The refund remains `processing` until a webhook or reconciliation check retrieves the refund from Flutterwave.
5. The server verifies provider refund ID, original charge ID, amount and terminal status.
6. The settlement RPC marks the refund successful and calculates the cumulative proportional credit reversal. The credit ledger entry is inserted atomically and idempotently.
7. Failed provider refunds release the reservation; ambiguous network outcomes keep the reservation in place until reconciled.

### Configuration

- `BILLING_API_ENABLED=false` by default.
- `FLW_REFUNDS_ENABLED=false` by default.
- `FLW_ALLOW_LIVE=false` by default.
- Configure `FLW_CLIENT_ID`, `FLW_CLIENT_SECRET` and `FLW_SECRET_HASH` only in server-side environment settings.
- Configure the Flutterwave dashboard webhook URL as `/api/webhooks/flutterwave` and select the matching v4 webhook mode.

### Remaining gates

- Apply both financial migrations only to the isolated Executive Visuals Supabase project after review.
- Verify the existing checkout writes verified charge IDs into `payment_transactions.provider_transaction_id` and grants credits with `credit_ledger.entry_type='purchase_grant'`. No refund or credit reversal can work safely without those source records.
- Confirm the deployed Supabase project uses the `executive_visuals` schema and the same Auth user IDs as the app.
- The admin summary is an API response, not yet the finished visual dashboard. Customer invoice PDF generation, dispute evidence upload and notification delivery remain subsequent batches.
- No migration has been applied and no live provider request has been made.


## Batch 2 — Uganda UGX mobile-money checkout (development branch)

Added `supabase/migrations/20261110150000_flutterwave_ugx_checkout.sql` and extended the financial API with:

- Server-owned `billing_products` catalogue. No products are seeded or activated and no prices are invented.
- Authenticated `GET /api/billing/products` endpoint exposing only active catalogue entries.
- Authenticated `POST /api/billing/checkout` endpoint for Uganda UGX credit-pack purchases using MTN or Airtel mobile money.
- Product price and credit quantity are read from the server-side catalogue; client-supplied price/credits are ignored.
- Unique checkout reference and caller idempotency key; key reuse with a different SKU/network is rejected.
- Flutterwave v4 Orchestrator direct-charge integration using server-side OAuth credentials, trace ID and idempotency header.
- Raw-body signed `charge.*` webhook processing, provider-side `GET /charges/{id}` verification, and strict charge ID/reference/amount/currency checks.
- Atomic purchase settlement RPC creates an immutable `purchase_grant` ledger entry, invoice snapshot and receipt notification outbox record in one database transaction.
- Duplicate purchase fulfilment is idempotent. Customer value is not granted from redirects or webhook payloads alone.
- Added automated tests for mobile-money checkout request construction and verified charge webhook settlement.

### Current limitations / explicit gates

- This batch is a backend foundation; customer-facing checkout UI and downloadable invoice PDF delivery are not yet implemented.
- The ledger records credit grants, but integration with the existing generation-credit reservation/usage gate must be completed before purchased credits can be consumed in production.
- The catalogue is empty by default. An owner-controlled product-management workflow and approved pricing must be added before any checkout can be offered.
- Only Uganda UGX mobile-money MTN/Airtel is in this batch. Card checkout, subscriptions, renewals, chargeback evidence workflows and failed-payment recovery are subsequent batches.
- The new SQL migration has not been applied to any Supabase project. Billing remains disabled by default. No merchant account, API key, live payment, refund or production deployment was configured.
- CI status has not yet reported checks for the latest branch commit; tests are added but not reported as passed.


## Batch 3 — credit balance and reservation accounting (development branch)

Added `supabase/migrations/20261110170000_credit_reservation_accounting.sql` and an owner-scoped read endpoint.

- Introduces `credit_reservations` with reserved / settled / released states, owner scope, job linkage, metadata and idempotency key.
- Adds `get_credit_balance` RPC. Balance is computed server-side as immutable ledger credits minus active reservations; clients cannot supply or edit the balance.
- Adds atomic `reserve_credit_units` RPC. Owner-level advisory transaction locking prevents concurrent jobs from reserving the same available credits; duplicate keys replay only when amount and job match.
- Adds `settle_credit_reservation` RPC. Successful execution writes one negative `settlement` ledger entry and changes the reservation state in the same transaction.
- Adds `release_credit_reservation` RPC. Failed/cancelled work can release a reservation without creating a spend entry; settled reservations cannot be released.
- All reservation tables and RPCs are service-role only. No client can invoke reserve, settle or release directly.
- Adds authenticated `GET /api/billing/credits` and tests for owner scoping and malformed balance data.

### Integration gate (historical note; superseded by Batch 5)

This batch originally established accounting primitives only. Batch 5 subsequently wired server-quoted credit reservations to cloud timeline render submission and atomic terminal settlement/release. Local generation pipelines and other provider-specific generation paths still require their own billing integration. The credit migrations remain unapplied; no staging or production database was changed.


## Batch 4 — customer invoice history API

- Adds authenticated `GET /api/billing/invoices` with bounded pagination and owner scoping.
- Returns invoice number, currency, amount, issue date and immutable invoice snapshot for a customer billing-history view.
- Exposes only a boolean `pdfAvailable`; private object-storage paths are never returned to the customer.
- Adds tests for owner scoping, pagination and private-path non-disclosure.

### Invoice PDF gate

The invoice snapshot is now retrievable, but downloadable PDF generation and private signed-download URLs are not yet implemented. Do not expose storage object paths or mark PDF downloads available until a private bucket, ownership checks, content-type validation and short-lived signed URLs are in place.


## Batch 5 — cloud timeline render credit lifecycle

Added `supabase/migrations/20261110180000_atomic_job_credit_finalization.sql` and integrated server-quoted reservations into cloud timeline render submission.

- Optional server-side `CLOUD_TIMELINE_CREDITS_PER_SECOND` policy. It defaults to `0` (disabled); clients cannot supply or override the rate.
- Render duration is derived from the maximum timeline clip end-time across tracks, using validated rational timeline timing. Credits are rounded up from duration × server-configured rate.
- A reservation is created before a render job is made claimable. Insufficient or unavailable credits fail closed; no job is queued.
- If job creation is definitely rejected by the database, the reservation is released. On timeout/network/5xx uncertainty, the reservation stays held to avoid accidentally rendering for free; it must be reconciled against the durable job record.
- Adds a one-reservation-per-job uniqueness constraint.
- Replaces the cloud `finish_job` RPC so successful completion debits the reservation exactly once in the same database transaction as the terminal job update; failed, cancelled or partial jobs release it in that same transaction.
- The worker's existing finish call automatically uses this lifecycle; no worker code needs to be trusted with credit amounts or ledger writes.
- Existing idempotent render replay returns the existing job without reserving a second time.
- Billing remains disabled when the server rate is zero. No prices/rates are invented or activated by this change.

### Batch 5 validation gate

Node tests cover server-side quoting, reservation-before-queue ordering, empty-timeline rejection and fail-closed reservation responses. The new PostgreSQL migration still requires review and execution in isolated staging, including concurrency tests for two simultaneous renders competing for the same balance, success/failure/cancel finalization, and worker lease expiry/recovery. Do not enable `CLOUD_TIMELINE_CREDITS_PER_SECOND` until those database tests pass and the credit-pack catalogue/pricing is approved.


## Batch 6 — subscription plans and entitlement foundation

Added `supabase/migrations/20261110190000_subscription_entitlement_foundation.sql`.

- Adds versioned `subscription_plans`, customer `customer_subscriptions`, and append-only `subscription_events`.
- Entitlements are copied into each subscription as an immutable snapshot, so later plan edits do not silently change existing customer access.
- Seeds only a non-billable public Free plan (3 projects, 512 MiB storage, one seat, basic timeline editor; no paid AI generation).
- No Creator/Studio/Enterprise prices, included credit amounts, or recurring charges are invented or activated.
- Adds RLS owner-read policies for customer subscriptions/events and public-active plan catalogue reads. Client writes are revoked; all changes flow through the server.
- Adds `grant_customer_subscription` RPC. It verifies the actor has an owner/platform_admin/billing_admin role, serializes grants per customer, rejects overlapping current subscriptions, validates a maximum 366-day period, snapshots plan entitlements and writes an audit event.
- Adds authenticated `GET /api/billing/plans`, `GET /api/billing/subscription`, and owner-gated `POST /api/admin/subscriptions/grant`.
- Support role cannot grant entitlements. The RPC explicitly rejects a missing admin record as well as a disallowed role.

### Flutterwave recurring-payment boundary

Flutterwave's Payment Plans guide explicitly says that adding a payment plan fixes the payment method to **card**; it also says subscriptions are bound to the customer's email, and failed recurring charges are retried three more times at 30-minute intervals before repeated failures can cancel the subscription. Uganda one-time mobile-money documentation covers MTN/Airtel authorization, but it does not establish recurring MoMo. Therefore the initial recurring subscription design is card-only where enabled on the approved merchant account; MTN/Airtel MoMo remains one-time checkout unless Flutterwave confirms otherwise in writing. The recurring adapter remains a later sandbox-only integration.

### Batch 6 validation gate

Added API tests for public plan filtering, customer ownership scope, support-role denial, audited grant RPC arguments and period limits. The migration has not been applied to staging or production. Before release, run it on an isolated Supabase staging project, test missing/unauthorized admin roles, overlapping concurrent grants, subscription expiry and RLS under real authenticated sessions. Do not grant paid entitlements or enable recurring collection until payment settlement, renewal, cancellation, failed-payment grace and reconciliation are implemented and verified.
