# Batch 17 — Subscription Growth Engine

## Purpose

Move from customer-health scoring to measured subscription-retention operations. This batch adds paid-acquisition cohorts, a renewal attention queue, cancellation-reason reporting, intervention outcome tracking and a controlled experiment registry.

## Paid cohorts

- Cohort entry: customer's first paid subscription record (created_at on the earliest paid subscription).
- Current retention: customers in that original cohort whose latest subscription status is currently active or past_due, divided by original paid cohort size.
- Cohort age: whole calendar months since the first-paid month.
- The dashboard explicitly labels this as a current status snapshot, not a historical month-by-month survival curve. It does not invent past states that the available event history cannot prove.

## Renewal attention

The watchlist includes subscriptions whose current_period_end is within the next 30 days and whose current state is active or past_due. It includes plan, billing interval, period end and the existing explainable customer-health score.

Attention labels are deterministic operational suggestions:
- payment_recovery for past-due subscriptions
- retention_checkin for health scores below 50
- renewal_value_checkin otherwise

These are not machine-learning predictions and do not send messages, initiate charges or change entitlements.

## Cancellation reasons

The dashboard aggregates recorded cancelled subscription events over 180 days. Missing reasons remain visible as Reason not recorded; they are not inferred from activity.

## Customer-success interventions

Administrators can create an intervention for an identified customer, approve or dismiss it, and complete it with an explicit outcome:
- renewed
- reactivated
- expanded
- engaged
- no change
- declined
- unreachable
- not applicable

The overview reports completed interventions and positive outcomes. An intervention is a human-reviewed work item, not an automated campaign.

## Controlled experiments

The experiment registry supports a hypothesis, primary metric, 2–4 variants, lifecycle status and optional start/end times. Assignments are stable per authenticated customer and experiment key; the service derives customer identity from the verified session.

Assignment counts are not presented as causal lift. A completed experiment requires adequate sample size, valid exposure and outcome instrumentation before a causal conclusion is justified. No customer is enrolled in an experiment by the admin overview itself.

## Security and privacy

- Customer-facing assignment endpoint accepts an experiment key only; owner identity is derived from the authenticated session.
- All administrative growth and intervention endpoints enforce the platform/billing administrator role.
- Service-role-only database functions and tables.
- No prompts, media, filenames, creative content or payment credentials are included in growth analytics.
- No automatic outreach, refunds, charges, cancellation, account restrictions or entitlement changes.

## Validation

The disposable PostgreSQL integration workflow applies Batch 17 after Batch 16 and verifies:
- Experiment creation and activation
- Stable, idempotent assignment for the same authenticated customer
- Intervention creation and outcome completion
- Required cohort, renewal, cancellation and experiment sections in the admin overview

API tests cover administrator authorization, cohort response shape, experiment validation, authenticated assignment scoping and intervention outcome validation.

## Next work

- Persist renewal/activation outcome snapshots for exact historical cohort curves.
- Add intervention-to-renewal attribution windows and holdout comparisons.
- Build sample-size-aware experiment analysis with confidence intervals.
- Add paid cohort MRR/NRR curves segmented by currency and plan interval.
- Add consent-aware win-back messaging only after provider, unsubscribe and compliance controls are verified.
