# Executive Visuals — implementation status

**Updated:** 1 November 2026  
**Branch:** `feat/executive-visuals-unified-platform`  
**Delivery posture:** local runtime implemented; cloud and paid integrations remain gated.

## Implemented in the current branch

| Area | Implemented behavior | Boundary |
|---|---|---|
| Product shell | Unified browser application with creative, planning and management workspaces | Browser app |
| Capability explorer | Search and domain filters; displays stable ID, inputs, outputs, evidence, execution modes and approval gates | Registry browsing |
| Research & knowledge workspace | Project-scoped source register, manually initiated public HTTPS page extraction, HTML/plain-text parsing, author/date/title capture, tagged findings, source-linked excerpts, server-enforced evidence for verified records and full-text filtering | One URL per user action; HTTPS only, public DNS/IP checks with pinned address, no redirects beyond three, 2 MB response cap, 12,000-character stored excerpt, no paywall bypass or independent fact verification |
| Workflow knowledge retrieval | Typed workflow node searches saved project knowledge, ranks title/tag/content matches and returns linked source provenance and explicitly untrusted JSON text for downstream workflow steps | Deterministic keyword retrieval only; no vector index or autonomous crawling |
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
| Asset library | Owner isolation, metadata, original/derivative relationship, private file reads, image/video/audio/document previews and processing history | Local media volume; cloud storage upload/signing adapter is contract-tested but not connected to asset API |
| Job queue | Persistent queue, idempotency keys, normalized states, progress events, renewable worker leases, stale-worker recovery, bounded retries with exponential backoff, cross-process cancellation polling and audit trail | Multi-process lease coordination on a shared SQLite database; multi-host workers still require a shared Postgres queue |
| Local media engine | Probe, thumbnail, transcode, audio extraction, proxy generation, video denoise, color correction, resize/reframe, frame interpolation, FFmpeg scaling, audio denoise/loudness normalization and timeline MP4 master rendering | Requires FFmpeg/FFprobe; neural restoration, advanced stabilization, animated/video overlays, transitions and advanced effects remain pending |
| Runtime console | Sign-in, project creation, persistent asset library, live engine readiness, uploads, media job submission, job inspection and audit view | Browser UI uses the local API; creative briefs, shot lists, characters, research sources and linked knowledge records sync to project workspace documents |
| Project collaboration | Owner-managed invitations with editor, reviewer and viewer roles; access revocation enforced across project records | Existing local accounts only; invitation email delivery not connected |
| Review and approvals | Timecoded comments, approve/request-changes decisions and status updates | Local API persistence; external review links and visual drawing annotations not implemented |
| Editorial timeline | Multi-track clips, rational source timebases, trim, split, move, markers, overlap validation, interchange export and local MP4 master render | FFmpeg supports synchronized audio, still-image overlays, burned-in SRT/VTT captions and per-clip gain; preview playback, transitions, effects and animated/video overlays remain pending |
| Timeline persistence | Owner-scoped timelines, asset ownership checks, optimistic revisions and saved interchange package | SQLite local DB; isolated SQL migration pending dedicated database review |
| Database migration and cloud queue adapter | Dedicated multi-tenant schema, row-level security, immutable workflow-run snapshots, private object-storage policies, atomic `SKIP LOCKED` job claiming, owner-bound lease renewal, bounded expired-lease recovery and lease-fenced completion RPCs; provider-neutral PostgREST queue adapter calls the four RPCs with server-only credentials, schema-scoped headers, argument/result validation and bounded request timeouts; private object-storage adapter supports bounded uploads, exact-path removal and same-origin expiring signed URLs; ownership-aware object-path builder matches the bucket policies (project UUID prefix for project assets, owner UUID for personal assets); generic cloud worker cycle claims, heartbeats, executes with an abort signal, and lease-fenced finishes or failures; authorization-aware cloud asset repository validates ownership/project permissions before upload/read/delete, verifies SHA-256, persists metadata through the isolated schema, compensates failed metadata inserts by removing uploaded objects, and reports cleanup-pending states | Adapter contract tests are in CI, but the migration is **not applied**, the custom schema must be exposed in the isolated project's API settings, cloud storage policies must be applied, the cloud worker cycle is an orchestration contract with an injected executor, and the cloud asset repository is **not connected to the existing SQLite-dependent media/workflow executors or asset API**; never apply to shared staging or another product's database |
| Text-model adapter | Server-side chat-completions-compatible text gateway with request timeouts, sanitized errors, usage normalization, server-only credentials and upstream approval ancestry | Disabled by default; remote gateways require explicit server opt-in; no provider price estimator; local/remote endpoint must be configured |
| Speech synthesis | Approved `voice.generate` workflow node using a provider-neutral speech gateway; checks presenter voice scope when an identity profile is selected; validates and stores MP3/WAV/FLAC/OGG narration as a private checksummed asset | Disabled by default; remote HTTPS requires explicit server opt-in; no live provider call used for verification; transcription, diarization, cloning, dubbing and lip-sync remain unimplemented |
| Speech transcription | `voice.transcribe` workflow node accepts an accessible audio asset, verifies its path, size and SHA-256, requires upstream human approval, sends bounded multipart audio to the configured speech gateway and persists transcript, language, duration and timestamped segments in the immutable workflow node output | Disabled by default; shares server-side speech gateway and remote HTTPS opt-in; local mock-server end-to-end test; no provider call used |\n| Timed captions | `voice.caption` converts timestamped transcript segments into sanitized WebVTT, persists a private `text/vtt` asset with SHA-256 and source-audio/language provenance, and exposes typed subtitle/asset outputs for downstream editorial workflows | Up to 5,000 cues and 2 MiB per caption asset; captions can be placed on an existing timeline caption track; no automatic timeline mutation |\n| Caption localization | `voice.translate` uses the existing approval-gated text gateway to translate caption text while preserving cue count, order and exact source timing; output includes target-language metadata and normalized usage | Up to 500 cues and 30,000 source characters per request; requires explicit upstream approval and a configured text gateway; disabled unless server opt-in; no provider pricing estimator |
| Model usage ledger | Durable, project-scoped usage events for text, image, video, speech synthesis and transcription workflow calls; records provider/model/capability, token counts when supplied, latency and workflow/job/node lineage; owner-authenticated API readout | Cost is deliberately null until verified provider pricing is configured; ledger does not store prompts, generated content or credentials; first 200 events returned per query |\n| Security posture | Restrictive HTML CSP, anti-framing, referrer and cross-origin headers; role-checked project documents; no provider secrets in browser | Cloud identity/session hardening still pending |
| Quality checks | Capability parity, queue lease/retry tests, approval-gated AI workflow integration, project workspace API role/revision tests, workflow planner, timeline validation, real FFmpeg MP4 output/probe and pixel checks, API security tests, TypeScript and Vite build | CI verifies local behavior, not cloud durability or external media-generation providers |

