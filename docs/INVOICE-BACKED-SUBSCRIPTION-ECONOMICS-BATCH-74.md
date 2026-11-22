# Batch 74 — Invoice-backed cost evidence in subscription economics

**Status:** implemented on a draft branch; CI verification pending.  
**Purpose:** connect the existing immutable invoice-attribution and settled-credit-reservation evidence to the Batch 72/73 subscription plan and mixed-workload economics response.

## What changed

- The finance-admin-only `POST /api/admin/finance/subscription-plan-economics` endpoint now derives historical cost evidence on the server for a selected reporting month.
- Evidence uses the existing `ai_usage_cost_events`, `financial_cost_attribution_links` and `billing_credit_reservations` records.
- The Batch 55 derivation requires at least five complete verified jobs, exactly one immutable USD invoice attribution per usage event, and exactly one settled positive-credit reservation per job.
- Query windows are bounded at 1,000 rows. A result at the cap is treated as potentially truncated; attribution/reservation result caps also invalidate the sample.
- The response exposes period, currency, sample jobs/credits, invoice-backed provider cost, conservative per-platform-credit cost, exclusions, verified coverage, evidence timestamp and status.
- Provider list-price scenarios remain explicitly forecast-only. The blended historical platform cost is never substituted for model-specific provider pricing.
- Model/operation-level actual workload costs remain unpriced until invoice attribution can reliably identify the exact model, operation and request dimensions.
- Allowance readiness is always non-publishable and requires separate finance/product approval, even when the evidence sample is verified.

## Safety properties

- Finance administrator authorization is required before financial data is read.
- Browser input cannot provide invoice amounts, cost-per-credit evidence, or approval flags.
- The implementation performs read-only database requests only.
- It does not grant credits, update subscriptions, publish plan allowances, activate checkout, generate content, post invoices, run migrations, or call a provider.
- Existing wallet, reservation, settlement and ledger systems remain authoritative.

## Interpretation

The returned blended cost is historical platform-level evidence, not a provider rate card and not a reliable cost allocation for every model. It may be useful as a conservative aggregate signal, but model-specific and mixed-workload actual costs must remain unpriced until the source evidence supports that attribution.

The $9 / $29 / $79 / $199 monthly prices remain test hypotheses. Enterprise remains custom-priced. No included-credit quantity is approved by this batch.
