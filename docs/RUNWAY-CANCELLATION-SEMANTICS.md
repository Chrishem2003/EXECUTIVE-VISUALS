# Runway task cancellation semantics

## API contract

The Runway task API uses `DELETE /v1/tasks/{id}` for both cancellation and deletion:

- Tasks observed by Runway as `PENDING`, `THROTTLED` or `RUNNING` can be canceled.
- Calling DELETE for a task in another state deletes the task and its stored output.
- A 204 response means the API accepted the cancel/delete operation; it does not prove execution stopped or credits were refunded.
- A 404 after a task was already aborted/deleted is idempotent and may be ignored.
- Runway evaluates refund eligibility from the status it observes during cancellation. If it observes `RUNNING`, the operation does not refund credits.
- Task state can advance concurrently with cancellation. A preceding GET is only a preflight observation, not a conditional cancellation guarantee.

## Adapter behavior

`server/runway-video-gateway.mjs`:

1. Validates the task ID.
2. Fetches current task state.
3. Does not send DELETE for already-terminal tasks observed by the preflight.
4. Sends DELETE only for tasks observed as queued/running.
5. Treats DELETE 404 as idempotent after the successful preflight.
6. Returns `cancel_requested` with a best-effort warning; it never reports a refund or guaranteed stop.

## Remaining race / release requirement

There is no conditional cancel endpoint in the documented task API. A task may transition from RUNNING to SUCCEEDED between GET and DELETE; because DELETE also deletes terminal tasks, this race can delete the completed provider-side output. The current adapter cannot eliminate this provider-side race. Keep cancellation described as best-effort and preserve already-ingested private outputs in the application. Before production release, product UX and audit records must distinguish:

- cancellation requested,
- provider task confirmed canceled (where independently observable),
- provider task completed,
- output ingested into private storage,
- refund confirmed by authoritative billing evidence.

Never infer a refund from HTTP 204, a 404, or a preflight status.

## Tests

The gateway tests cover terminal preflight (no DELETE), running preflight (DELETE), and a raced DELETE 404 (idempotent handling). No live Runway request is required for these tests.
