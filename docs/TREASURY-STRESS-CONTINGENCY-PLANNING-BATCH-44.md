# Batch 44 — Treasury Stress Testing & Contingency Funding Plan

## Delivered
- Finance-admin-only creation of reusable, effective-by-evidence treasury stress scenarios.
- Separate inflow reduction, outflow increase and immediate cash shock assumptions.
- 13-week weekly stress projections layered over the captured base cashflow forecast.
- Minimum cash floor breach and negative-cash survival dates, plus lowest stressed closing cash.
- Immutable run snapshots so later forecast changes do not rewrite prior stress results.
- Evidence-backed contingency funding options with estimated capacity, lead time and readiness classification.
- Financial Command Centre forms, scenario selector, stress-run history and contingency option register.

## Model semantics
- The scenario applies a uniform percentage reduction to forecast receipts and a separate percentage increase to forecast payments.
- A one-off cash shock is deducted from opening available cash before the first weekly period.
- Receipt confidence and existing baseline assumptions remain inherited from the captured forecast.
- The configured minimum cash floor is compared to every stressed weekly closing balance.
- No probability is assigned to a stress scenario; results are deterministic sensitivity analysis.
- A run requires a current captured cash position and baseline weekly forecast for the selected currency.

## Contingency funding governance
- Options may include receivables acceleration, discretionary spend reduction, supplier terms, committed facilities, asset monetization and owner funding.
- Each option records currency, estimated capacity, lead time, evidence reference, rationale and readiness status.
- Validated, conditional and unverified options remain explicitly distinguished.
- Gross estimated capacities are not summed into available liquidity and do not close a modeled funding gap automatically.
- No facility drawdown, asset sale, payment deferral, payment initiation or transfer is executed.

## Controls
- All operations require owner, platform administrator or billing administrator authorization.
- Scenario definitions, stress run snapshots and contingency options are append-only.
- Idempotency keys prevent duplicate scenario and option submissions.
- Inputs enforce currency, multiplier, amount, lead-time and evidence bounds.
- API tests cover authorization, invalid multiplier rejection, scenario persistence and protected stress execution.
- Disposable PostgreSQL integration covers scenario idempotency, 13-week stress results, floor breach, contingency options, run persistence, authorization and immutable evidence.

## Research alignment
The design follows established liquidity risk principles: severe-but-plausible firm-specific and market-wide stress, multiple time horizons, documented assumptions, quantified funding gaps, contingency source readiness, lead times, escalation and management ownership. This is a corporate treasury decision-support implementation, not a regulatory liquidity adequacy calculation for a bank.

## References
- Federal Reserve, Interagency Policy Statement on Funding and Liquidity Risk Management: https://www.federalreserve.gov/frrs/guidance/interagency-policy-statement-on-funding-and-liquidity-risk-management.htm
- Basel Committee on Banking Supervision, Liquidity risk management and supervision: https://www.bis.org/committees/bcbs/basel-consolidated-guidelines/module/lqy/10
- OSFI, Liquidity Principles: https://www.osfi-bsif.gc.ca/en/guidance/guidance-library/liquidity-principles-guideline-2020

## Release safeguards
- Draft PR #335 only; no production migration, deployment, bank connection, facility drawdown or payment execution.
- CI uses disposable PostgreSQL. Existing production resources remain untouched.
