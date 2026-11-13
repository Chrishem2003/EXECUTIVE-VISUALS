# Embedded cloud video worker (opt-in)

Executive Visuals already has a durable Supabase-backed cloud video queue and a provider-aware worker process. This option lets the existing Render web service host **only that remote video worker in the API container**, avoiding a separate paid background-worker service.

It is deliberately disabled by default. No worker is started unless all of these are explicitly configured:

- `CLOUD_WORKER_IN_PROCESS_ENABLED=true`
- `CLOUD_WORKER_ENABLED=true`
- `CLOUD_VIDEO_WORKER_ENABLED=true`

Do not set `CLOUD_MEDIA_WORKER_ENABLED=true` or `CLOUD_TIMELINE_WORKER_ENABLED=true` in embedded mode. Those worker families can be CPU- and memory-intensive and must run separately.

The existing cloud worker startup checks still apply. The runtime requires server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, explicit remote execution gates, an exact configured provider adapter (fully configured FAL or Runway Model Router), and `CLOUD_VIDEO_OUTPUT_HOSTS`. The provider worker keeps its existing quote/approval, spend reservation, idempotency, lease, output-ingestion and actual-cost reconciliation requirements. Missing configuration fails startup; it never silently enables provider calls.

Recommended low-resource starting values for an operator-approved test:

- `CLOUD_WORKER_POLL_MS=5000`
- `CLOUD_WORKER_LEASE_SECONDS=90`
- `CLOUD_WORKER_HEARTBEAT_MS=15000`
- `CLOUD_WORKER_MAX_BYTES=262144000`

The API health response reports `cloudVideoWorker.runtimeMode=embedded-api-process` and `inProcessSupervisorActive=true` only when the supervisor actually starts. Otherwise it continues to report the separate-process mode.

On SIGINT/SIGTERM, the API stops polling and awaits the worker supervisor's graceful stop before closing its database and HTTP server.

## Resource and release cautions

- This shares the web service's CPU and memory with the API. Start with a single worker family and low polling frequency; monitor memory, restarts and queue age before considering broader workloads.
- Do not enable this on production until an isolated staging environment has passed the full cloud video quote → explicit approval → queue → provider task → private output ingestion → actual-cost settlement flow.
- Never paste credentials into source files, commits, logs or browser configuration. Set secrets only through the hosting provider's protected environment settings.
- This option does not provision storage, create a Supabase project, change a database, enable paid generation or modify Render settings automatically.
