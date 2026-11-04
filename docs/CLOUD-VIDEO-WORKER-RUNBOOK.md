# Cloud Video Worker: Private Asset and Output Ingestion Runbook

Status: staging-only implementation; provider execution remains disabled.

## Composition

The video worker composition uses the existing Cloud Asset Service and Cloud Media IO. When custom adapters are not injected, it:

1. Reads an owner- or project-authorized private asset through a short-lived Supabase signed URL.
2. Verifies the asset is in the private `executive-visuals-media` bucket and remains in the requested personal/project scope.
3. Materializes the file server-side, passes its bytes and metadata to the Runway private-asset resolver, and always cleans the temporary file.
4. Uploads image references to Runway's ephemeral upload service; the browser never supplies a provider URL.
5. Downloads completed provider outputs through the bounded private-output ingestor, validates the media with FFprobe, and registers private project assets idempotently.

Project-scoped assets may be owned by another collaborator only when the request is authorized for the exact same project. Personal assets remain owner-only. Cross-project and public-bucket assets are rejected.

## Required deployment configuration

Do not set these values in production as part of this change. Configure them only in an isolated staging environment after the release gates are approved.

- `SUPABASE_URL`: staging Supabase URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only staging service-role key; never expose it to browser or client bundles.
- `RUNWAY_API_KEY`: server-only Runway API key.
- `CLOUD_VIDEO_WORKER_ENABLED=true`: explicit worker composition opt-in; the normal CLI still does not supply the approved video factory.
- `RUNWAY_VIDEO_ENABLED=true` and `RUNWAY_VIDEO_ALLOW_REMOTE=true`: Runway adapter opt-ins; leave unset until paid generation is separately approved.
- `RUNWAY_VIDEO_OUTPUT_HOSTS`: comma-separated exact hostnames verified from real Runway output URLs. Wildcards are rejected. Do not guess CDN hostnames.
- `FFPROBE_PATH`: optional explicit FFprobe executable path; otherwise `ffprobe` must be on PATH.

## Output ingestion controls

- HTTPS only; redirects are denied.
- Exact hostname allowlist; wildcard host entries are rejected.
- DNS resolution must be public; private, loopback, link-local and reserved addresses are denied.
- Response sizes are bounded per output and across the complete task.
- Media type, file signature, container, streams and duration are validated before asset registration.
- The task ID and owner/project scope are checked before idempotent registration.
- Incomplete or failed registration triggers compensating cleanup; uncertain outcomes remain quarantined for operator reconciliation.
- Provider output URLs are temporary. Ingest completed output promptly rather than persisting or exposing provider URLs.

## Financial release gate

`resolveActualCost` remains a required injected dependency. The pricing estimator and Model Router dry-run are reservation estimates, not settlement receipts. The current Model Router guide states that successful routed generations include the realized cost in response metadata; dry runs return an estimated cost and are not billed. The exact response field path and task correlation still require a redacted, verified response fixture and contract tests before settlement code is connected.

Do not settle reservations from `estimatedCredits`, a pricing formula, dry-run metadata, or aggregate daily usage. For the current direct Gen-4.5 adapter, task-level realized-cost evidence remains unverified. A future routed adapter may settle only from the successful response metadata after its exact schema, task ID correlation, currency/unit and idempotency behavior are contract-tested.

## Acceptance gates

- [ ] Verify exact output CDN hostnames using a real, redacted staging task response.
- [ ] Verify FFprobe is installed and output media contracts match the provider's actual containers.
- [ ] Test private project asset reads for owner, collaborator, viewer, cross-project and personal-asset cases.
- [ ] Fault-inject timeout, DNS rebinding, redirect, oversized response, malformed media, FFprobe failure, duplicate ingestion, lease loss and cleanup failure.
- [ ] Implement and verify task-correlated realized-cost settlement.
- [ ] Run exact-head quality and PostgreSQL integration checks.
- [ ] Obtain explicit approval before enabling the worker or making a paid provider request.

## Official references

- [Runway API input and ephemeral upload requirements](https://docs.dev.runwayml.com/assets/inputs/)
- [Runway task detail and cancellation API](https://docs.dev.runwayml.com/api/)
- [Runway Model Router response metadata](https://docs.dev.runwayml.com/model-routers/generating/)
- [Runway pricing and temporary output cost rules](https://docs.dev.runwayml.com/guides/pricing/)