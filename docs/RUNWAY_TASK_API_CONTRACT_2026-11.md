# Runway Gen-4.5 task contract — verified 2026-11-05

## Task lifecycle

- Create text-to-video task: `POST https://api.dev.runwayml.com/v1/text_to_video`
- Retrieve task: `GET https://api.dev.runwayml.com/v1/tasks/{id}`
- Cancel/delete task: `DELETE https://api.dev.runwayml.com/v1/tasks/{id}`
- Pin `X-Runway-Version: 2024-11-06` on every request.
- Use `Authorization: Bearer <API key>`.
- Do not poll a task more frequently than every five seconds.

The current cloud adapter supports only Gen-4.5 text-to-video and uses a one-shot POST. A transport timeout or lost response is ambiguous; do not submit a second task automatically.

## Output lifecycle

Successful task detail returns an output URL collection. Runway documents those URLs as ephemeral (24–48 hour expiry). Download and register the output in private application storage promptly; do not expose provider URLs directly to users.

## Billing correlation limitation

Task creation may return `estimatedCost.credits`. This is not authoritative actual billed cost.

The documented linked-workspace usage API exposes per-generation rows with timestamp, workspace, tool, credits and type, but its documented fields do not expose a task ID. That is not enough to uniquely reconcile concurrent tasks. The shared worker therefore requires an injected task-level authoritative billing resolver before Runway can be registered for governed remote execution.

## Safety gates

- Explicit server-side remote opt-in remains required.
- The worker requires a private output ingestor and exact task-level actual-cost evidence.
- Reference assets require an authenticated project-scoped resolver.
- No paid generation or provider call is part of this integration.

## Official references

- API reference: https://docs.dev.runwayml.com/api/
- Getting started: https://docs.dev.runwayml.com/guides/using-the-api/
- Output URL lifecycle: https://docs.dev.runwayml.com/assets/outputs/
