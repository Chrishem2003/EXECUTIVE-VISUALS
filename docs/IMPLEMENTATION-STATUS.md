# Executive Visuals — implementation status

**Updated:** 31 October 2026  
**Branch:** `feat/executive-visuals-unified-platform`  
**Delivery posture:** local runtime implemented; cloud and paid integrations remain gated.

## Implemented in the current branch

| Area | Implemented behavior | Boundary |
|---|---|---|
| Product shell | Unified browser application with creative, planning and management workspaces | Browser app |
| Capability explorer | Search and domain filters; displays stable ID, inputs, outputs, evidence, execution modes and approval gates | Registry browsing |
| Capability registry | **110 typed capabilities across 23 domains** | Contract/readiness metadata, not provider availability |
| Cross-ecosystem capability expansion | Model evaluation/routing, structured template autofill, brand glossary, live presence, proxy review, remote recording, motion template rendering, continuity checks, semantic asset search, workflow diff/batch and analytics feedback | Specification-only until adapters and end-to-end tests exist |
| Machine-readable catalog | JSON catalog generated from typed registry | Build verifier enforces ID/domain/label parity |
| Workflow graph | Draggable visual node editor, typed ports, connections, node configuration, server-side graph validation, immutable run snapshots, per-node status, approval pause/resume, local adapter execution and approval-gated text-model execution | Text/data, asset references, frame extraction, audio extraction, probe, transcode, export and timeline nodes run locally; unsupported provider/model nodes are explicitly blocked |
| Graph validation | Duplicate IDs, missing nodes/ports, incompatible ports, duplicate single-input edges, required inputs and cycle detection | Validation only |
| Targeted execution | Full graph, single-node and selected-subgraph dependency planning; branch routing; locked-output reuse; partial reruns; immutable run snapshots; per-node state and approval pause/resume | Local adapters execute; remote generation nodes fail closed with an explicit adapter-unavailable status |
| Output locking | Locked nodes with saved output IDs are reused; targeted reruns can stop at locked ancestors | Local planner behavior tested |
| Local API | HTTP API, development accounts, hashed passwords, HttpOnly sessions, owner-scoped resources, restrictive HTML CSP, anti-framing and referrer/security headers | Local password auth is development-only |
| Projects | Persistent project creation, listing, optimistic revision updates, archive and project-scoped creative workspace documents with revision conflict protection | SQLite local database; owner/editor writes and viewer reads |
| Media ingest | Binary uploads to local disk, MIME allowlist, upload-size limit and SHA-256 checksum | Local disk; cloud object storage not connected |
| Asset library | Owner isolation, metadata, original/derivative relationship, private file reads, image/video/audio/document previews and processing history | Local media volume; no cloud storage or signed URLs yet |
| Job queue | Persistent queue, idempotency keys, normalized states, progress events, renewable worker leases, stale-worker recovery, bounded retries with exponential backoff, cross-process cancellation polling and audit trail | Multi-process lease coordination on a shared SQLite database; multi-host workers still require a shared Postgres queue |
| Local media engine | Probe, thumbnail, transcode, audio extraction, proxy generation and timeline MP4 master rendering with synchronized audio, still-image overlays, per-clip gain and burned-in SRT/VTT captions | Requires FFmpeg/FFprobe; one primary video track; animated/video overlays, transitions and advanced effects remain pending |
| Runtime console | Sign-in, project creation, persistent asset library, live engine readiness, uploads, media job submission, job inspection and audit view | Browser UI uses the local API; creative briefs, shot lists and characters sync to project workspace documents |
| Project collaboration | Owner-managed invitations with editor, reviewer and viewer roles; access revocation enforced across project records | Existing local accounts only; invitation email delivery not connected |
| Review and approvals | Timecoded comments, approve/request-changes decisions and status updates | Local API persistence; external review links and visual drawing annotations not implemented |
| Editorial timeline | Multi-track clips, rational source timebases, trim, split, move, markers, overlap validation, interchange export and local MP4 master render | FFmpeg supports synchronized audio, still-image overlays, burned-in SRT/VTT captions and per-clip gain; preview playback, transitions, effects and animated/video overlays remain pending |
| Timeline persistence | Owner-scoped timelines, asset ownership checks, optimistic revisions and saved interchange package | SQLite local DB; isolated SQL migration pending dedicated database review |
| Database migration | Dedicated multi-tenant schema, row-level security, immutable workflow-run snapshots, server-only job/audit writes and private object-storage policies | Migration is committed and statically guarded; **not applied** to shared staging or another product's database |
| Text-model adapter | Server-side chat-completions-compatible text gateway with request timeouts, sanitized errors, usage normalization, server-only credentials and upstream approval ancestry | Disabled by default; remote gateways require explicit server opt-in; no provider price estimator; local/remote endpoint must be configured |
| Security posture | Restrictive HTML CSP, anti-framing, referrer and cross-origin headers; role-checked project documents; no provider secrets in browser | Cloud identity/session hardening still pending |
| Quality checks | Capability parity, queue lease/retry tests, approval-gated AI workflow integration, project workspace API role/revision tests, workflow planner, timeline validation, real FFmpeg MP4 output/probe and pixel checks, API security tests, TypeScript and Vite build | CI verifies local behavior, not cloud durability or external media-generation providers |

