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
