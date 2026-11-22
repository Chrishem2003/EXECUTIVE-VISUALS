# Commercial production — five-priority implementation batch

**Date:** 2026-11-22  
**Branch:** `feat/commercial-production-five-priority-batch-2026-11-22`  
**Release posture:** staging-first, no live payments, no production migrations, no provider execution enabled by this batch.

This batch connects the existing billing, credit reservation, provider cost, AI planning and video-studio surfaces instead of creating duplicate billing or job systems.

## Priority 1 — provider cost to customer credit economics

Added `server/customer-credit-economics.mjs`.

- Converts a source-attributed provider estimate into an integer customer-credit quote.
- Uses configured currency minor-unit scale, customer credit value, target margin, payment fee rate, retry reserve, infrastructure reserve and pricing version.
- Rounds required customer credits upward and verifies that fee rounding does not erode the configured target margin.
- Rejects missing/expired provider rate cards and missing customer credit policy; no fallback credit price is invented.
- Marks every result as preview-only. It cannot reserve credits, authorize a generation, or settle a provider invoice.

Required server-side configuration (do not set from browser input):
- `CUSTOMER_CREDIT_CURRENCY` — exact ISO currency for this credit price book; quotes in another currency fail closed until an explicit FX policy exists
- `CUSTOMER_CREDIT_VALUE_MINOR`
- `CUSTOMER_CREDIT_MINOR_UNITS_PER_MAJOR`
- `CUSTOMER_CREDIT_TARGET_MARGIN_BPS`
- `CUSTOMER_CREDIT_PAYMENT_FEE_BPS`
- `CUSTOMER_CREDIT_RETRY_RESERVE_BPS`
- `CUSTOMER_CREDIT_INFRA_RESERVE_BPS`
- `CUSTOMER_CREDIT_FIXED_PAYMENT_FEE_MINOR` — allocated share of fixed payment processing cost, not necessarily the entire top-up fee
- `CUSTOMER_CREDIT_PRICING_VERSION`

All values must be based on measured provider invoices, actual payment-provider fees, the supported currency and the commercial margin policy. Missing values intentionally produce an unavailable customer-credit quote.

The authenticated `/api/video-cost-estimate` and `/api/video-production-quote` endpoints now include `customerCreditQuote` alongside the existing provider estimate.

## Priority 2 — subscription entitlements

- Added a server-side entitlement evaluator that requires an active/trialing subscription and a server-loaded immutable entitlement snapshot.
- The existing PostgreSQL `assert_video_generation_entitlement` gate remains authoritative at atomic credit reservation time.
- The draft plan catalog from PR #759 now carries the proposed `ai_generation` and server-metered-credit policy flags needed by that gate.
- Every proposed plan remains `status='draft'`, `is_public=false`, and `included_credits=0`. No allowance, resolution cap, seat count or commercial-use right is invented.

The subscription plans cannot be activated or purchased until credit allowances, model entitlements, workspace seats, commercial rights, taxes and margins are approved.

## Priority 3 — payments and subscription lifecycle

Reuse the existing Paddle-primary / Pesapal-secondary integration:
- idempotent provider checkout reservations;
- provider-side price verification against the reserved server amount;
- signed Paddle webhook verification;
- Pesapal notification verification against the pending merchant reference, amount and currency;
- pending/uncertain checkout states that require reconciliation rather than blind retry;
- subscription lifecycle and payment history already covered by the existing billing service and tests.

The new draft plans have no active Paddle/Pesapal provider-price rows. No checkout can select them. No provider credentials, merchant settings or live payment flows were changed.

## Priority 4 — quality-gated model recommendations

Added `compareCommercialProductionCandidates`:
- compares customer-credit estimates only for candidates with current quotes;
- requires independent, versioned quality evaluation evidence and a minimum sample count;
- ranks eligible models by customer-credit cost and then measured quality;
- returns no recommendation when quality evidence is missing or insufficient;
- always returns `automaticRouting=false`.
- The authenticated `/api/video-model-recommendations` endpoint evaluates the current server rate-card catalog against server-configured quality evidence; it does not accept browser-supplied scores.
- Evidence records require a verified flag, at least 25 samples, a version, p95 latency, an HTTPS evidence reference and a SHA-256 evidence digest.
- The Video Studio exposes a comparison action and displays a recommendation only when the quality, sample, latency, rate-card and credit-price gates all pass.

