

# Batch 42 — Liquidity Guardrails & Reserve Planning

## Delivered
- Currency-specific, effective-dated minimum available-cash floors and operating reserve targets.
- Append-only policy evidence with source references, rationale and payload-bound idempotency.
- Protected finance-admin API to record policies and retrieve guardrail analysis.
- Base, downside and upside scenario headroom against each currency's active minimum floor.
- Lowest projected closing cash, lowest floor headroom, first projected floor-breach week and maximum reserve gap.
- Financial Command Centre policy capture form, active policy table and scenario guardrail comparison.

## Policy semantics
- The minimum cash floor is the lowest permitted projected available-cash balance for operational escalation.
- The reserve target must be greater than or equal to the minimum floor.
- Policies apply only from their effective date and are never edited or deleted; a new effective-dated record supersedes the earlier policy.
- A currency without a configured policy remains unscored against a fabricated default threshold.
- Headroom equals projected closing available cash minus the minimum cash floor.
- Reserve gap equals the positive difference between the reserve target and projected cash; it is not a funding commitment or payment instruction.
- Restricted cash remains excluded from projected available liquidity.

## Verification
- API tests cover authorization, invalid floor/reserve combinations, policy recording and guardrail response handling.
- Disposable PostgreSQL integration verifies scenario-specific headroom, first floor-breach date, reserve gap, currency isolation, idempotency, conflicting replay rejection, append-only policy evidence and unauthorized reads.
- CI applies Batch 42 after Batches 40 and 41 in the disposable PostgreSQL test database.

## Release safeguards
- Development remains on the existing draft review PR #335.
- No production migration, production deployment, bank connection, payment initiation or new paid infrastructure.
- Guardrails are advisory policy thresholds; they do not automatically block or execute payments.
