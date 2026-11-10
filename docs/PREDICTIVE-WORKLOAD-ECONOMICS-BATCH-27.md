# Batch 27 — Predictive Workload Economics & Intelligent Pricing

## Purpose

Estimate the economic impact of a creative workload before execution, then compare candidate model economics without changing production routing.

## Delivered

- Pure, deterministic workload cost estimator with explicit, versioned provider rate cards.
- Supported rate dimensions: input/output tokens, images, video seconds, render seconds, GPU seconds, CPU seconds, storage GB-days and egress GB.
- Integer minor-unit arithmetic with ceiling rounding; no floating-point currency totals.
- Base, low and high cost ranges with a configurable uncertainty reserve.
- Cost per successful output.
- Minimum price floor using target gross margin, payment percentage fee, fixed payment fee and support reserve.
- Admin-only workload estimate API and model-economics comparison API.
- Financial Command Centre preflight estimator for image generation, video generation and render compute.
- Candidate comparison requires a shared currency, at least 20 measured evaluation samples, a versioned evaluation set, quality score and P95 latency.
- Shadow-only recommendations select the lowest worst-case estimated cost among candidates meeting explicit cost, quality and latency limits.

## APIs

- `POST /api/admin/finance/workload-estimates`
- `POST /api/admin/finance/model-economics-comparison`

Both routes require owner, platform_admin or billing_admin. They calculate in memory and do not write financial ledger records, invoke providers, or modify customer plans.

## Financial safeguards

- Rate cards are explicit caller-supplied inputs with provider, model, currency and version. No provider prices are hardcoded or inferred.
- All compared rate cards must use the same ISO currency; no FX conversion is attempted.
- Every requested quantity must have a corresponding explicit rate.
- Cost forecasts are not invoices, provider quotes, actual costs, or guaranteed charges.
- No job is executed and no cost is posted by the estimator.
- No customer plan, price, quota or subscription is modified.
- Model recommendations are shadow-only. Automatic production routing is disabled.
- No recommendation is eligible without at least 20 measured evaluation samples, a versioned evaluation set, valid P95 latency, and satisfaction of cost/quality/latency limits.
- Taxes, discounts, refunds, FX and other omitted dimensions must be explicitly modelled before treating a price floor as a final retail price.

## Validation

- Pure module tests cover token/resource costing, rate-card completeness, currency checks, cost range, price-floor arithmetic, invalid assumptions and model quality/latency gates.
- Financial API tests cover admin authorization, forecast-only response semantics, invalid currency rejection and shadow-only model comparison.
- TypeScript application includes a preflight estimator for image, video and render workloads.

## Rollout

Draft PR only. No production deploy, production routing changes, live pricing updates, customer billing changes or database migrations are included.