## Build verification

The build pipeline runs:
1. Capability catalog parity and completeness checks.
2. Workflow graph validation, targeted-run behavior and project-knowledge retrieval checks.
3. API integration tests for authentication, ownership isolation, project workspace persistence, revision conflicts, role permissions, uploads and idempotency.
4. Mock-gateway tests for server-side text generation, remote-access controls and approval gating.
5. API tests for research-source URL validation, source-linked knowledge persistence, partial document saves, role enforcement and safe research import rejection.\n6. Workflow context tests ensure imported source text is passed as untrusted quoted data, not executable instructions.\n6. Research importer tests for HTTPS restrictions, private-network blocking, HTML extraction, metadata capture, size limits and unreadable pages.
5. Real FFmpeg rendering and output inspection.
6. Real FFmpeg/FFprobe fixture execution for denoise, color correction, resize, interpolation and scaling with invalid-parameter rejection.
6. TypeScript typecheck.
7. Production Vite build.

A green build does not prove external provider execution, cloud durability, frame-accurate playback or collaborative editing.

## Not yet production-complete

- Durable cloud database and object storage in a dedicated isolated project; PostgREST queue and private object-storage adapters plus a lease-aware worker-cycle orchestrator are implemented and contract-tested, but remain intentionally disconnected until the isolated schema is exposed, storage policies and credentials are configured, and the media/workflow data layer is cloud-compatible.
- Production OAuth/session refresh, email invitations and distributed multi-tenant collaboration.
- Multi-host workers, dead-letter queue, lease metrics and guaranteed process-tree termination on cancellation.
- Resumable/chunked uploads and range downloads.
- Timeline preview playback, transitions, effects, animated/video overlays, cache invalidation and round-trip tests against an independent interchange implementation.
- External image/video generation and enhancement remain provider-gated; approved speech synthesis is implemented through a separate provider-neutral gateway. Transcription, diarization, voice cloning, dubbing and lip-sync remain unimplemented.
- Local model inventory, hardware preflight and model routing/benchmarking.
- Diarization, dubbing and lip synchronization integrations; speech synthesis and transcription are implemented as separately gated workflow nodes and remain disabled until configured.
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
- Speech cleanup using `afftdn` noise reduction and `loudnorm` normalization to a bounded target loudness.
- Color correction using bounded brightness, contrast and saturation.
- Aspect-ratio reframing with contain/cover modes and safe even-dimension output.
- Frame interpolation using bounded `minterpolate` frame rates.
- Video upscaling/reframing using Lanczos-capable scale/pad pipelines (the current implementation uses FFmpeg scaling; it is not a learned super-resolution model).

