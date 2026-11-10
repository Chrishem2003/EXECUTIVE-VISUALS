# Batch 40 — Cash-Flow, Liquidity & Runway Intelligence

## Delivered
- Protected administrator APIs to capture actual cash positions, schedule expected cashflow items and read the cash forecast.
- Append-only cash position snapshots with available and restricted cash separated.
- Append-only, dated inflow/outflow records with evidence references, confidence basis points and planned/committed status.
- Currency-isolated base, downside and upside scenario forecasts.
- 13-week rolling view and six-month monthly view.
- 30-, 60-, 90- and 180-day horizon projections, projected shortfall flags, 30-day net burn and runway estimate.
- Financial Command Centre forms and tables for evidence capture, scenario review and scheduled cash items.

## Model controls
- Actual cash position must be captured from a bank statement, bank portal, cashbook or explicit manual attestation with a reference and note.
- Restricted cash is not counted as available liquidity.
- Expected receipts and payments are explicit dated items; MRR, invoice value and recognized revenue are not silently converted into cash.
- Receipt confidence is applied before scenario multipliers.
- Base scenario: 100% of confidence-adjusted receipts and 100% of scheduled outflows.
- Downside: 80% of confidence-adjusted receipts and 110% of scheduled outflows.
- Upside: 110% of confidence-adjusted receipts and 100% of scheduled outflows.
- Runway is shown only when the latest cash position is no more than 14 days old and 30-day net burn is positive.
- All cash evidence records are append-only; corrections require a new evidence record.
- Each currency is forecast independently; no FX conversion or bank integration is implied.

## Verification
- API tests cover admin authorization, invalid evidence, cash position recording, cashflow item validation and scenario response.
- Disposable PostgreSQL integration tests cover idempotent source recording, restricted cash exclusion, confidence-weighted receipts, base/downside/upside forecasts, runway arithmetic, liquidity shortfall flags, 13 weekly periods and six monthly periods.
- CI applies this migration only to the disposable PostgreSQL test database after Batches 37 and 39.

## Release safeguards
- Work remains in the open draft review PR #335.
- No production migration, production deployment, bank connection, payment initiation or new paid infrastructure.
- No production cash position or cashflow data is fabricated; the forecast remains empty until authorized finance administrators enter evidence.
