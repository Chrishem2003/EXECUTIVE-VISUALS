# FAL queue contract — verified 2026-11-05

This note records the upstream API contract used by the FAL async video adapter.

## Queue lifecycle

- Submit: `POST https://queue.fal.run/{owner}/{app}/{path?}`
- Status: `GET https://queue.fal.run/{owner}/{app}/requests/{request_id}/status`
- Result: `GET https://queue.fal.run/{owner}/{app}/requests/{request_id}`
- Cancel: `PUT https://queue.fal.run/{owner}/{app}/requests/{request_id}/cancel`

For model identifiers with more than two path segments, submission includes the complete endpoint path. Status, result and cancellation use the owner/app request URL returned by submission. The adapter reconstructs only the owner/app task URLs from the fixed model and persisted request ID.

## Reliability and retention

- Queue submission supports `X-Fal-No-Retry: true`; this adapter disables provider retries to avoid duplicate paid submissions after ambiguous transport outcomes.
- A completed result is retained for one hour by default. Results at least 10 KB are retained for six minutes unless payload storage is enabled. The worker must fetch and privately ingest outputs promptly.
- A queue status of `COMPLETED` is terminal, but failed requests also reach that state; the response may include `error` and `error_type`.
- Cancellation is best-effort; a cancellation request is not proof that already-running inference stopped before billing.

## Billing and cost controls

- Use the request-level billing-events endpoint filtered by exact `request_id` and `endpoint_id`.
- The billing key requires billing permissions; use a dedicated least-privilege `FAL_BILLING_KEY` where available.
- Do not replace billed-event evidence with model list price or output-duration estimates.
- Keep the approved reservation until a single matching billed event is verified and reconciled.

## Implementation boundaries

- The runtime factory registers one exact `FAL_VIDEO_MODEL` by default; custom adapter factories may add providers.
- Remote execution still requires both `VIDEO_GATEWAY_ENABLED=true` and `VIDEO_GATEWAY_ALLOW_REMOTE=true`, plus `CLOUD_VIDEO_WORKER_ENABLED=true`.
- Private output ingestion requires an explicit host allowlist, DNS pinning, size limits, media validation and owner-scoped private asset registration.
- Reference assets remain disabled unless a project-scoped input resolver is explicitly supplied.
- No production worker registration, credentials, provider requests, paid generations or deployments are included.

## Official references

- Queue submit: https://fal.ai/docs/api-reference/inference-api/queue/submit
- Queue submit to endpoint path: https://fal.ai/docs/api-reference/inference-api/queue/submit-path
- Queue status: https://fal.ai/docs/api-reference/inference-api/queue/status
- Queue result: https://fal.ai/docs/api-reference/inference-api/queue/result
- Queue cancellation: https://fal.ai/docs/api-reference/inference-api/queue/cancel
- Model pricing and billing units: https://fal.ai/docs/documentation/model-apis/pricing
