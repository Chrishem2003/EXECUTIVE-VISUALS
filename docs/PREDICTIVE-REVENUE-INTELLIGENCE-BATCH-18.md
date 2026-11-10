# Batch 18 — Predictive Revenue & Customer Intelligence

## What this adds

Batch 18 extends the Financial Command Centre with an auditable, scenario-based revenue outlook and customer economics summary.

- Current paid MRR and ARR run rate by currency.
- 30-, 60-, 90- and 365-day ending-MRR scenarios.
- Conservative, base and upside churn-sensitivity cases.
- Estimated revenue-at-risk from the modeled change in ending MRR.
- Observed paid-subscription cancellation hazard from the prior 180 days.
- Sample size and explicit confidence labels.
- Realized average customer revenue after recorded completed refunds.
- A conservative scenario LTV estimate where the data threshold is met.
- Upcoming renewal exposure, past-due subscribers, high-engagement expansion-review candidates and recent win-back candidates.
- Hourly forecast snapshots with model version and aggregate input counts.

## Forecast model

This is a transparent scenario model, not a trained machine-learning classifier.

1. Current paid MRR is calculated from active and past-due paid subscriptions. Yearly, quarterly, weekly and daily plan amounts are normalized to a monthly run rate.
2. The six-month paid cancellation fraction is calculated from distinct activated paid customers and distinct cancelled/expired paid customers in the same 180-day evidence window.
3. The monthly churn hazard is derived by converting that six-month survival fraction to a monthly rate.
4. Base case applies the observed monthly rate; conservative applies 1.5x the rate; upside applies 0.75x the rate. Rates are bounded to prevent nonsensical projections.
5. The four horizons project ending MRR and the difference from current MRR. They do not include future new sales, expansion, contraction, price changes, fees, taxes or FX movements.
6. The LTV estimate starts from observed average net paid revenue per payer and adds modeled remaining recurring revenue using current MRR per active subscriber and the observed monthly churn rate, capped at 36 months. It is withheld when evidence is insufficient.

## Confidence and evidence limitations

- Fewer than 20 activated customers in the evidence window: insufficient_data.
- 20–99 activated customers: low.
- 100 or more activated customers: moderate.
- LTV has separate thresholds based on payer and cancellation counts.
- The current system does not yet capture acquisition campaign spend or consistently attributed acquisition source; CAC and channel profitability are explicitly not_instrumented.
- High-health active customers are expansion-review candidates only. No upgrade is assumed or automatically applied.
- Recent cancelled/expired customers without a current active subscription are win-back candidates only. No marketing communication is sent.
- Refunds are deducted only when the refund record has a completed/successful/succeeded status.
- All currency amounts remain separated; no FX conversion is invented.

## Security and operational behavior

- API route requires an authenticated account and a platform, owner or billing administrator role.
- Database function independently checks the administrator role.
- Snapshot table and function are service-role only.
- Forecast records contain aggregate data, not customer email, prompts, creative assets or payment credentials.
- Snapshot generation is throttled to one new snapshot per hour, avoiding a database write on every dashboard refresh.
- Forecasting does not initiate charges, refunds, cancellations, subscription changes, customer outreach or entitlement changes.

## Validation

The billing CI workflow applies this migration after the subscription growth migration in disposable PostgreSQL. Integration assertions cover:
- Currency-level forecast presence.
- All four forecast horizons.
- Conservative, base and upside scenarios.
- Explicit CAC-not-instrumented state.
- Forecast semantics and persisted snapshot ID.

API tests cover administrator authorization, authenticated actor binding, disabled-billing behavior and scenario response semantics.

## Follow-on work

- Instrument acquisition source and campaign spend before CAC/payback calculations.
- Capture dated subscription state snapshots for true historical retention curves and backtesting.
- Add model calibration and forecast-vs-actual error reporting after enough history accumulates.
- Add experiment outcome instrumentation before reporting statistical lift.
- Add provider fees, taxes, refunds timing and settlement schedules for a separate cash forecast.
