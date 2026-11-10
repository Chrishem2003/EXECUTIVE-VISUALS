# Batch 46 — Financial Scenario Intelligence (calculation core)

## Scope

This increment adds a deterministic, unit-tested calculation engine for sensitivity analysis, break-even modelling, forecast scenarios, evidence-volume confidence and decision comparisons. It is a reusable domain module and does not write to financial ledgers or execute business actions.

## Calculations

- Monthly revenue path: prior-month revenue × (1 + growth − churn) + explicitly supplied new revenue.
- Variable cost: projected revenue × observed baseline variable-cost ratio × selected variable-cost-rate adjustment.
- Fixed cost: prior-month fixed cost compounded by selected fixed-cost growth.
- Net cash flow: collected revenue less variable costs, fixed costs and capex.
- Discounted operating contribution: monthly contribution discounted at the supplied monthly discount rate.
- Break-even revenue: fixed operating cost divided by contribution margin, withheld when contribution margin is non-positive.
- Sensitivity: one-factor favorable/adverse shocks for revenue growth, variable-cost rate, fixed-cost growth and churn, ranked by NPV swing.
- Decision comparison: probability-weighted discounted contribution less one-time investment.

## Evidence and safety semantics

- Amounts are integer minor units and one currency per run; no FX conversion or currency blending.
- Evidence months, source coverage and data age are explicit inputs. Confidence is an evidence-coverage label, not a statistical confidence interval.
- Downside/upside defaults are visibly marked illustrative. Replace them with approved assumptions before operational decisions.
- The module does not claim to verify referenced source documents or audited balances.
- The engine is pure and does not mutate payment, subscription, cost, customer or acquisition ledgers.
- No automatic payments, funding, price changes, acquisition spend or provider operations are triggered.

## Verification

Run node --test server/tests/financial-scenario-intelligence.test.mjs.

Tests cover monthly projection, cash and contribution arithmetic, break-even availability, downside/base/upside ordering, sensitivity ranking, probability-weighted decision comparison, evidence confidence, currency isolation and invalid-input rejection.

## Remaining integration work

This is the calculation-core milestone of Batch 46. The protected finance-admin report endpoint, persisted scenario snapshots, Financial Command Centre controls, evidence-source binding and disposable PostgreSQL integration remain required before Batch 46 is complete or released.
