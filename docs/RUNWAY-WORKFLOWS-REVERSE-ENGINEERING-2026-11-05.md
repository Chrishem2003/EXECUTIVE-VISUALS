# Runway Workflows — reverse-engineered integration contract

Research snapshot: 2026-11-05. This implementation adds a **local request planner and invocation-result normalizer only**. It does not submit a Workflow invocation, poll a provider, cancel a task, or spend credits.

## Provider contract

Runway Workflows are published, versioned node graphs exposed as private endpoints. Each publish creates a new immutable version ID. A call to `POST /v1/workflows/{id}` starts one invocation; poll it using `GET /v1/workflow_invocations/{id}` (not `GET /v1/tasks/{id}`).

The request uses `nodeOutputs`, keyed by published node ID and output key:

- Primitive input: `{ type: "primitive", value: ... }`
- Media input: `{ type: "image" | "video" | "audio", uri: ... }`

Input node IDs and exposed keys are available from the published workflow graph. The API may silently ignore mismatched node IDs/keys and fall back to saved values, so this planner rejects unknown and non-exposed inputs locally.

Invocation statuses are `PENDING`, `THROTTLED`, `RUNNING`, `SUCCEEDED`, and `FAILED`. Poll no more often than once every five seconds. `SUCCEEDED` does not mean every node succeeded: inspect `nodeErrors` and verify every expected output exists. Final `cost.credits` may be absent until the invocation finishes. Output URLs expire within 24–48 hours and must be copied to private application storage rather than exposed directly.

A Workflow charges for each node that runs. A failed node does not cause dependent nodes to run; completed and independent branches can still be charged. Cancellation does not stop already-started or queued nodes from being billed.

Official sources:
- https://docs.dev.runwayml.com/workflows/
- https://docs.dev.runwayml.com/workflows/running/
- https://docs.dev.runwayml.com/workflows/publishing/
- https://docs.dev.runwayml.com/api/

## Implemented files

- `server/runway-workflow-contract.mjs`
  - Validates published workflow version UUID and published input manifest.
  - Rejects unknown, hidden, or mismatched node IDs and output keys (preventing silent fallback to graph defaults).
  - Validates primitive and media input shapes.
  - Resolves media only from private asset IDs using authenticated owner/project scope and an injected private asset resolver.
  - Normalizes invocation statuses, partial success, expected-output omissions and finalized cost evidence.
  - Exposes a 5-second minimum polling interval constant.
- `server/tests/runway-workflow-contract.test.mjs`
  - Covers manifest validation, private asset scope, status semantics, partial runs and cost-finalization behavior.
- `package.json`
  - Includes the Workflow contract tests in `verify:video-routing`.

## Safety boundary

This branch is a contract/planning layer. It intentionally contains no provider HTTP client and cannot create a billable invocation. Integration with the durable cloud submission ledger, approval gate, budget reservation, actual-cost reconciliation and private output ingestion must precede any live invocation adapter.

## Architecture decision

Use:
- **Model Router** for a single model generation where the provider should select the model.
- **Workflow** for a fixed, reusable graph where each published node uses a known model and the chain is the same on every request.
- **Recipe** when a Runway-managed prebuilt pipeline matches the task.
- **Executive Visuals orchestration** for dynamic branching, loops, human approval, cross-provider routing, or steps that depend on earlier results.

Do not replace the existing local workflow engine with a provider-specific Workflow graph. Treat Runway Workflows as an optional execution backend behind Executive Visuals' provider-neutral workflow contract.
