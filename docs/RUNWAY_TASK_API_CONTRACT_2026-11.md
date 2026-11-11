# Runway Gen-4.5 task contract — verified 2026-11-05

## Task lifecycle
- Create text-to-video task: `POST https://api.dev.runwayml.com/v1/text_to_video`
- Retrieve task: `GET https://api.dev.runwayml.com/v1/tasks/{id}`
- Cancel/delete task: `DELETE https://api.dev.runwayml.com/v1/tasks/{id}`
- Pin `X-Runway-Version: 2024-11-06` and use Bearer authentication.
- Do not poll a task more frequently than every five seconds.

The cloud adapter supports Gen-4.5 text-to-video only and uses a one-shot POST. A transport timeout or lost response is ambiguous; do not submit a second task automatically.

## Output lifecycle
Successful task detail returns output URLs that Runway documents as ephemeral (24–48 hour expiry). Download and register output in private application storage promptly; never expose provider URLs directly to users.

## Billing correlation limitation
Task creation may return `estimatedCost.credits`, which is not authoritative actual billed cost. The documented linked-workspace usage API exposes per-generation rows with timestamp, workspace, tool, credits and type, but does not document a task ID. That cannot uniquely reconcile concurrent tasks. The shared worker therefore requires an injected task-level authoritative billing resolver before Runway can be registered for governed remote execution.

## Safety
Remote opt-in, private output ingestion, owner-scoped asset registration and authoritative task-level cost evidence remain mandatory. Reference assets require an authenticated project-scoped resolver. No provider call or paid generation is part of this implementation.

## Official references
- https://docs.dev.runwayml.com/api/
- https://docs.dev.runwayml.com/guides/using-the-api/
- https://docs.dev.runwayml.com/assets/outputs/
