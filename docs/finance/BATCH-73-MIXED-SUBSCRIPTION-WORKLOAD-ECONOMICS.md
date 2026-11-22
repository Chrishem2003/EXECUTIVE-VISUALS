# Batch 73 — Mixed Subscription Workload Economics

**Status:** read-only scenario analysis; staging-first  
**Date:** 2026-11-22  
**Parent:** Batch 72 subscription plan credit economics  
**Scope:** no entitlement writes, checkout activation, provider execution, migration or production deployment.

## Purpose

Batch 72 calculated hypothetical monthly credit allowances for the proposed $9 / $29 / $79 / $199 plans and showed how many generations of one model could fit. Batch 73 adds mixed workloads: customers may combine standard video, premium video and other model operations during one billing month.

## Calculation contract

The module consumes the already-calculated Batch 72 result and administrator-defined workload mixes. Each mix contains named lines with a zero-based scenario index and monthly quantity.

For every draft plan and workload, it reports total monthly credits required, estimated provider spend using dated Batch 72 prices, remaining credits or shortfall, provider cost as a ratio of proposed plan revenue, and contribution after estimated generation spend but before other operating costs.

The output is explicitly a mixed monthly workload scenario, not a customer entitlement, demand forecast or profitability guarantee.

## Guardrails

- Only the private draft plan economics output is accepted.
- Scenario indexes must refer to the same server-priced scenario array.
- Workload quantities and line counts are bounded.
- No client-supplied provider price or plan price is accepted by this module.
- No subscription plan, included-credit allowance, customer wallet or ledger is mutated.
- Enterprise remains unpriced and is not treated as an included-credit entitlement.
- Contribution is never labelled net profit; payment fees, support, storage, delivery, refunds, taxes, infrastructure and acquisition costs remain outside this calculation.

## Verification

Run npm run verify:mixed-subscription-workload-economics for focused tests covering aggregation, multiple mixes, cost ratios, enterprise handling, bounded inputs and read-only behavior.
