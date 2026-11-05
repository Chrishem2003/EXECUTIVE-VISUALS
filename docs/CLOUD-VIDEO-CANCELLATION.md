# Cloud video cancellation and reconciliation

## Endpoint

Authenticated application users request cancellation with:

`POST /api/cloud/jobs/{jobId}/cancel`

The server supplies the owner ID from verified authentication middleware. The request body cannot choose or override the owner. The API calls the service-role-only `request_video_generation_cancellation` RPC.

- `200`: already canceled before provider submission.
- `202`: cancellation was accepted as a request; the worker/provider/billing outcome is not yet terminal.
- `404`: no job exists in the authenticated owner scope.
- `409`: the job is already terminal in another state.

## State handling

### Queued before provider submission

The database transaction locks the job, confirms there is no submission row or the submission is only `prepared`, terminalizes the job as `cancelled`, marks a prepared ledger row canceled, releases the exact reserved amount, and writes job/audit events. No provider request has been made in this path.

The provider submission transition also checks `cancellation_requested_at IS NULL` so a cancellation already committed before the transition prevents a provider POST.

### Processing or previously submitted

The RPC records `cancellation_requested_at` and an audit event. The worker checks the cancellation flag during execution. If the provider task is queued/running, it sends the adapter's best-effort cancellation request. It then moves the job to `needs_input` for reconciliation instead of claiming the task stopped or releasing the budget.

A succeeded provider task is allowed to proceed through private output ingestion and evidence-backed settlement even if a cancellation request arrived after the provider completed.

### Ambiguous outcomes

If the cancellation state cannot be checked, the worker quarantines the job. If a cancellation request races with the one-shot provider POST, the submission ledger is marked unknown and must be reconciled. The provider may have accepted or billed the request.

## Billing and provider contract

Runway documents that DELETE returns 204 for cancellation/deletion, but execution can advance concurrently; neither the response nor a refund eligibility decision guarantees generation stops. A DELETE 404 is idempotent for already aborted/deleted tasks, but does not establish billing state. Therefore:

- Do not release a submitted task's reservation merely because DELETE returned 204 or 404.
- Do not mark a submitted task as fully canceled until task and billing state are reconciled.
- Do not infer refunds from task status.
- Preserve any already-ingested private output.
- Keep the job in review/needs-input while cost evidence is unresolved.

See the official [Runway task cancellation API](https://docs.dev.runwayml.com/api/) and [output URL guidance](https://docs.dev.runwayml.com/assets/outputs/).

## Release gates

The new SQL migration is source-controlled and tested against the disposable PostgreSQL harness. It has not been applied to shared Supabase or production. Keep remote worker activation disabled until exact-head CI passes and isolated staging exercises queued cancellation, cancellation during submission, submitted-task cancellation, provider completion races, worker restart and billing reconciliation.
