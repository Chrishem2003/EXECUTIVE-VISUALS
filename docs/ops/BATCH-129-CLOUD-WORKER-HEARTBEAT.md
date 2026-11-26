# Batch 129 — Durable cloud worker liveness

## Runtime behavior
The dedicated worker process now writes a durable heartbeat on startup, every 30 seconds, and during graceful shutdown. Heartbeats include a process ID, enabled worker families, status, last observed work cycle and a sanitized error code. They never include provider credentials, object keys, signed URLs, prompts or customer media.

Statuses are `starting`, `healthy`, `degraded`, `stopping` and `stopped`. The database timestamp is generated server-side. A process that is killed without graceful shutdown naturally stops updating its heartbeat; monitoring can treat a heartbeat older than the agreed threshold as stale.

## Deployment contract
- Use a separate Render Background Worker, not the public web service.
- Start command: `npm run start:cloud-worker`.
- Runtime image: repository Dockerfile, which includes FFmpeg and FFprobe.
- Required common environment: `CLOUD_WORKER_ENABLED=true`, `SUPABASE_URL`, and server-only `SUPABASE_SECRET_KEY` (or supported service-role key).
- Start with only `CLOUD_MEDIA_WORKER_ENABLED=true` or another specifically approved family. Keep video and remote provider flags off until pricing, billing and remote execution approvals are verified.
- Set `CLOUD_WORKER_LEASE_SECONDS=90` and `CLOUD_WORKER_HEARTBEAT_MS=15000` unless a tested queue policy requires otherwise.
- Apply this migration to the isolated worker database before starting the process.

## Cost and safety
The current Render inventory has web services on Free plans and no dedicated background worker. Render Background Workers are a separate service type and may require a paid plan. This PR does not create a service, change a plan, add environment variables or deploy. Do not proceed until the owner sees and approves the exact recurring cost and confirms the worker database and private storage.

## Monitoring
Query `executive_visuals.cloud_worker_heartbeats` using an authorized database operator account. Alert when a required worker's `heartbeat_at` is older than 90 seconds, when status is `degraded`, or when no successful work cycle is observed for the operational threshold. A heartbeat proves process liveness, not job correctness; queue lag, retries and dead-letter counts remain separate metrics.
