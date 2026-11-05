# Video generation cost evidence implementation

**Repository:** `Chrishem2003/EXECUTIVE-VISUALS`  
**PR:** #34 — `feat/runway-video-adapter`  
**Implementation commit:** `a4915a5cfbc7ad04d0c34d74a23d40fd353e4858`  
**Status:** Source-controlled; disposable PostgreSQL CI pending at time of writing. No shared Supabase migration has been applied.

## What is implemented

### 1. Immutable evidence receipts

Migration `20261105100000_video_generation_cost_evidence.sql` adds an RLS-protected receipt table. Each receipt binds:

- Exact CEV job, owner and project.
- Exact budget reservation.
- Provider, model and Runway task ID.
- Actual amount and currency.
- Evidence source class and stable evidence reference.
- SHA-256 digest of the retained evidence artifact.
- Authenticated reviewer identity and timestamp.
- Review note explaining how the evidence correlates to the task.

The receipt is append-only. Authenticated users cannot update or delete it. One receipt is permitted per job/reservation.

### 2. Review authority and validation

Only the job/project owner can create the receipt through their authenticated Supabase identity. A trigger overwrites reviewer identity and review timestamps from the authenticated context and verifies:

- The job belongs to the reviewer.
- The project belongs to the reviewer when project-scoped.
- The reservation is still held and belongs to the job.
- The submission is in `submitted` state.
- The supplied provider task ID exactly matches the durable submission ledger.
- Provider/model/currency match the reservation and submission.
- Actual amount is non-negative and does not exceed the reservation.

The evidence source must be one of `provider_invoice`, `provider_export`, `provider_portal`, or `provider_support`. The reference and digest are retained for audit. A human reviewer must establish the task-to-charge relationship; a daily aggregate or unrelated web-app credit row is not sufficient merely because it is temporally close.

### 3. Fail-closed settlement

The worker-side `createCloudVideoCostEvidenceResolver` reads the immutable receipt using a service-role-only RPC. It checks job owner, task ID, amount, currency, evidence digest, reviewer identity and review timestamp.

Successful job finalization now uses `finish_video_generation_job_with_evidence`. The wrapper locks the active job, reservation, submission and evidence row, verifies exact task/amount/reference equality, then invokes the existing atomic finalizer in the same database transaction. Failed/cancelled jobs retain the existing failure finalization path; successful/partial settlement without an evidence reference is rejected by the client.

### 4. Test coverage added

- Disposable PostgreSQL workflow applies the new migration after the existing submission and budget migrations.
- Integration scenario creates a task receipt under the authenticated project owner, then finalizes the job using the evidence-gated RPC.
- Cloud enqueue unit tests require the evidence-gated RPC for successful settlement.
- Cost resolver unit tests cover exact task binding, owner binding, missing/duplicate receipts, invalid amount/digest/reviewer metadata and endpoint safety.
- The migration guard checks RLS, append-only behavior, reviewer identity, task binding, evidence amount and settlement wrapper invariants.

## Important limitations

- This is a human-reviewed receipt workflow, not an automatic provider invoice integration.
- A digest proves the retained artifact has not changed; it does not independently prove that the artifact is authentic. The reviewer must inspect the source and document the correlation.
- The evidence resolver and evidence-gated finalizer are implemented, but the hosted video worker is still not composed into `cloud-worker-process.mjs`.
- Provider cancellation, provider output host allowlist configuration, private media ingestion acceptance, FFprobe availability and isolated Supabase staging remain separate release gates.
- Do not apply this migration to shared staging or production until disposable CI passes, SQL is reviewed, and a dedicated isolated Supabase project is explicitly approved.

## Safety

No live Runway request, provider upload, paid generation, secret change, shared database migration, production modification, PR merge or deployment was performed.
