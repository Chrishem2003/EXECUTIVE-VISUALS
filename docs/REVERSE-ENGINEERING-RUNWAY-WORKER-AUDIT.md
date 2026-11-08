# /REVERSE Audit — Hosted Video Worker Integration

**Repository:** `Chrishem2003/EXECUTIVE-VISUALS`  
**Pull request:** [#34 — feat(video): add disabled Runway Gen-4.5 adapter foundation](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/34)  
**Branch:** `feat/runway-video-adapter`  
**Audited head:** `c7972ce127fc763d6ba3f2f270236269c56e367b`  
**Audit date:** 2026-11-05  
**Disposition:** Draft only; provider and worker remain disabled.

## Verified implementation

The current branch contains the provider-neutral capability registry, Runway Gen-4.5 adapter, governed enqueue, cloud Postgres submission ledger, budget approvals/reservations, lease-fenced cloud executor and worker, private output-ingestion module, and state-aware recovery. The cloud video worker claims only `video.generate` jobs. It resumes a recorded task ID rather than repeating a provider POST, defers polling to later leases, and quarantines ambiguous submissions, unresolved cost, and ingestion uncertainty.

The output-ingestion module requires an explicit host allowlist, public DNS resolution with address pinning, HTTPS, no redirects, bounded downloads, a mandatory media validator, idempotent asset lookup, and compensating cleanup. Cloud asset registration records size and SHA-256. The cloud Runway asset resolver is a tested composition point over the owner-authorized private asset repository.

## Exact-head verification

At audited head `c7972ce127fc763d6ba3f2f270236269c56e367b`:

- Quality checks: **passed**, run [41894261441](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/actions/runs/41894261441).
- Cloud video PostgreSQL integration: **passed**, run [41894261421](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/actions/runs/41894261421).
- PR #34 remains open and draft. These CI workflows use a disposable PostgreSQL database; they are not Supabase staging acceptance.

## Remaining integration blockers

### 1. The hosted process does not compose the video worker

`server/cloud-worker-process.mjs` currently configures and starts only the cloud media and timeline worker families. It does not construct or register `createCloudVideoWorker`. The video worker implementation exists, but it is not a running hosted capability.

### 2. Actual Runway API-task cost is not authoritatively attributable yet

The executor correctly requires `resolveActualCost` and quarantines a completed task if cost cannot be proven. Do not replace this with the preflight estimate or a daily usage delta.

Current official Runway documentation distinguishes:
- `POST /v1/organization/usage`: API-project usage grouped by day/model/API key.
- `GET /v1/organization/webapp/usage`: per-generation rows for linked web-app workspaces, but those web-app credits are a separate pool from API credits. The documented row fields include timestamp, user/workspace, tool and credits; they do not establish a join to this API task ID.
- Task detail exposes `estimatedCost.credits`, which is an estimate, not a settled task invoice.

Therefore, the billing resolver remains a hard release blocker. A valid future design must use task-correlated API billing evidence if Runway exposes it, or an explicit operator-reviewed evidence record with a defensible link to the task. Otherwise keep the job quarantined and its reservation held.

### 3. Runtime media and provider dependencies are not composed

The private output ingestor requires an explicit, narrow output-host allowlist and an FFprobe-backed `validateMedia` implementation. The cloud Runway private-asset resolver also needs the already-authorized cloud asset repository. Neither should be filled with wildcard hosts, public asset URLs, or browser-provided paths.

### 4. Cancellation is not yet end-to-end

The Runway adapter exposes guarded task cancellation, but the hosted video executor/worker does not yet translate an application cancellation request into a provider cancellation request and reconcile the resulting task state. A lease-loss abort must not be mistaken for user cancellation.

## Next implementation gates

1. Specify and test a trustworthy per-task cost evidence workflow; do not invent attribution.
2. Add an explicit, disabled-by-default video-worker composition to the hosted process, requiring the complete private asset, output validation, provider allowlist and authoritative cost dependencies.
3. Wire application cancellation to provider task cancellation with race-safe terminal-state reconciliation.
4. Add integration tests for worker composition, process restart, task cancellation races, duplicate output ingestion, checksum/probe failure, cleanup-pending recovery, and strict owner/project isolation.
5. Apply migrations only to a dedicated isolated Supabase staging project after review; verify storage policies, service-role boundaries and FFprobe availability with synthetic test media.
6. Keep remote execution disabled until staging acceptance and explicit release approval.

## Safety invariants

- Preserve CEV branding, repository history and existing production resources.
- Keep PR #34 draft; do not merge, deploy, apply shared/production migrations, or enable provider execution as part of this audit.
- No live Runway calls, paid generation, provider uploads, secret changes, or production modifications were performed.
- Never settle a reservation using an estimate, aggregate usage delta, or unrelated web-app credit row.
- Never retry an ambiguous provider POST automatically.

## External evidence

- Runway API reference: https://docs.dev.runwayml.com/api/
- Runway workspace usage and audit reporting: https://docs.dev.runwayml.com/usage/workspace-reporting/