Video operations are available to workflow graphs as `media.denoise`, `media.color`, `media.resize`, `media.interpolate` and `media.upscale` (with `video.resize` mapped to the same resize adapter). They require an accessible video source and create a new private MP4 derivative with SHA-256 lineage. Speech cleanup is available as `media.audio-clean`, accepts an accessible audio source and creates a private WAV derivative. Original source media is preserved. All numeric inputs and fit modes are bounded and shell commands are passed as argument arrays, not user-built shell strings.

The build now includes real FFmpeg/FFprobe fixture checks for each video operation and speech cleanup, plus invalid-parameter rejection tests. The Enhancement Lab and asset library submit these operations to the persistent job queue, and the output is returned as a private derivative. These are local media operations; they do not imply remote model-based restoration, face retouching, generative object removal, advanced stabilization, or paid enhancement services are available.


## Presenter identity authorization update — scoped permissions

Presenter and character profiles now persist a structured identity-permission record rather than relying on a boolean confirmation:

- Profile categories distinguish fictional, documented-authorized and not-granted identities.
- Authorization scopes are explicit: likeness, voice, face animation, lip-sync and identity transfer.
- Real-person authorization requires a non-sensitive evidence reference and a valid calendar expiry date.
- The workflow executor checks the saved project profile before identity-linked image or video generation; absent, expired or out-of-scope permission blocks execution.
- Existing legacy boolean consent values are normalized to `not-granted`; they are not silently upgraded to authorization.
- Unit and API tests cover scope enforcement, expiry, missing evidence and persistence.

This is an enforceable authorization foundation, not a claim that voice cloning, dubbing or lip-sync generation is implemented. Identity references are still not accepted by the current generic image/video adapters, which remain limited to their documented inputs.


## Approved narration generation — connected workflow capability

The existing voice-generation workflow node now has a real, provider-neutral OpenAI-compatible speech gateway:

- Uses server-side configuration only; provider credentials are never sent to the browser.
- Disabled by default. Remote HTTPS calls require a separate explicit server-side opt-in after provider pricing is reviewed.
- Requires a completed upstream human-approval node and, when a presenter identity profile is selected, an explicit voice permission scope.
- Bounds script length, voice identifier, playback speed, request timeout and output size.
- Rejects redirects, insecure remote URLs, oversized responses and mismatched/unsupported audio signatures.
- Streams output with a hard 50 MiB cap, stores the generated narration as a private project asset, and records checksum plus generation provenance.
- No provider credentials or live paid calls were used for verification; tests use a local mock HTTP server.

This enables approved narration generation where a compatible provider is configured. It does not implement voice cloning, identity imitation, diarization, dubbing or lip-sync.

## Approved audio transcription — connected workflow capability

- Added a real `voice.transcribe` workflow node and a matching visual workflow-palette entry.
- Requires an accessible audio asset, a completed upstream human-approval node, a verified storage path, a 50 MiB input cap and SHA-256 integrity verification before dispatch.
- Sends multipart audio to the configured server-side speech gateway, requests timestamped verbose output, caps response size and transcript length, and normalizes language, duration and segment timestamps.
- Transcript and timing data are saved in the workflow node-run output, preserving the source asset and run history without creating a mutable replacement.
- Transcription is independently disabled by default with `VOICE_TRANSCRIPTION_ENABLED=false`; remote calls additionally require the existing explicit HTTPS gateway opt-in.
- An end-to-end local mock-server test verifies the approval gate, source-audio integrity, multipart request and durable transcript output. No paid provider call was used.
- This is transcription, not speaker diarization, voice cloning, dubbing or lip-sync.


## Transcription-to-editing bridge — timed caption assets

The speech workflow now continues beyond transcript storage:

