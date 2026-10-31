# Executive Visuals — implementation status

**Updated:** 31 October 2026  
**Branch:** `feat/executive-visuals-unified-platform`  
**Delivery posture:** local runtime implemented; cloud and paid integrations remain gated.

## Implemented in the current branch

| Area | Implemented behavior | Boundary |
|---|---|---|
| Product shell | Unified browser application with creative, planning and management workspaces | Browser app |
| Capability explorer | Search and domain filters; displays stable ID, inputs, outputs, evidence, execution modes and approval gates | Registry browsing |
| Capability registry | **83 typed capabilities across 22 domains** | Contract/readiness metadata, not provider availability |
| Machine-readable catalog | JSON catalog generated from typed registry | Build verifier enforces ID/domain/label parity |
| Workflow graph | Typed node kinds, semantic media ports, graph edges and node configuration | Workflow persistence API exists; visual node editor still pending |
| Graph validation | Duplicate IDs, missing nodes/ports, incompatible ports, duplicate single-input edges, required inputs and cycle detection | Validation only |
| Targeted execution planning | Full graph, single-node and selected-subgraph dependency planning | Produces a plan only; not yet wired to external model execution |
| Output locking | Locked nodes with saved output IDs are reused; targeted reruns can stop at locked ancestors | Local planner behavior tested |
| Local API | HTTP API, development accounts, hashed passwords, HttpOnly sessions and owner-scoped resources | Local password auth is development-only |
| Projects | Persistent project creation, listing, optimistic revision updates and archive | SQLite local database |
| Media ingest | Binary uploads to local disk, MIME allowlist, upload-size limit and SHA-256 checksum | Local disk; cloud object storage not connected |
| Asset library | Owner isolation, metadata, original/derivative relationship and private file reads | No cloud storage or signed URLs yet |
| Job queue | Persistent queue, idempotency keys, normalized states, job events, cancellation state and audit trail | Single local worker; hard process termination still being completed |
| Local media engine | Probe, thumbnail, transcode, audio extraction and proxy operations | Requires FFmpeg/FFprobe installed on worker |
| Runtime console | Sign-in, project creation, uploads, media job submission, job inspection and audit view | Browser UI uses the local API |
| Database migration | Dedicated multi-tenant schema, row-level security and private object-storage policies | Migration is committed for review; **not applied** to shared staging |
| Quality checks | Capability parity, workflow planner checks and API integration tests | CI validates local contracts and API behavior, not cloud/provider integrations |

## Build verification

The build pipeline runs:
1. Capability catalog parity and completeness checks.
2. Workflow graph validation and targeted-run behavior checks.
3. API integration tests for authentication, ownership isolation, uploads, idempotency and unsupported-job rejection.
4. TypeScript typecheck.
5. Production Vite build.

A green build does not prove external provider execution, cloud durability, frame-accurate playback or collaborative editing.

## Not yet production-complete

- Durable cloud database and object storage in a dedicated isolated project.
- Production OAuth/session refresh and multi-tenant invitation flows.
- Distributed workers, leases, retries, dead-letter queue and actual process termination on cancellation.
- Resumable/chunked uploads, media signature sniffing and range downloads.
- Frame-accurate timeline editor, preview playback, cache invalidation and interchange round-trip tests.
- Full workflow node editor, per-node run history, partial reruns and provider execution.
- Local model inventory, hardware preflight and model adapters.
- Voice generation, transcription, diarization, dubbing and lip synchronization integrations.
- 3D rendering, live capture, remote recording and stream ingest.
- Review links, comments, annotations, sequence locks, presence and publish checkpoints.
- Publishing, channel analytics and campaign feedback loops.

## Safety and delivery rules

- Do not present a planned capability as available.
- Do not send paid provider requests without explicit approval and a cost estimate.
- Keep provider credentials server-side.
- Preserve original assets and immutable run snapshots.
- Record provenance, consent and source rights.
- Do not apply migrations to another product's shared database.
- Keep production deployment and production credentials untouched until dedicated staging verification is complete.