This complements the existing model-router shadow evaluation and cost/quality guardrails. It does not silently route customers to a cheaper but unproven model. Production recommendation data must come from trusted evaluation records, not browser-submitted scores.

## Priority 5 — customer-facing studio quote preview

The Video Studio now has an **Estimate generation cost & credits** action.
- It sends the selected provider, model, duration, resolution, audio mode and reference-image count to the authenticated server estimate endpoint.
- It displays the provider estimate and, only when the server-side credit policy is configured, the customer-credit amount and estimated margin.
- It explicitly says when no verified rate card or customer-credit policy is available.
- It does not submit a job, reserve credits, call a provider or trigger a payment.

The existing Creative Director and storyboard compiler remain the planning stages; the existing approved workflow and cloud queue remain the execution path. The customer must still review and approve the exact production quote before any paid provider execution.

Model evaluation configuration:
- `VIDEO_MODEL_QUALITY_EVIDENCE_JSON` — server-maintained JSON array of verified provider/model evaluations with `sampleCount`, `qualityScore`, `p95LatencyMs`, `evaluationVersion`, `evidenceReference` and `evidenceSha256`.
- `VIDEO_MODEL_MIN_QUALITY_SCORE` — defaults to 0.90.
- `VIDEO_MODEL_MIN_EVALUATION_SAMPLES` — defaults to 25.
- `VIDEO_MODEL_MAX_P95_LATENCY_MS` — defaults to 30000.

If this trusted evaluation evidence is missing or invalid, the endpoint returns no recommendation. It never falls back to cheapest-only routing.

## Provider pricing evidence

Runway's current public pricing pages describe materially different billing rules by model, resolution, input-video duration, reference media and minimum charge. For example, Seedance 2.5 1080p is listed at $0.68 per output second plus $0.34 per second of input/reference video, with an $0.80 minimum; Kling 4.0 1080p is listed at $0.235 per second and input-video edits use a different formula. A dated promo may temporarily change Kling rates.

References:
- https://dev.runway.com/pricing
- https://docs.dev.runwayml.com/guides/pricing/
- https://dev.runwayml.com/learn/seedance-2-5-api
- https://dev.runwayml.com/learn/kling-4-0-api

Do not hardcode a single generic per-second formula for all models. Provider-specific estimators and verified invoices remain the source of truth.

## Verification added

- `server/tests/customer-credit-economics.test.mjs`
- `server/tests/customer-credit-economics-api.test.mjs`
- Existing `server/tests/provider-subscription-billing.test.mjs`
- Existing `server/tests/unified-subscription-billing.test.mjs`
- Existing `server/tests/provider-rate-cards.test.mjs`
- Updated `server/tests/subscription-pricing-hypotheses.test.mjs`

The connector can commit source and open a PR, but it cannot run the repository's Node test suite in the GitHub runner from this session. CI results must be checked on the PR before merging.

## Launch gates still required

1. Populate and verify provider rate cards from current official pricing and actual provider invoices.
2. Measure retries, failed jobs, moderation charges, payment fees and shared infrastructure allocation.
3. Approve the credit value, target margin, reserve policy and pricing version.
4. Set actual monthly credits and entitlements per plan only after cost modelling and customer research.
5. Configure Paddle and Pesapal provider product prices in test mode and pass signed-webhook / reconciliation acceptance tests.
6. Populate trusted model quality evaluations and minimum sample thresholds before enabling recommendations.
7. Verify the staging database, atomic credit reservation, job settlement and invoice reconciliation end to end.
8. Obtain explicit owner approval before production migration, live payments, paid provider execution or deployment.

## Explicitly not done

No migration was applied to any database. No PR was merged. No production deployment, payment activation, provider credit purchase, provider API call, subscription grant or customer credit grant was performed.
