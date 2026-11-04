# Runway Model Router integration contract

Research snapshot: 2026-11-04

Primary sources:
- https://docs.dev.runwayml.com/model-routers/generating/
- https://docs.dev.runwayml.com/api/
- https://docs.dev.runwayml.com/guides/pricing/

## Video dry-run contract

Use `POST /v1/generate/video` with the exact same `configId` and model-agnostic
`input` planned for the live request, plus `dryRun: true`.

The local builder:
- Restricts router IDs to lowercase URL-safe slugs.
- Accepts documented video prompt, negative prompt, aspect ratio, resolution,
  duration, audio and reference image inputs.
- Requires image references to be pre-uploaded `runway://` URIs. It rejects
  browser-provided HTTPS URLs and data URIs so the caller must resolve private
  project assets and upload them on the server first.
- Uses the currently documented routed-video duration range of 4–15 seconds.
- Rejects undocumented fields rather than forwarding them speculatively.

The dry-run response contains `routing.model`, `routing.provider`,
`routing.configId`, `routing.resolvedSettings`, and
`routing.estimatedCost.credits`. This is a preflight estimate, not a charge.

## Live response and history

A live routed response includes a task ID and routing metadata. The developer
guide describes realized cost in the routing metadata, but the public API
reference's generated response schema does not yet expose a precise realized
cost field name. Do not guess a field name or implement settlement until the
exact live response contract has been verified from a provider response and
tested against the API version.

The documented `GET /v1/routers/{id}/requests` history page contains:
`requestId`, `status`, `model`, `provider`, `estimatedCredits`,
`taskId`, `createdAt`, and routing diagnostics. This is useful for joining a
Runway task to an app job and investigating routing, but the history page
reports `estimatedCredits`, not an authoritative realized-cost receipt.

The local history parser therefore returns only lineage evidence and always
sets `billable: false` and `settlementEligible: false`. It rejects missing
or ambiguous task matches.

## Router policy

The local policy builder uses a closed model allowlist, explicit per-video
credit ceiling, explicit optimization preference and capacity fallback off.
It is an internal policy representation, not a remote configuration payload.
No remote router is created or changed by these helpers.

## Financial boundary

Only a verified, task-correlated provider realized-cost receipt may settle a
budget reservation. The following are not settlement evidence:
- Published pricing estimates.
- Router dry-run `estimatedCost`.
- Router history `estimatedCredits`.
- The initial task submission's `estimatedCost`.

Missing or contradictory realized-cost evidence must keep the job unsettled
and route it to operator review.
