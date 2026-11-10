# Batch 70 — Approved-shot execution boundary

## Delivered

This batch adds a cloud-worker executor boundary for individual, explicitly approved Runway shots and makes the approval snapshot carry independently priced per-shot amounts.

### Per-shot quote binding

The approval builder now requires one current, source-attributed quote for every shot. It binds each shot's currency, amount, source URL and quote observation/expiry timestamps into the immutable approval snapshot, and includes that snapshot in the request hash. This prevents a shot's approved budget from being reconstructed from an aggregate estimate or changed independently after approval.

### Cloud video executor contract

`createCloudVideoGenerationExecutor` accepts the existing approved snapshot, a durable task ledger, a private media publisher and the split Runway submit/poll/download adapter.

- It verifies the job owner and project against the approval record.
- It requires the approval to be in an executable state and uses the approved shot snapshot only.
- It reserves each approval/shot pair through an atomic task-ledger method. That method is contractually responsible for uniqueness, scope and aggregate budget ceiling enforcement.
- It persists a `submitting` state before the provider POST.
- It records the returned provider task ID before polling.
- If submission outcome or task-ID persistence is ambiguous, it marks the task `submission_unknown` and refuses to POST again.
- A recovered task with a persisted provider ID resumes GET polling without another creation request.
- Polling uses a minimum five-second interval with bounded backoff.
- Completed output is size-limited, MP4-signature checked, written to a private temporary file and handed to the private media publisher with an idempotent publication key.
- Provider terminal failures are recorded; they do not silently trigger a new paid attempt.

### Verification added

- Approved shot submits once, persists the provider task ID, downloads and publishes output.
- Ambiguous submission never creates a second task.
- Recovery with an existing provider task ID resumes polling without POST.
- Owner/project scope is checked before reserving a task.
- Terminal provider failure is recorded and no asset is published.
- Approval tests verify the per-shot quote is bound to the immutable snapshot.

The tests are part of `npm run build` via `verify:cloud-video-generation`.

## Integration status and limitations

This batch adds the execution boundary and test contract. It does **not** yet provide the concrete Supabase approval/task-ledger repositories, register `video.generate.shot` with the cloud queue, or enable provider execution in the deployed worker. Those are the next integration steps and must be completed before any generation is considered operational.

No provider request, credit reservation, production migration, production configuration change or deployment was performed.
