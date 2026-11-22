# Executive Visuals — Subscription, Credit and Unit-Economics Contract

**Status:** implementation specification; proposed prices are experiments, not validated offers  
**Date:** 2026-11-22  
**Scope:** staging-first; no production billing activation, payment-provider configuration, paid provider execution, or subscription charge is authorized by this document.

## Product and revenue model

| Plan | Proposed monthly price | Intended customer |
|---|---:|---|
| Starter Creator | $9 | Individual / entry creator |
| Professional Creator | $29 | Frequent creator |
| Studio | $79 | Small production team |
| Agency | $199 | Agency / multi-client operation |
| Enterprise | Custom | Contracted organization |

These are test price points only. Monthly credit allowances, included seats, rollover, overage and top-up quantities must remain unset until provider cost data, payment fees, target markets and willingness-to-pay tests are reviewed.

Revenue streams to support in the product model:
- recurring subscriptions;
- prepaid credit top-ups;
- paid premium-model and enhancement usage;
- additional workspace seats;
- agency / campaign / brand workspaces;
- commercial production packages;
- enterprise API and white-label contracts.

## Critical separation: money, provider cost and customer credits

Do not equate a customer credit with a provider credit or one US cent. Persist three separate concepts:

1. **Money:** integer minor units plus ISO currency (e.g. USD cents); never floating-point currency arithmetic.
2. **Provider cost:** measured cost in the provider's billing unit, converted to a normalized cost amount with source, timestamp and rate-card version.
3. **Customer credits:** platform-defined integer units granted, reserved, captured, released or refunded by an immutable ledger.

A pricing change must not rewrite historical transactions. Every job and ledger entry must retain the exact pricing/rate-card version used at authorization time.

## Cost calculation contract

For each generation estimate:

`provider_cost = output_cost + input_reference_cost + audio_cost + other_provider_fees`

`fully_loaded_cost = provider_cost + expected_retry_cost + payment_fee_allocation + infrastructure_allocation + support_or_delivery_allowance`

For a target gross margin `m`:

`minimum_net_revenue = fully_loaded_cost / (1 - m)`

The customer-facing credit quote is derived from the approved price-book conversion and must be rounded up. Do not apply a fixed markup to every model without considering provider fees, retries, refunds, currency conversion and plan discounts.

The quote must be calculated server-side and shown before the user submits a billable job. The server must recompute and validate it at reservation time; client-supplied cost or credit values are never authoritative.

## Illustrative public provider rates — refreshed 2026-11-22

The following are **Runway Dev API list rates**, checked against its current pricing article on 2026-11-22. Runway Dev states that one provider credit equals USD $0.01. These are provider costs, not Executive Visuals customer prices, and are not invoice reconciliation evidence.

| Model / setting | Published output rate | 5-second text/image-to-video | 10-second text/image-to-video |
|---|---:|---:|---:|
| Kling 4.0, 720p | $0.157/sec | $0.785 | $1.57 |
| Kling 4.0, 1080p | $0.235/sec | $1.175 | $2.35 |
| Kling 4.0, 4K | $0.549/sec | $2.745 | $5.49 |
| Kling 4.0 Flash, output-only | $0.094/sec | $0.47 | $0.94 |
| Seedance 2.5, 480p | $0.20/sec | $1.00 | $2.00 |
| Seedance 2.5, 720p | $0.30/sec | $1.50 | $3.00 |
| Seedance 2.5, 1080p | $0.68/sec | $3.40 | $6.80 |
| Wan 3.0, 1080p | $0.20/sec | $1.00 | $2.00 |
| Gemini Omni Flash 1.1, 720p | $0.10/sec | $0.50 | $1.00 |
| Runway Gen-4.5, output video | $0.12/sec | $0.60 | $1.20 |

These simple examples assume output-only billing, no reference video, no optional surcharges and no minimum charge. They are not universal job quotes.

