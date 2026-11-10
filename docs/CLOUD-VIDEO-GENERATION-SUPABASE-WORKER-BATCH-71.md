# Batch 71 — Durable Supabase video-generation ledger and worker

## What changed

This batch advances the approved-shot executor from an injected boundary into a concrete Supabase/PostgREST repository and an opt-in cloud worker family.

### Additive database migration

`supabase/migrations/20261111230000_durable_video_generation_tasks_batch_71.sql` adds:

- `executive_visuals.video_generation_approvals`: immutable owner/project-scoped approval snapshots, quote and budget ceiling.
- `executive_visuals.video_generation_tasks`: one durable row per approved shot, including state, provider task ID, quoted amount, output asset and failure evidence.
- `register_video_generation_approval`: idempotent approval mirror registration with project ownership and per-shot quote total validation.
- `enqueue_approved_video_generation`: creates one idempotent queue job per approved shot, scoped to the approval owner and project.
- `reserve_video_generation_task`: locks the approval row, validates the approved shot price and serializes budget reservations.
- `transition_video_generation_task`: enforces the durable task state transition and stores provider/output identity.

Both tables have RLS enabled and no grants for public, anon or authenticated roles. The RPC functions are executable only by `service_role`. The migration is additive and has **not** been applied to any hosted Supabase project.

### Server repository and worker

- Added `createCloudVideoGenerationRepositories` for approval registration/lookup/enqueue and task reservation/transitions through the `executive_visuals` PostgREST profile.
- Added `createCloudVideoGenerationWorker`, which claims only `video.generate.shot` jobs from the existing Postgres job queue.
- Registered the worker family in `cloud-worker-process.mjs`.
- Added `CLOUD_VIDEO_GENERATION_WORKER_ENABLED`. Starting this family additionally requires `VIDEO_GATEWAY_ENABLED=true`, `VIDEO_GATEWAY_ALLOW_REMOTE=true` and a server-only `RUNWAYML_API_SECRET`.
- The worker reuses the existing private asset service, media publisher, lease heartbeat, recovery and supervisor.
- Completed tasks replay their recorded asset identity without polling, downloading or publishing again. Failed tasks require a new explicit approval rather than automatic paid retries.

### Financial and safety checks

- The sum of per-shot micro-unit quotes must exactly equal the aggregate approval quote.
- Provider/model identity, currency and source-attributed quote metadata are bound into the approved snapshot.
- The database checks the per-shot price against the immutable snapshot again while holding the approval row lock.
- The sum of reserved shot amounts cannot exceed the approved budget ceiling.
- Each approval/shot pair has a unique task ledger identity.
- A worker recovery with a persisted provider task ID resumes GET polling; `submitting` or `submission_unknown` states never create another provider task.
- The approval is marked complete only after every expected shot has a succeeded task record.

## Verification added

The release build now includes repository, worker, executor, approval and worker-configuration tests. The tests cover owner/project scoping, RPC payloads, one-shot job filtering, queue completion, terminal replay, failure handling, explicit remote gates and quote reconciliation.

## Not yet operational

The API route that mirrors a locally approved SQLite record into this Supabase ledger and calls the enqueue RPC is the next integration step. The migration must first be reviewed and applied to an isolated Supabase development project/branch; it has not been applied. The worker remains disabled unless explicitly configured. No provider generation, credit reservation, production migration or deployment occurred in this batch.
