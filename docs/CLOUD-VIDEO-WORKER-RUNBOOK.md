# Hosted cloud video worker runbook

## Current implementation

The hosted worker supervisor can now include the provider-aware video worker alongside the existing media and timeline worker families. Video remains opt-in and is not enabled by this change.

The process requires all of the following:

- `CLOUD_WORKER_ENABLED=true`
- `CLOUD_VIDEO_WORKER_ENABLED=true`
- `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY`
- `CLOUD_VIDEO_OUTPUT_ALLOWED_HOSTS` containing an explicit comma-separated hostname allowlist
- FFmpeg and FFprobe installed on the worker host
- `VIDEO_GATEWAY_ENABLED=true` and `VIDEO_GATEWAY_ALLOW_REMOTE=true`
- An exact provider/model adapter with private output ingestion and authoritative cost reconciliation

The worker still requires the separate provider-specific enablement flags. Runway requires `RUNWAY_VIDEO_ENABLED=true`, `RUNWAY_VIDEO_ALLOW_REMOTE=true`, `RUNWAY_VIDEO_MODEL=gen4.5`, and a server-side Runway API key.

## Runway settlement gate — unresolved by design

Do not treat Runway task `estimatedCost.credits` as actual billed usage. The task detail endpoint exposes an estimate. The organization linked-workspace usage endpoint exposes per-generation credit rows, but its documented row fields do not include a provider task ID. Therefore a deterministic job-to-billing-row match and a verified USD conversion cannot be assumed.

The configured adapter requires a host-injected `resolveRunwayActualCost` callback. It must return a verified amount, currency, and evidence reference for the exact persisted provider task. If this evidence cannot be matched unambiguously, keep the task and budget reservation quarantined for reconciliation; do not settle using a pricing estimate.

`startCloudWorkerProcess(env, dependencies)` accepts host-supplied `dependencies.videoProviderDependencies` for this purpose. The default command-line entry point does not manufacture a billing resolver. Without a verified resolver, Runway adapter registration fails closed.

## Isolated acceptance sequence

1. Use a disposable development Supabase project, never shared staging or production.
2. Apply the source-controlled migrations to that disposable project only.
3. Configure private storage, FFmpeg/FFprobe, and the narrow provider output hostname allowlist.
4. Keep all video flags false while validating worker startup and database readiness.
5. Inject a test-only provider adapter and deterministic fake billing resolver; verify claim, lease renewal, submission ledger, deferred polling, output ingestion, atomic budget settlement, and owner-scoped status lookup.
6. Test ambiguous submission outcomes, lease loss, duplicate worker claims, rejected output URLs, cleanup failures, and unresolved billing. These cases must not trigger a second paid submission or release a reserved budget prematurely.
7. Only after evidence-backed acceptance should a separate change request review any provider opt-in. This runbook does not authorize enabling provider calls, paid generation, shared migrations, or deployment.

## Safety defaults

- `CLOUD_WORKER_ENABLED=false`
- `CLOUD_VIDEO_WORKER_ENABLED=false`
- `VIDEO_GATEWAY_ENABLED=false`
- `VIDEO_GATEWAY_ALLOW_REMOTE=false`
- `RUNWAY_VIDEO_ENABLED=false`
- `RUNWAY_VIDEO_ALLOW_REMOTE=false`

Never expose Supabase service-role credentials or Runway API keys to browser code.
