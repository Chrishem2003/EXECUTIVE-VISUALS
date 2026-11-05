# Runway task-cost evidence and reconciliation decision

**Repository:** `Chrishem2003/EXECUTIVE-VISUALS`  
**PR:** #34 — `feat/runway-video-adapter`  
**Decision date:** 2026-11-05  
**Status:** Release blocker; no provider activation.

## Problem

The hosted executor accepts an `actualAmount` only when a resolver supplies a non-empty evidence reference, the amount is finite/non-negative, the currency matches the reservation, and the amount does not exceed the approved reservation. It quarantines the job if any check fails.

Do not implement a resolver that simply copies the preflight estimate into `actualAmount`. That would relabel an estimate as actual cost and defeat the financial control.

## Verified provider evidence boundaries

The official Runway API reference exposes task detail and task cancellation, organization API-project usage, and (for eligible enterprise organizations) linked web-app workspace usage.

- The task API response examples expose `estimatedCost.credits`; the API reference does not establish that this estimate is a final settled charge.
- `POST /v1/organization/usage` reports API-project credit usage grouped by model and day. This is useful for aggregate reconciliation, but its documented grain does not by itself identify the charge for one CEV job.
- `GET /v1/organization/webapp/usage` provides per-generation rows for linked Runway web-app workspaces, but Runway explicitly distinguishes web-app credits from API-project credits. Do not use those rows as evidence for an API task charge.
- Runway workflow invocations expose `cost.credits` after every node has finished; the field may be absent on an initial `SUCCEEDED` response and requires retrieving the invocation again. This is a workflow-specific contract and must not be assumed for the direct Gen-4.5 task endpoint.
- Runway's task cancellation endpoint requests cancellation, but tasks already started may still finish and incur charges.

Official references:
- API reference: https://docs.dev.runwayml.com/api/
- Workspace reporting: https://docs.dev.runwayml.com/usage/workspace-reporting/
- Workflow execution and cost: https://docs.dev.runwayml.com/workflows/running/
- Pricing: https://dev.runwayml.com/pricing
- API FAQ / credit-pool separation: https://help.runwayml.com/hc/en-us/articles/50683115755155-Runway-API-FAQs

## Safe evidence workflow

Until Runway exposes a task-correlated API charge record, a manual reconciliation flow may be implemented only as an explicit, auditable operator action. It must not be an automatic fallback.

An evidence record should contain:

1. CEV job UUID and owner/project scope.
2. Provider name, model, Runway task UUID and CEV request hash.
3. Evidence source type (for example, provider invoice/export or provider support-confirmed record).
4. Immutable evidence reference and a retained evidence artifact/hash where policy permits.
5. Actual credit quantity, currency and USD conversion basis if the source is not USD.
6. Evidence capture timestamp and provider billing period.
7. Operator identity, review timestamp and a reasoned task-to-charge correlation explanation.
8. Reviewer decision and audit event ID.

The operator must establish the task-to-charge relationship, not merely temporal proximity or matching aggregate daily usage. If that link cannot be established, leave the job in `needs_input` and keep the reservation held.

## State-transition requirements

- Never turn `estimatedCost.credits` into actual spend without a provider contract explicitly defining it as settled.
- Never use daily/model/API-key aggregate deltas as a single-job invoice.
- Never use linked web-app usage rows to settle API-project charges.
- Never release a reservation after an ambiguous POST or an unresolved task.
- Never automatically repeat a provider POST after a timeout or uncertain task-ID persistence.
- A cancellation request is not proof of cancellation or a zero-cost outcome. Re-fetch task state and reconcile any charge/refund evidence before settlement.
- Evidence must be immutable or content-addressed, attributable to a named reviewer, and scoped to the exact job/task.
- The finalizer must persist the evidence reference alongside actual amount/currency and include it in the audit trail.

## Implementation sequence

1. Add a dedicated service-role-only evidence table/RPC in a new migration; do not rewrite already-published migrations.
2. Require an operator permission distinct from ordinary project edit permission.
3. Add a review RPC that validates job owner/project, task ID, submission state, reserved budget, amount/currency, evidence reference and reviewer identity in one transaction.
4. Persist an immutable evidence receipt and audit event; make duplicate evidence submissions idempotent and conflicting submissions fail closed.
5. Only after review succeeds, allow the normal lease-fenced finalizer to settle the reservation using the reviewed amount and receipt reference.
6. Add disposable PostgreSQL tests for cross-owner denial, wrong task ID, missing evidence, duplicate review, conflicting review, over-reservation, currency mismatch, concurrent settlement and audit receipt persistence.
7. Keep the feature unavailable to normal users and keep remote generation disabled until the process composition, private media path and isolated staging acceptance are complete.

## Explicit non-goals

This decision does not authorize live Runway calls, provider uploads, billing changes, Supabase migration application, process enablement, PR merge or deployment.
