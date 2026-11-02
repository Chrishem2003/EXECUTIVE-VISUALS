# Execution architecture

## Target API
- POST /api/projects
- GET /api/projects/:projectId
- POST /api/projects/:projectId/briefs
- POST /api/projects/:projectId/workflows/validate
- POST /api/projects/:projectId/jobs
- GET /api/jobs/:jobId
- POST /api/jobs/:jobId/cancel
- POST /api/assets/upload-intents
- POST /api/assets/complete
- GET /api/assets/:assetId/download
- POST /api/consents
- GET /api/providers/capabilities
- POST /api/webhooks/:provider

## Orchestration
Authenticate user; resolve workspace permissions; validate graph, inputs, file types, rights and consent; estimate cost and enforce budgets; choose adapter by capability, quality, price, latency, region and licensing; create idempotent job; dispatch; persist provider ID; poll or accept signed webhook; normalize outputs; validate media; checksum and store lineage; record usage and audit; notify client. Retry transient failures only.

## Media infrastructure
Use private object storage, short-lived signed URLs, streaming uploads and checksum verification. Never store media blobs in localStorage. Use FFmpeg or another licensed processing engine for deterministic transcode, trim, concat, audio mix, subtitles, frame extraction and thumbnails. Route AI operations through authorized providers or a user-managed local inference service.

## Consent record
Store subject, scope, permitted operations, proof reference, timestamp, expiry/revocation and verifying actor. Do not store raw identity documents unless essential. A UI toggle alone is not production-grade consent evidence.


## Worker leases and recovery

The local queue uses database-conditional claims so two API processes sharing the same SQLite database cannot both claim the same queued job. A claimed job records its worker ID, lease expiry and heartbeat timestamp. Workers renew leases while work is active. If a process disappears, another worker can recover an expired lease, retry within the bounded attempt count and apply exponential delay before the next attempt.

Cancellation is persisted in the job row. Media workers poll that state while an external process is running, so a cancellation request can stop a process even when the API request reaches a different worker process. The active child is also terminated immediately when the owning worker loses its lease.

This is multi-process coordination on one shared SQLite database and media volume. It is not a multi-host distributed queue: multiple machines require a shared transactional database, shared object storage, and a separately deployed worker service. The cloud SQL migration includes corresponding lease fields but remains unapplied until an isolated staging database is approved.

## Worker lease finalization ordering

The shared cloud worker stops scheduling heartbeats and awaits any in-flight lease renewal before attempting a terminal `succeeded` or `failed` transition. This prevents a renewal RPC that began during execution from racing the finish RPC and producing a misleading lease-lost event after a successful completion. If renewal fails or the lease is no longer owned, the worker does not finalize the job; normal expired-lease recovery remains responsible for reclaiming it. Regression coverage holds a renewal request open while execution returns and verifies that the terminal transition waits for renewal settlement.
