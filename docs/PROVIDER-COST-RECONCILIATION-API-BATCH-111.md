# Batch 111 — provider cost reconciliation report

## Endpoint

`GET /api/admin/finance/provider-cost-reconciliation`

Requires an authenticated `owner` or `platform_admin` role. A `billing_admin`
role alone is not sufficient. It is available through the opt-in platform finance
control plane even when payment processing remains disabled.

The report joins recent approved video-generation shots with their adapter-verified
provider outcome evidence and returns, per shot:

- Customer/owner, project, approval and shot identifiers.
- Provider, model, task state and currency.
- Estimated provider cost, reported actual provider cost and variance.
- Outcome classification, provider evidence ID, source reference, observation time,
  evidence digest, billable seconds, input-reference count and audio mode.
- Evidence coverage, missing/unknown/duplicate/mismatched counts and separate
  currency totals.

The endpoint reads at most 500 recent approvals, 500 tasks and 1,000 evidence rows.
If a limit is reached, it marks the report truncated and incomplete rather than
claiming complete coverage.

## Evidence semantics

- One matching evidence row with a valid task/provider/model/currency identity and
  consistent amount variance is reported as `verified_provider_reported`.
- Missing, unknown, duplicate, invalid or mismatched evidence is excluded from actual
  cost totals. For `unknown` outcomes, unavailable usage dimensions remain `null` in
  the report; `null` is not silently converted to zero. Charged and no-charge records
  still require complete usage dimensions.
- Multiple evidence records for one task are not summed automatically; they are
  flagged for reconciliation to prevent duplicate charging.
- Provider-reported actual cost is not the same as an independently matched provider
  invoice. The report labels this distinction explicitly.
- Currency totals remain separate; no FX conversion is inferred.
- Customer credit units are never treated as money or recognized revenue.

## Safety

Read-only reporting only. No provider calls, credit settlement, reservation release,
refund, ledger posting, payment activation or deployment is performed. The report
does not calculate gross margin or recognized revenue; those require verified
subscription/top-up revenue allocation and fully-loaded actual non-provider costs.
