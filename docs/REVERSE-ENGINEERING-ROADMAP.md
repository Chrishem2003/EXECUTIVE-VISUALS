# Reverse Engineering and Runtime Delivery Roadmap

## Operating method

1. Map the public surface: product workflows, help articles, developer docs, public schemas, changelogs and public examples.
2. Record evidence separately from inference and unknowns.
3. Inspect authorized authenticated interfaces when the owner supplies access or screenshots.
4. Build an original capability contract and data model.
5. Implement adapters behind a provider-neutral boundary.
6. Test offline/local behavior before external calls.
7. Require human approval for paid work, publishing, identity use, deletion and third-party data transfer.
8. Preserve originals, versions, checksums and audit trails.

## Current verified milestone

- Local API with development account auth, SQLite persistence, private file uploads, checksum metadata, projects, workflows, job/event records and audit events.
- Local FFmpeg adapter for probe, thumbnail, transcode, audio extraction and proxy jobs.
- Capability atlas and typed workflow planner.
- API integration tests for account isolation, upload ownership, idempotency and unsupported capability rejection.
- Browser runtime console for login, project creation, media upload and job inspection.

## Next implementation milestones

### M1 — Make local media runtime production-grade
- Real cancellation that terminates the active process.
- Per-job progress and stage events.
- File signature validation, quotas, resumable chunk upload and cleanup of abandoned partial files.
- Range downloads and secure signed/short-lived media URLs.
- Media probe metadata persisted to asset records.
- Thumbnail generation and proxy linking surfaced in the editor.
- Deterministic integration fixtures with real short media files.

### M2 — Real timeline and workflow execution
- Track/clip/transition/gap/marker model using rational frame time.
- Timeline editor with multi-track drag/reorder, trim/split, snapping, playback preview and undo/redo.
- Export/import open timeline interchange.
- Workflow graph editor with typed ports, branch/merge, batch, subworkflow and node configuration.
- Workflow versions, run snapshots, per-node events, retries and partial reruns.
- Output locks and immutable node outputs.

### M3 — Dedicated multi-tenant cloud runtime
- Dedicated database project or development branch; do not reuse shared staging tables.
- RLS verification for every table and object-storage bucket.
- Durable object storage and persistent database.
- Production authentication, membership invitations and role-based authorization.
- Background worker, lease recovery, webhook verification, dead-letter handling and rate limits.
- Backups, retention, restore test and monitoring.

### M4 — Professional collaboration and delivery
- [x] Cloud mastering controls, measured output report and durable render history (draft PR chain #130–#132; merge order and release review pending).
- [ ] Platform delivery profiles (draft PR #133): source dimensions, YouTube 1080p landscape, vertical 1080p and square 1080p; server allow-list, durable job input, H.264/AAC render settings and output-dimension tests. HDR tone mapping remains explicitly out of scope.
- [ ] Automated delivery certification (draft PR #134): inspect the final published candidate with FFprobe; verify MP4 container, H.264, yuv420p, requested dimensions, frame rate, duration tolerance and AAC/48 kHz when audio is present; block publication on failed technical checks; display and export a versioned evidence report. This is technical profile validation, not platform acceptance, rights review or creative-quality certification.
- Review links, timestamped comments, drawing annotations, approvals and revision comparison.
- Project/sequence locking, presence and publish checkpoints.
- Asset version lineage, shared libraries, metadata search and content provenance.
- Export presets, subtitles, language packages, distribution renditions and delivery validation.

### M5 — Local and external creative engines
- Runtime discovery, model inventory, dependency checks and hardware preflight.
- Provider-neutral adapters with live contract tests.
- Model routing by capability, quality, latency, region, cost and rights.
- Budget ceilings, estimates, idempotency, cancellation and signed webhooks.
- Paid provider dispatch disabled until explicitly approved.

## Non-negotiable boundaries

- Do not reverse engineer private endpoints, bypass authentication, scrape protected accounts or copy proprietary code/assets.
- Do not claim access to hidden implementation details.
- Do not apply schema migrations to another product's shared database.
- Do not deploy a paid service or create a billable database branch without confirming the exact cost.
- Do not enable paid media generation by default.
- Do not merge or deploy production without release gates.
