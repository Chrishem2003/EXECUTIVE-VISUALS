# Batch 141 — staging worker liveness acceptance

## What this adds
The existing Batch 129 heartbeat write path can persist process status but has no narrowly scoped readback RPC for an acceptance runner. This batch adds a service-role-only `read_cloud_worker_heartbeat(worker_id)` function. It returns only worker ID, enabled families, status, heartbeat timestamp, last cycle timestamp and sanitized error code. The heartbeat table itself remains revoked from direct access.

The process acceptance runner is hardened to use only the approved staging Supabase project. It now:
1. Starts a synthetic heartbeat child and observes `starting` then `healthy`.
2. Kills that process without graceful shutdown.
3. Confirms the database heartbeat stops advancing.
4. Marks the test record stopped so it does not leave a false stale-worker alert.
5. Starts a second process, observes healthy heartbeats, sends SIGTERM and verifies the final `stopped` state.

## Safety
- The runner requires `SUPABASE_STAGING_URL` for project `bokxljngydmqrmktofwm` and `SUPABASE_STAGING_SECRET_KEY`.
- The GitHub workflow is manual-only and uses the protected `staging` environment.
- It does not create or deploy a Render worker, change a service plan, apply a production migration or call video providers.
- It writes two random synthetic heartbeat IDs and leaves them in the staging liveness table as `stopped` records for auditability.

## Interpretation
A pass proves the heartbeat RPC can persist/read process liveness, detects a killed process by a heartbeat that stops advancing, and records graceful shutdown. It does not prove that a dedicated Render worker has been deployed, that queue jobs execute, or that production alert delivery is configured.
