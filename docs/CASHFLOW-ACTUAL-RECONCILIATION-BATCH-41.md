# Batch 41 — Cashflow Actuals & Forecast Reconciliation

## Delivered
- Protected finance-admin API to record actual receipts and payments against a specific planned or committed cashflow item.
- Partial settlement support: one scheduled item may have multiple separately evidenced actual movements.
- Currency-separated forecast-versus-actual reconciliation by expected date window.
- Confidence-adjusted receipt forecast comparison; scheduled outflows compare at their full expected amount.
- Favorable variance uses actual minus forecast for receipts and forecast minus actual for payments. Positive values are favorable.
- Remaining forecast amount, settlement state, actual movement count and latest actual date.
- Actual evidence details are retained with the reconciliation output.
- Financial Command Centre UI to record actual cash movements and review currency totals and item-level variances.

## Evidence and control model
- Actual movements must reference an existing planned or committed cashflow item owned by the authenticated finance administrator.
- Actual dates cannot be in the future; amounts must be positive safe integers in currency minor units.
- Multiple actual movements can settle one expected item partially or cumulatively.
- Idempotency keys are payload-bound: a repeated key with changed item, amount, date or evidence is rejected.
- Actual movement records are append-only. Corrections require a new evidence movement rather than editing or deleting history.
- Unmatched bank movements are not silently allocated; explicit matching is required.
- Currency totals are never combined or converted.
- The latest actual date is shown for partial settlements, but a partial settlement is not represented as a final settlement-delay measure.

## Verification
- API tests cover administrator authorization, invalid evidence, actual movement recording, date-range validation and reconciliation response handling.
- Disposable PostgreSQL integration tests cover partial settlement, over-settlement, favorable variance arithmetic, currency totals, idempotent replay, conflicting idempotency payloads, append-only evidence and unauthorized writes.
- CI applies Batch 41 only after Batches 37, 39 and 40 in its disposable PostgreSQL database.

## Release safeguards
- Development remains on the existing draft review PR #335.
- No production migration, production deployment, bank connection, payment initiation or new paid infrastructure.
- Existing production services and unrelated resources remain untouched.
- This is a reconciliation workflow, not a bank-feed integration or accounting ledger replacement.
