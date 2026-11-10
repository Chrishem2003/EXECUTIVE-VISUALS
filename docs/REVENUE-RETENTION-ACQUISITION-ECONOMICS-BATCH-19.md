# Batch 19 — Revenue Retention & Acquisition Economics

## Delivered

Batch 19 extends the Financial Command Centre with evidence-backed retention and acquisition reporting.

- Append-only, month-keyed customer subscription revenue snapshots.
- Cohort-level gross revenue retention (GRR) and net revenue retention (NRR).
- First-paid cohort month preserved with every snapshot.
- Manual acquisition campaign spend ledger with currency, channel, campaign, period and idempotency key.
- Immutable first-touch customer acquisition attribution for paid subscribers.
- Channel-level CAC calculated only from recorded spend and explicitly attributed new paid customers in the same month and currency.
- Forecast-versus-actual MRR error reporting when a subsequent real snapshot is close enough to a forecast horizon.
- Protected admin APIs and Financial Command Centre views for snapshot capture, spend recording and attribution.
- Audit events for snapshot capture, acquisition spend and first-touch attribution.

## Metric definitions

### Monthly revenue snapshots

The admin action captures every known paid customer, including zero-MRR customers whose latest subscription is no longer active. The snapshot records current paid MRR, currency, paid cohort month and subscription status.

- Monthly subscriptions use their stored monthly amount.
- Annual subscriptions are normalized to one-twelfth of the annual amount.
- Currency is never silently converted.
- The snapshot month is the first calendar day of the current month.
- The first snapshot for a month is immutable and idempotent.
- Only the current month can be captured. The system does not fabricate prior months.

### GRR and NRR

For the same opening paid cohort and currency:

- GRR = sum of each opening customer's MRR capped at their opening MRR, divided by opening cohort MRR.
- NRR = ending MRR for the opening cohort, including expansion and contraction, divided by opening cohort MRR.
- New customers acquired after the opening snapshot are excluded.
- Churned customers remain in the denominator with zero ending MRR.
- Results are reported by original paid cohort month and currency.
- Comparisons are withheld until two distinct monthly snapshots exist.

### CAC

Channel CAC = recorded net acquisition spend for a calendar month and currency divided by distinct new paid customers attributed to that channel and first-paid in that same month.

- Spend is manually recorded in currency minor units.
- Customer attribution is first-touch and immutable.
- Customers without a verified paid subscription record cannot be attributed.
- Unattributed customers do not enter the CAC denominator.
- No currency conversion or estimated marketing cost is invented.
- CAC payback remains unavailable until gross-margin and variable service-cost accounting is instrumented.

### Forecast accuracy

The report compares stored base-case forecast ending MRR with a later actual snapshot near the target horizon. A subsequent snapshot must fall within 15 days of the horizon date. Mean absolute error and mean absolute percentage error are reported by horizon and currency.

This is an early measurement harness. It is not a calibrated model score or a statistically stable benchmark until enough observations accumulate.

## Security and audit

- All write and read endpoints require owner, platform-admin or billing-admin authorization.
- SQL functions independently verify the authenticated administrator identity passed by the API.
- Evidence tables are service-role only and have update/delete-blocking triggers.
- Customer attribution and campaign spend are recorded with actor IDs, timestamps and idempotency keys.
- Administrative writes are added to the existing append-only financial admin audit log.
- No payment credentials, customer prompts, creative media or private content are copied into revenue snapshots.
- No marketing messages, charges, refunds, subscription changes or customer entitlements are triggered.

## Validation

The billing CI workflow applies this migration after Batch 18 in disposable PostgreSQL. Integration assertions cover:
- Snapshot capture and idempotent replay.
- Acquisition spend recording.
- First-touch paid-customer attribution.
- Channel CAC reconciliation.
- Suppression of retention comparisons before a second real snapshot exists.

API tests cover admin authorization, snapshot actor binding, acquisition spend validation and attribution validation. TypeScript and financial API syntax checks run in the same workflow.

## Operational cadence

Capture one snapshot per calendar month from the admin Financial Command Centre. For dependable monthly comparisons, capture near the same point in each month. A future scheduled job can automate this after the organization approves the reporting cadence and scheduler.

## Remaining evidence requirements

- CAC payback: provider fees, infrastructure cost allocation and support/service cost per customer.
- Channel ROI: acquisition spend and attribution across enough cohorts and conversion windows.
- Forecast calibration: repeated forecast snapshots and subsequent actual snapshots for each horizon.
- Revenue recognition and cash forecasting: invoice schedules, payment timing, provider fees, refunds and settlement timing must remain separate from MRR.