## Build verification

The build pipeline runs:
1. Capability catalog parity and completeness checks.
2. Workflow graph validation and targeted-run behavior checks.
3. API integration tests for authentication, ownership isolation, project workspace persistence, revision conflicts, role permissions, uploads and idempotency.
4. Mock-gateway tests for server-side text generation, remote-access controls and approval gating.
5. Real FFmpeg rendering and output inspection.
6. TypeScript typecheck.
7. Production Vite build.

A green build does not prove external provider execution, cloud durability, frame-accurate playback or collaborative editing.

## Not yet production-complete

- Durable cloud database and object storage in a dedicated isolated project.
- Production OAuth/session refresh, email invitations and distributed multi-tenant collaboration.
- Multi-host workers, dead-letter queue, lease metrics and guaranteed process-tree termination on cancellation.
- Resumable/chunked uploads and range downloads.
- Timeline preview playback, transitions, effects, animated/video overlays, cache invalidation and round-trip tests against an independent interchange implementation.
- External image/video generation, speech, dubbing, lip-sync and enhancement provider adapters; the text gateway is the only remote model adapter implemented.
- Local model inventory, hardware preflight and model routing/benchmarking.
- Voice generation, transcription, diarization, dubbing and lip synchronization integrations.
- 3D rendering, live capture, remote recording and stream ingest.
- Review links, comments, annotations, sequence locks, presence and publish checkpoints.
- Publishing, channel analytics and campaign feedback loops.

## Safety and delivery rules

- Do not present a planned capability as available.
- Do not send billable provider requests without explicit human approval and a verified price/budget check. The generic text adapter records token usage but does not estimate provider cost; remote gateway access is disabled by default.
- Keep provider credentials server-side.
- Preserve original assets and immutable run snapshots.
- Record provenance, consent and source rights.
- Do not apply migrations to another product's shared database.
- Keep production deployment and production credentials untouched until dedicated staging verification is complete.

## Consolidated media-engine update — local enhancement path

The shared production engine now exposes a first set of local, FFmpeg-backed finishing operations through the same persistent job and asset-lineage path as existing media processing:

- Video denoise using bounded `hqdn3d` parameters.
- Color correction using bounded brightness, contrast and saturation.
- Aspect-ratio reframing with contain/cover modes and safe even-dimension output.
- Frame interpolation using bounded `minterpolate` frame rates.
- Video upscaling/reframing using Lanczos-capable scale/pad pipelines (the current implementation uses FFmpeg scaling; it is not a learned super-resolution model).

These operations are available to workflow graphs as `media.denoise`, `media.color`, `media.resize`, `media.interpolate` and `media.upscale` (with `video.resize` mapped to the same resize adapter). They require an accessible video source and create a new private MP4 derivative with SHA-256 lineage; original source media is preserved. All numeric inputs and fit modes are bounded and shell commands are passed as argument arrays, not user-built shell strings.

The build now includes a real FFmpeg/FFprobe fixture check for each operation plus invalid-parameter rejection tests. These are local media operations; they do not imply remote model-based restoration, face retouching, generative object removal, advanced stabilization, or paid enhancement services are available. The production UI's enhancement workspace still needs to be wired to these persistent API jobs rather than merely creating planning tasks.
