# Batch 38 — Executive Financial Workspace: Customer Economics

## Scope
Bring Batch 37's read-only subscription customer economics report into the existing Financial Command Centre. This is a real UI integration over the protected API, not a mock dashboard.

## Delivered
- Load customer economics alongside existing financial command-centre datasets.
- Display currency-separated summary metrics for subscription MRR, net cash receipts, direct contribution and negative-contribution customers.
- Display ranked customer rows with plan/version, MRR, net cash, refunds, direct costs, contribution, margin, credit consumption, multimodal usage counters and cost-evidence status.
- Add a reporting-month selector and refresh action with strict first-of-month validation.
- Preserve the existing 60-second finance workspace refresh cadence.
- Keep all report content read-only; no pricing, subscription, credit, payment or ledger mutations are exposed in this panel.
- Show source limitations and evidence status rather than filling missing values with estimates.

## Metric presentation
- MRR remains a recurring run-rate metric, not cash receipts or recognized accounting revenue.
- Cash collected, refunds and net cash are presented separately from MRR.
- Direct contribution only includes posted, customer-attributed costs in the same currency.
- Workload telemetry is diagnostic evidence, not a second cost posting.
- Credits remain operational units and are never displayed as money.
- Currency groups are never summed together.
- Customer margin statuses reflect configured margin policy and the report's evidence classifications.

## Validation
- Financial API tests include UI contract assertions for the report section, period control, refresh path, currency separation and read-only semantics.
- Billing self-service CI type-checks the TypeScript application and runs the disposable PostgreSQL migration chain.
- Financial CI runs API and SQL evidence contract tests.

## Release controls
- UI work is staged on the Batch 37 review branch.
- No production deployment, Supabase migration application, billing change, provider execution or paid infrastructure.
