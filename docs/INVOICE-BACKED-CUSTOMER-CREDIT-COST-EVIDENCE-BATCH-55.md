# Batch 55 — Invoice-backed customer credit cost evidence

**Status:** implemented; exact-head CI pending.  
**Scope:** replace the simulator's permanently empty provider-cost evidence input with a server-derived, read-only measurement from posted invoice attribution and settled customer credit reservations.

## Measurement method

For the selected reporting month:

1. Identify jobs with at least one metered usage event in the month.
2. Load every metered usage event associated with each candidate job, not just events in the selected month. A job is excluded if any associated event is unsuccessful or lacks exactly one invoice attribution.
3. Join usage events to immutable `financial_cost_attribution_links` created by the verified invoice-posting workflow.
4. Join each job to exactly one settled `billing_credit_reservations` row with a positive integer `actual_credits` value.
5. Include only USD invoice attribution amounts with valid invoice-import and invoice-line identifiers. No FX conversion is attempted.
6. Sum invoice-confirmed USD cents and settled customer platform credits across complete jobs. Calculate `ceil(total invoice cents / total settled platform credits)`, conservatively rounding the blended cost per customer credit up to a whole USD cent.

At least five fully reconciled jobs are required. This establishes a verified historical measurement, not a finance/product approval to publish allowances. Each candidate-month and full-job event query is bounded to 1,000 rows. Because the database API may itself cap returned rows, a result containing 1,000 rows is treated as potentially truncated: the sample is marked incomplete and no cost evidence is produced.

## Exclusions

A job is excluded when it has an unsuccessful event, missing or ambiguous invoice attribution, non-USD invoice cost, invalid invoice identifiers, no settled credit reservation, multiple reservations, or invalid/non-positive settled credits. Provider-reported costs and catalog estimates are never substituted for invoice amounts.

## Simulator integration

- The finance-admin-only subscription allowance simulation now derives evidence on the server.
- Browser input may choose the reporting month and scenario assumptions but cannot submit provider costs, invoice evidence, or approval flags.
- The response shows sample job count, settled credits, invoice-backed provider cost, conservative per-credit cost, excluded jobs and evidence status.
- When the minimum sample is met, the existing simulator calculates illustrative included-credit quantities from the measured blended cost. Every plan remains `publishable: false`; this batch does not update the public plan catalogue or grant entitlements.
- `invoice-attribution-derived-v1` identifies this calculation method, not a provider's model rate-card version.

## Limitations and approval

This is a historical blended platform cost for the complete jobs active in the selected month. It may not predict future model mix, provider price changes, retry patterns, taxes, discounts, FX, chargebacks or fully allocated shared overhead. The upward cent rounding is intentionally conservative but can materially reduce estimated allowances when average cost per platform credit is below one cent.

Finance and product owners must review the sample and separately approve any customer allowance before it can be published. No provider calls, database writes, invoice posting, payment, customer credit mutation, migration, production configuration, merge or deployment is included.
