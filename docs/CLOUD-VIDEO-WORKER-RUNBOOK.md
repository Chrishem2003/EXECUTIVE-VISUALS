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

## Project approval and budget boundary

Project-scoped Runway requests require a verified owner/editor authorization before preflight. The exact normalized request and its request fingerprint are stored with the router and budget approval records. A project owner or a distinct project reviewer must approve the request; the requester cannot approve their own project-scoped generation. Personal, non-project requests may be self-approved by their authenticated owner. Viewers and unrelated users cannot create a project preflight. The enqueue transaction rechecks the approval IDs, owner, project, model, router fingerprint, exact approved payload, expiry and budget binding before creating the job and consuming the approvals atomically.

These rules are enforced in PostgreSQL as well as in the application workflow. Disposable integration tests cover owner/editor/viewer access, project-owner and reviewer approval, requester self-approval rejection, payload tampering, and the existing idempotent enqueue path. Do not weaken database checks to compensate for an application authorization failure.

## Runway settlement gate — unresolved by design

Do not treat Runway task `estimatedCost.credits` as actual billed usage. The current official API distinguishes two usage systems:

- `POST /v1/organization/usage` reports the API project's own usage aggregated by model and day (up to 90 days). It is not a per-task ledger.
- Enterprise-only `GET /v1/organization/webapp/usage` reports one row per generation in linked Runway web-app workspaces. Its documented row fields include timestamp, user ID, workspace ID/name, tool and credits, but not the API task ID. It is also a separate credit pool from Runway Dev API usage.

Consequently, neither endpoint alone provides a deterministic task-ID-to-charge mapping for this adapter. The published developer credit price is $0.01 per credit before applicable taxes, but a price conversion does not solve attribution. Do not settle a job by matching only on approximate timestamp, model/tool name or user.

The configured adapter requires a host-injected `resolveRunwayActualCost` callback. It must return a verified amount, currency and evidence reference that can be tied unambiguously to the exact persisted provider task and the correct credit pool. If this evidence cannot be matched, keep the task and budget reservation quarantined for reconciliation; do not settle using a pricing estimate, daily aggregate or unrelated web-app usage row.

`startCloudWorkerProcess(env, dependencies)` accepts host-supplied `dependencies.videoProviderDependencies` for this purpose. The default command-line entry point does not manufacture a billing resolver. Without a verified resolver, Runway adapter registration fails closed.

## Usage reporting references\n\n- [Runway API pricing and credit rate](https://docs.dev.runwayml.com/guides/pricing/)\n- [Runway organization usage API](https://docs.dev.runwayml.com/api/)\n- [Enterprise web-app workspace usage reporting](https://docs.dev.runwayml.com/usage/workspace-reporting/)\n\n## Isolated acceptance sequence

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