### Provider-specific billing rules that affect the invoice

- **Kling 4.0:** input-video jobs use a different rate and bill additional seconds based on output duration plus the longer of input-video duration and output duration. HDR adds a separate surcharge at supported resolutions. Kling 4.0 Flash has a distinct output-only rate and a different input-video formula.
- **Seedance 2.5:** 480p/720p/1080p/4K output is $0.20/$0.30/$0.68/$1.10 per second, with an $0.80 minimum charge. Reference video is billed separately at half the output rate per second; image/audio references add no charge. Draft mode is two billable generations (480p preview plus 1080p enhancement), not a free preview. Moderation failures may still be charged, so they must not be automatically retried.
- **Gemini Omni Flash 1.1:** resolution changes the rate; generated audio is included in the listed video rate, and input-video references can add charges.
- **Wan 3.0:** model tier and resolution determine the rate; Prime is a separate higher-priced tier.
- **Gen-4.5:** output resolution, audio, HDR / bit-depth and certain editorial-container options can change the final rate.

The pricing engine must use the exact provider/model/operation formula, supported input types, duration, resolution, audio options, minimums, effective date and source. Do not infer a rate for a model merely because another provider hosts it. A rate-card estimate is still non-billable; task-correlated provider usage or invoice evidence is required for settlement.

### Official pricing evidence

- Runway Dev current pricing article (updated November 4, 2026; pricing snapshot checked November 22): https://dev.runway.com/learn/ai-video-api-pricing
- Runway Dev Seedance 2.5 API billing guide (pricing current November 21, 2026): https://dev.runwayml.com/learn/seedance-2-5-api
- Runway Dev pricing and API rate card: https://dev.runway.com/pricing
- Runway Dev Kling 4.0 API billing details: https://dev.runwayml.com/learn/kling-4-0-api
- Runway API pricing guide: https://docs.dev.runwayml.com/guides/pricing/

The previous temporary Kling 4.0 promotional-rate row has been removed from the current baseline snapshot. Promotions must be represented as explicit dated price-card versions, never silently treated as the permanent list rate.

## Required billing domain model

Implement or map the following concepts to existing project conventions before creating parallel abstractions:

- `Plan`: stable plan ID, display name, price, currency, billing interval, entitlement version, status.
- `Entitlement`: monthly credit grant, seats, workspace count, feature/model access, commercial-use rights, limits.
- `Subscription`: customer, provider subscription reference, plan/version, status, period boundaries, cancellation state.
- `CreditAccount`: customer/workspace owner, currency-independent integer credit balance, account status.
- `CreditLedgerEntry`: immutable ID, account, event type, signed amount, idempotency key, related job/order/subscription, pricing version, timestamp and metadata.
- `CreditReservation`: job, quoted credits, reserved amount, expiry, state and idempotency key.
- `ProviderRateCard`: provider, model, operation, resolution, audio/input rules, billing unit, rate, currency, effective dates, source and version.
- `UsageRecord`: job/provider task ID, actual units, actual provider cost, currency, rate-card version, status and reconciliation evidence.
- `CreditPackOrder`: product, amount, paid status, provider payment reference and fulfillment state.
- `BillingWebhookEvent`: provider event ID, type, received time, signature verification result, processing state and deduplication key.

Use the existing database and migration conventions after inspecting the repository. Do not add a second billing schema or introduce a new paid database.

## Ledger and job lifecycle invariants

1. A quote is read-only and does not deduct credits.
2. A billable job reserves credits atomically before dispatch.
3. The reservation has an idempotency key unique to the logical job.
4. Successful completion captures the authorized amount or reconciles against actual usage under the approved policy.
5. A provider failure releases the reservation only after the provider outcome is known. Unknown / timed-out outcomes remain pending reconciliation; do not automatically refund a job that may have completed.
6. A user cancellation releases credits only when the provider's cancellation and charge semantics confirm the outcome.
7. Duplicate webhooks, queue deliveries and client retries cannot double-grant or double-charge.
8. Refunds, adjustments and subscription grants are compensating ledger entries; never edit or delete prior ledger rows.
9. Subscription credit grants are idempotent per subscription and billing period.
10. Enforce account, workspace and job ownership on every read and write.