- `voice.transcribe` exposes timestamped segments, source-audio identity and detected language as typed workflow outputs.
- A new `voice.caption` node validates cue timing, orders cues, removes markup/control characters, escapes caption text and emits WebVTT.
- The generated subtitle is stored as a private `text/vtt` asset with SHA-256, source-audio ID, detected language, cue count and job provenance.
- The caption node exposes typed subtitle-file and asset outputs. Connect the subtitle asset to a caption track in the existing timeline editor; the current FFmpeg master renderer already supports WebVTT caption clips.
- The end-to-end mock-gateway test now runs approval → transcription → caption generation and verifies the durable VTT asset, cue timing and language/source lineage. A separate caption test checks malformed cues, sanitization and private asset storage.

The bridge does not silently modify a saved timeline, translate captions or call a paid service. Timeline placement remains an explicit editorial action, and the speech gateway remains disabled unless configured and explicitly enabled.


## Timing-preserving caption localization

- Added a `voice.translate` workflow node that accepts timestamped caption segments and requires a completed upstream human-approval checkpoint.
- The node uses the existing server-side text gateway; it does not call a separate provider or expose credentials to the browser.
- Translation is constrained to cue text. The response must be valid structured JSON with exactly one ordered result per source cue; the executor retains the original start/end values and rejects missing, reordered or malformed results.
- Limits are 500 cues and 30,000 source characters per request. The output includes translated segments, target language, source language, model and normalized usage, and can feed the existing caption-generation node to create a localized WebVTT asset.
- A local mock-gateway end-to-end test verifies approval, exact cue timing preservation, order and usage normalization. No paid provider request was used.

The text gateway remains disabled unless configured and explicitly enabled. Translation does not estimate provider cost; review provider pricing before enabling a remote endpoint.


## Subtitle-to-timeline handoff

Generated WebVTT assets now include their exact duration in metadata as well as cue count, source-audio ID, language, job provenance and SHA-256. The editorial timeline's existing asset picker reads that duration for VTT files and pre-fills the clip duration. The editor already validates caption-track media types and saves timeline changes with optimistic revision checks. An editor can therefore select the generated VTT asset, place it on a caption track, save the sequence and queue the existing MP4 master renderer. The workflow does not silently mutate a timeline; placement is an explicit editing action.


The workflow inspector now exposes a dedicated target-language field for caption localization, while retaining advanced JSON configuration for other settings. Source caption cues are explicitly treated as untrusted content by the translation instruction, and commands embedded in cues must not be followed. The latest full CI run before this final instruction-only hardening passed TypeScript and the complete build pipeline; the prompt-hardening commit is included in the current branch and awaits its own CI confirmation.

## Shared provider control layer — implemented

- Added a server-side provider registry for text, image, video, speech synthesis, transcription and local media execution.
- Added authenticated `GET /api/providers` so the signed-in workspace can inspect provider readiness without receiving API keys, endpoint credentials or other secrets.
- Readiness distinguishes disabled, needs configuration, remote opt-in required, ready and unavailable states.
- Capability matching only selects a provider that is enabled, correctly configured and policy-eligible. Remote selection requires an explicit caller opt-in as well as the relevant server-side remote setting.
- Model identifiers and capability names may be shown; credentials and raw endpoint URLs are never returned.
- The registry reports no invented prices and does not submit provider requests. It is an inspection and routing foundation, not a claim that a remote provider has been live-tested.
- Added unit and API tests for default-deny behavior, local gateway readiness, remote opt-in, malformed URLs, authentication, secret non-disclosure and no-request behavior.



### Shared provider execution enforcement

The provider catalog is now an execution gate, not only a status display. Workflow execution resolves readiness through the shared registry before invoking text generation, caption translation, image generation, video generation, voice synthesis or transcription. Missing, disabled, malformed or non-approved remote provider configuration blocks the node before its adapter is called. Remote permission is derived only from the corresponding server-side opt-in flag; a workflow cannot grant itself remote access. Existing human approval checks remain mandatory, and model-usage records use the selected shared provider identity. Provider readiness checks do not submit generation requests and do not expose credentials.


Cloud asset authorization: `server/cloud-asset-auth.mjs` implements fail-closed project role checks against the isolated `executive_visuals` schema. Project owners and editors may write; editors, reviewers and viewers may read. Personal assets are owner-scoped by the asset repository. The authorization adapter is contract-tested and is not wired to the live HTTP API; do not configure it with untrusted actor IDs or expose service-role credentials.
