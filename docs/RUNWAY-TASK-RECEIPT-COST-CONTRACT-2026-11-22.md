# Runway task-level cost receipt contract

**Checked:** 2026-11-22  
**Implementation branch:** `feat/integrated-commercial-platform-batch-2026-11-22`  
**Scope:** task-correlated realized cost for Runway generations. No provider request is made by this implementation change.

## Verified provider contract

Runway Dev documents that the final task response from `GET /v1/tasks/:id` includes the final cost under `cost.credits`. The documentation's task example shows a successful task with `cost: { credits: 50 }`. The routed-generation documentation separately describes `routing.estimatedCost` as a dry-run estimate; that field must never be used for settlement.

Primary sources checked on 2026-11-22:

- Task status / final task cost and model-router cost explanation: https://dev.runway.com/learn/choosing-the-right-model
- Task detail and API reference: https://docs.dev.runwayml.com/api/
- Model Router generation response and dry-run distinction: https://docs.dev.runwayml.com/model-routers/generating/
- Provider credit denomination: https://dev.runway.com/pricing (Runway Dev pricing states 1 credit = USD $0.01)

## Implemented normalization

1. The Runway adapter validates the requested task ID and successful task status.
2. It reads only `task.cost.credits` from the exact `GET /v1/tasks/:id` response.
3. It exposes that value as `actualCostCredits` on the normalized succeeded task.
4. `createRunwayTaskReceiptCostResolver` requires matching provider, model, task ID and successful status, plus a positive safe-integer credit count.
5. One provider credit is converted to USD $0.01; the result includes both `actualCredits` and a deterministic task receipt reference.
6. The shared job executor checks the realized amount against the approved provider budget and uses the actual provider credits for customer-credit settlement.
7. Missing, malformed, mismatched or estimated-only cost data fails closed. The reservation remains unresolved for reconciliation; the system does not substitute a price-card estimate.

## Composition and remaining gates

- The default task-receipt resolver is used for supported non-Veo Runway models.\n- The shared executor applies the same customer-credit conversion policy to verified USD costs from Runway, Fal and Luma; a missing policy quarantines the job rather than settling provider credits as customer credits.
- The existing linked Enterprise workspace usage readiness gate remains in place for Veo registration; its legacy usage lookup is not used as the settlement amount when the task receipt is present.
- Runway remote generation still requires the existing explicit environment opt-ins, provider key, subscription/approval controls, durable submission ledger, private output ingestion, media validation and customer-credit reservation.
- No remote Runway task was submitted during this change.
- Fal and Luma retain their provider-specific actual-cost resolvers. This change does not infer their costs from Runway semantics.
- Router dry-run estimates and published price-card estimates remain preflight-only, not settlement evidence.

## Acceptance tests

- Successful task receipt is converted to exact USD and customer-credit settlement units.
- Estimated-only task metadata is rejected as a realized cost.
- Wrong task ID, provider, model or task state is rejected.
- Zero, fractional, string, negative and unsafe credit amounts are rejected.
- Adapter tests prove the final task cost is retained and estimated cost is not promoted.
- Worker composition uses the task receipt resolver by default for supported non-Veo Runway models.

## Safety boundary

This is a code and contract change only. It does not activate worker execution, add provider credentials, create provider spending, change production settings, run a production migration, enable live payments, merge to `main`, or deploy the application.