## Margin, abuse and financial controls

- Per-user, workspace, plan and global spend ceilings.
- Maximum duration, resolution and concurrent billable jobs by entitlement.
- Provider circuit breaker and budget exhaustion guard.
- Preflight balance check and server-side quote validation.
- Daily provider-spend alerts and per-model margin reports.
- Provider invoice / usage reconciliation and variance alerts.
- Fraud controls for repeated account creation, payment retries and promotional credit abuse.
- Explicit treatment of failed, moderated, cancelled and timed-out provider tasks.
- No negative balances except a deliberately approved enterprise invoicing contract.
- No unlimited premium generation unless a provider contract and measured capacity make the economics safe.

## Subscription and entitlement behavior

- Separate plan catalog from payment-provider product IDs.
- Version entitlements so existing customers retain the correct historical terms.
- Upgrade, downgrade, pause, cancel-at-period-end, failed-payment grace and reactivation states.
- Webhook signature verification, event deduplication and replay-safe processing.
- Do not grant paid credits based solely on a browser redirect or client callback.
- Keep billing access controls separate from administrative role checks.
- Clearly disclose credit expiry, rollover, top-up expiry, refunds and cancellation rules before purchase.
- Enterprise custom pricing and invoicing require contract-specific terms.

## Staged implementation sequence

### Batch A — inspect and establish contracts
- Map existing auth, database, job queue, provider adapters, usage tracking and audit conventions.
- Reuse existing domain models and migrations where present.
- Add rate-card and quote contract tests using deterministic fixtures.
- Keep external provider calls disabled in tests.

### Batch B — internal cost and quote engine
- Add provider rate-card registry with versioned effective dates.
- Add model-specific cost calculators for output duration, input references, resolution and audio.
- Add server-side quote endpoint and pre-submit UI quote.
- Test rounding, minimum charges, missing rates, expired rates and unsupported settings.

### Batch C — credit ledger and reservations
- Add append-only ledger, idempotent grants, reservations, capture, release and refund adjustments.
- Add concurrency and duplicate-delivery tests.
- Add job-to-usage reconciliation without changing production balances.

### Batch D — subscription lifecycle in test mode
- Implement plan catalog and entitlements.
- Add payment-provider adapter behind disabled-by-default configuration.
- Verify signed webhooks and replay protection in sandbox/test mode.
- Test subscription period transitions, failed payments, cancellation and top-up fulfillment.

### Batch E — launch gates
- Verify margins using actual provider invoices and observed retry/failure rates.
- Validate payment fees, local tax / compliance and supported settlement currencies.
- Run staging end-to-end purchase → webhook → entitlement → quote → reserve → generation → reconcile.
- Require explicit owner approval before enabling live payments, paid generation, production migrations or production deployment.

## Acceptance criteria

- Every billable model/setting has a versioned cost formula or is unavailable for paid use.
- A user sees a server-calculated credit quote before starting a billable job.
- No job dispatch occurs without a valid reservation and entitlement.
- Duplicate requests and webhook deliveries cannot double-charge or double-grant.
- Unknown provider outcomes are reconciled rather than blindly refunded.
- Every ledger change is attributable, immutable and auditable.
- Per-model gross margin can be calculated from actual usage and reconciled provider costs.
- Pricing, entitlements and payment execution remain disabled in production until the launch gates are explicitly approved.

## Explicit non-goals for this milestone

Do not invent monthly credit allowances or claim the proposed subscription prices are market validated. Do not enable real payments, buy provider credits, create paid infrastructure, migrate production data, merge to `main`, or deploy production as part of this specification.
