# ADR: Video generation persistence boundary

**Status:** accepted design direction; implementation pending  
**Date:** 2026-11-04  
**Scope:** Executive Visuals video-generation jobs, provider submissions, usage reservations and private output assets

## Context

The current video enqueue service and submission ledger use the local SQLite database (server/video-generation-jobs.mjs and server/video-generation-submissions.mjs). The cloud worker queue uses Supabase Postgres through the executive_visuals schema and RPC functions (server/cloud-queue.mjs).

These are separate persistence systems. A SQLite job is not visible to the Supabase worker. Copying jobs between them or dual-writing from the API would create failure windows in which a budget reservation, job, submission state and provider task ID disagree.

The cloud queue already provides atomic job claims, type filtering, lease renewal, lease recovery and terminal completion through database RPCs. The core Supabase migration defines a richer jobs table and server-only queue functions. This is the best fit for a future hosted video worker, provided the isolated migration is reviewed and applied deliberately to a dedicated environment first.

## Decision

For hosted video generation, make Supabase Postgres the single source of truth for the job, budget reservation, usage reservation and provider-submission ledger. Do not bridge SQLite jobs into the cloud queue and do not dual-write.

Keep SQLite video enqueue/executor code isolated for local tests and local-only development until a separate local execution contract is deliberately supported. A hosted API must not enqueue into SQLite while a hosted worker claims from Supabase.

The hosted enqueue path must use one Postgres transaction, exposed through a narrowly scoped server-side RPC or transaction service, to:
1. Re-check authenticated owner and project write authorization against the authoritative project/member records.
2. Resolve the provider/model against a server-side enabled capability registry and enforce all declared request limits.
3. Validate the caller's explicit budget approval and reserve the maximum approved amount in a durable budget ledger.
4. Reserve the rolling-window provider request allowance.
5. Insert the video.generate job with a stable idempotency key and normalized request hash.
6. Insert audit/job events and return the existing job on an identical idempotent replay without reserving again.

The provider-submission ledger must be stored in the same Postgres schema and keyed uniquely by job ID. The transition into submitting must be an atomic compare-and-set. Persist a provider task ID before polling. A timeout or worker crash after a possible provider POST must transition to unknown, never to an automatic resubmission. Only an explicit reconciliation action with provider-side evidence may move an unknown attempt back to a pollable state.

The existing cloud queue's type filter should be used by a dedicated video worker. The timeline worker must remain restricted to timeline.render; the local SQLite worker must remain restricted to its local workflow/media allowlist. Worker lease recovery must not itself cause a provider POST retry.

## Data model direction

Add server-only Postgres tables in executive_visuals for:
- budget reservations and immutable settlement/release events;
- rolling-window provider usage reservations;
- provider submission attempts (one logical submission per job, immutable task ID once recorded, explicit unknown/quarantine state);
- provider cost observations and reconciliation events.

Use foreign keys to executive_visuals.jobs, projects, and auth.users; enforce owner/project consistency with constraints or triggers. Enable RLS and revoke direct access from public, anon, and authenticated; grant only the minimum required operations to service_role. Do not store provider secrets or raw authorization headers in these records. Keep prompts and provider responses bounded and apply existing data-retention policy.

The existing executive_visuals.jobs table has a different status vocabulary from SQLite (for example, cloud uses processing while local uses running). Keep adapters explicit; do not assume status strings or JSON column names are interchangeable.

## Output ingestion boundary

The provider executor must not treat a provider URL as a trusted asset. Before registering an asset:
- require HTTPS and an exact provider-owned hostname allowlist grounded in provider documentation;
- resolve and reject loopback, private, link-local, multicast, reserved and IPv4-mapped IPv6 destinations;
- disable redirects or revalidate every redirect target and DNS resolution;
- enforce connection, total-time and byte limits while streaming;
- sniff actual media/container content and run FFprobe with resource limits;
- calculate SHA-256 while downloading;
- store bytes in a private bucket under a server-generated object path;
- register an asset tied to the same owner and project, with a derivative relationship to the generation job/source as applicable;
- make ingestion idempotent by job ID, provider task ID and output index;
- clean up orphaned temporary objects on failure without deleting unrelated assets.

Do not use browser-visible provider URLs as permanent asset URLs. Serve registered assets through existing authenticated/authorized asset delivery.

## Migration and rollout gates

1. Implement schema migration and SQL tests in a dedicated development Supabase project or disposable local Postgres; never apply this migration to shared staging or production as part of this PR.
2. Implement transactional enqueue and idempotency RPC tests, including concurrent identical requests and budget exhaustion.
3. Implement atomic submission-state transitions and crash/timeout reconciliation tests.
4. Implement provider output downloader and private asset ingestion tests for unsafe DNS, redirects, content mismatch, oversized responses, timeouts and duplicate outputs.
5. Implement a dedicated cloud video worker that claims only video.generate, renews leases, observes cancellation and polls stored task IDs without resubmitting.
6. Reconcile estimated, reserved and actual provider cost before terminal success; settle or release unused reservations exactly once.
7. Run end-to-end tests with a mock provider and isolated Supabase/storage environment.
8. Keep all providers disabled until operator-controlled credentials, budgets, legal/terms review, provider allowlisting and release approval are complete.

## Consequences

- No silent queue migration or hidden dual-write path.
- Hosted jobs and hosted workers share one transactional source of truth.
- Provider ambiguity is handled conservatively to prevent duplicate paid generation.
- The current isolated SQLite implementation remains useful for unit tests but is not a hosted production path.
- This ADR does not authorize provider activation, migration application, merge or deployment.
## Cloud submission-ledger implementation checkpoint (2026-11-04)

The source-only migration `20261104120000_cloud_video_submission_ledger.sql` and `server/cloud-video-submissions.mjs` add a server-role-only Postgres ledger contract for hosted workers. The ledger is unique per job, checks that provider/model/request hash match the queued `video.generate` input, and supports `prepared → submitting → submitted/unknown → terminal` transitions.

Only the currently leased worker may begin a provider submission, record a task ID, mark an ambiguous attempt unknown, or finish a submission. The task ID is unique and conflicting IDs are rejected. Ambiguous attempts cannot be moved back into `submitting`; reconciliation is a separate explicit operation requiring an evidence reference. A succeeded terminal ledger state requires a recorded provider task ID.

The RPC client uses the `executive_visuals` PostgREST profile, server-only service-role credentials, bounded requests/timeouts, strict response validation and credential redaction. Mock transport tests cover RPC mapping, lease-bound lifecycle calls, malformed responses, invalid inputs, timeout and error redaction.

This is persistence infrastructure only. It is not wired to a cloud video worker or enqueue API, no provider calls are made, and the migration is not applied to any Supabase project. A dedicated worker must inspect the ledger before any provider POST and must never POST for `submitted`, `unknown` or terminal records.