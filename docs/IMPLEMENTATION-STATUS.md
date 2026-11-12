# Executive Visuals — implementation status

**Updated:** 9 November 2026  
**Branch:** `main` (studio polish PR #266, upscaling integrity PRs #268 and #271, evidence docs #269, video pricing docs #272 and reviewer validation #273 merged; quality CI passed)  
**Delivery posture:** local runtime implemented; external-auth staging blueprint hardened; public release not approved pending account sign-in UX, isolated auth configuration, durable-data recovery tests and deployment verification.

## Supabase browser-session hardening — PR #436 (not yet merged)

- The browser receives one opaque, high-entropy `HttpOnly; Secure; SameSite=Strict` session cookie; Supabase access and refresh tokens are no longer emitted as browser cookies or attached globally to ordinary API requests.
- The opaque session identifier is stored only as a SHA-256 hash. Provider access/refresh tokens are encrypted at rest with AES-256-GCM, with authenticated additional data binding ciphertext to the session hash, user ID and token purpose.
- Refresh-token rotation stays server-side and must resolve to the same authenticated user. Logout revokes the provider session where possible and deletes the local session record.
- Supabase-mode state-changing requests require an exact same-origin Origin and compatible Fetch Metadata signal. The signed Flutterwave webhook remains an explicit server-to-server exception.
- The password-recovery fragment token is held transiently in memory and sent only to the password-update endpoint through a narrow explicit bearer helper; it is not retained as a global API credential.
- The implementation requires a dedicated 32-byte `SUPABASE_SESSION_ENCRYPTION_KEY` in the server secret manager. Supabase mode refuses to start without it.
- Unit tests cover hashed identifiers, authenticated encryption, token rotation, expiry, revocation, malformed secrets and cross-origin mutation rejection.
- **Release boundary:** PR #436 is code-only until exact-head CI and review pass. Do not enable Supabase auth or deploy this mode until the secret is provisioned in an approved isolated staging environment, the session database is durable and staging sign-in/refresh/logout/recovery smoke tests pass. The current free Render runtime still uses local SQLite/disk and is not a certified durable customer environment.


## Implemented in the current branch

| Area | Implemented behavior | Boundary |
|---|---|---|
| Product shell and navigation | Unified browser application with a dedicated Explore directory, searchable capability catalogue, persistent grouped navigation, collapsible desktop rail, mobile drawer, active workspace states and Ctrl/Cmd-K command search; studio readability pass adds stronger typography and contrast, responsive layout refinements, visible keyboard focus and reduced-motion support | Browser app; keyboard and responsive navigation |
| Sign-in landing | Full-screen branded sign-in / account-creation experience with clear privacy messaging and mode-specific identity flow | Uses existing local development auth or configured external identity token verification; does not add a new OAuth provider or change backend auth policy |
| Creative DNA compiler | AI Director compiles a brief into an editable creative promise, audience contract, emotional journey, five hook mechanisms, visual grammar, sound identity, story beats, distribution cuts, proof/rights checks and preflight; completeness is a deterministic field-coverage score | Local deterministic planning; not model inference or media generation; cloud project settings include the compiled Creative DNA snapshot; automated tests pass in GitHub Actions |
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
| Asset provenance and C2PA Content Credentials | Deterministic application provenance records on upload; authenticated `GET /api/assets/:assetId/c2pa` uses pinned `@contentauth/c2pa-node@0.10.0` Reader/Context APIs; checksum and size are checked before/after native parsing; statuses distinguish trusted, valid-but-untrusted, invalid, absent and unavailable; real CAI-signed fixtures validate in CI | Signer-injected preservation hooks now cover cloud single-source media, local SQLite media (including AI upscale), local timeline masters and cloud timeline masters. Multi-source timelines preserve every credential-bearing source as an ingredient; output is re-hashed after signing; failed preservation blocks publication. Production signer and trust anchor remain unconfigured; Node 22.23.4+ required |
| Job queue | Persistent queue, idempotency keys, normalized states, progress events, renewable worker leases, stale-worker recovery, bounded retries with exponential backoff, cross-process cancellation polling and audit trail | Multi-process lease coordination on a shared SQLite database; multi-host workers still require a shared Postgres queue |
| Local media engine | Probe, thumbnail, transcode, audio extraction, proxy generation, video denoise, color correction, resize/reframe, frame interpolation, FFmpeg scaling, audio denoise/loudness normalization and timeline MP4 master rendering | Requires FFmpeg/FFprobe; neural restoration, advanced stabilization, animated/video overlays, transitions and advanced effects remain pending |
| Runtime console | Sign-in, project creation, persistent asset library, live engine readiness, uploads, media job submission, job inspection and audit view | Browser UI uses the local API; creative briefs, shot lists, characters, research sources and linked knowledge records sync to project workspace documents |
| Project collaboration | Owner-managed invitations with editor, reviewer and viewer roles; access revocation enforced across project records | Existing local accounts only; invitation email delivery not connected |
| Review and approvals | Timecoded comments, approve/request-changes decisions and status updates | Local API persistence; external review links and visual drawing annotations not implemented |
| Editorial timeline | Multi-track clips, rational source timebases, trim, split, move, markers, overlap validation, interchange export and local MP4 master render | FFmpeg supports synchronized audio, still-image overlays, burned-in SRT/VTT captions and per-clip gain; preview playback, transitions, effects and animated/video overlays remain pending |
| Creative intent traceability | Timeline clip inspector records story beat, audience promise, shot purpose, proof/source reference and creative decision note; coverage panel identifies clips without explicit intent anchors | Deterministic annotation analysis only; no automatic scene understanding or creative-quality scoring; trace metadata persists with the timeline; automated tests added to build |
| Creative decision ledger | Clip intent edits append timestamped, sequential before/after records; duplicate IDs rejected, no-op edits ignored, malformed persisted entries filtered and history bounded to 100 records; latest decisions visible in clip inspector | Append-only application contract within timeline metadata; no identity attribution beyond recorded time; not a multi-user conflict-free event store; tests added to build |
| Production readiness gate | Evidence aggregator combines eight required checks: sequence, source-media integrity, shot/engine compatibility, continuity, rights, captions/localization, audio and delivery; distinguishes passed, review, blocked and not-run; timeline workspace surfaces the decision and outstanding checks | Missing evidence remains not-run; readiness requires all checks to pass and means ready for human approval only; does not grant approval, render media or submit providers; automated tests pass in GitHub Actions |
| Master delivery conformance | Cloud render output is FFprobe-checked before publication; current-revision master evidence is compared against sequence-native or explicit delivery requirements for container, codec, resolution, frame rate, duration and required audio | Explicit delivery-profile schema is `timeline.metadata.deliverySpec` with optional `container`, `videoCodec`, `audioCodec`, `width`, `height`, `frameRate` and `requireAudio`; mastering does not certify perceptual quality, colour, true peak or platform-specific acceptance beyond these fields |
| Caption cue validation | Generated WebVTT is checked for header/timing validity, cue overlaps, empty text, excessive duration, reading speed, line length and media-duration bounds; saved reports feed the production gate | External SRT ingestion, subtitle localization quality, speaker attribution, WCAG-specific styling and human editorial review remain separate capabilities |
| Audio signal readiness evidence | Production gate verifies audio-source stream probes and saved FFmpeg signal metrics; missing measurements remain not-run; clipping and peaks at or above -1 dBFS require review; no universal loudness target is assumed | Requires audio assets to carry saved `signalAnalysis.audioMetrics`; no automatic true-peak, sync or perceptual listening assessment |
| Rights and consent evidence | Production gate checks explicit per-source rights clearance, supporting references, expiry, and separate subject-consent attestations when required; denied, revoked or expired permissions block readiness; missing evidence remains not-run | Asset metadata attestations are not independently verified legal documents; consent requirements must be explicitly recorded and independently reviewed by an authorized human |
| Source-media readiness evidence | Production gate consumes saved FFprobe evidence for every referenced source; verifies readable streams, expected video/audio track type and clip source ranges against probed duration; missing or invalid sources block, unprobed sources remain not-run | Probe-backed structural evidence only; no full decode, checksum revalidation, perceptual quality or corruption scan |
| Timeline variants and comparison | One-click independent timeline duplication with original/parent lineage; deterministic comparison of added, removed and changed clips, timing, source trims, track moves, markers and creative-intent annotations; local and cloud project creation; original sequence remains untouched | Structural comparison only; no pixel-level A/B playback, render-difference analysis, multi-user branch merge or automatic conflict resolution |
| Timeline persistence | Owner-scoped timelines, asset ownership checks, optimistic revisions and saved interchange package | SQLite local DB; isolated SQL migration pending dedicated database review |
| Database migration and cloud queue adapter | Dedicated multi-tenant schema, row-level security, immutable workflow-run snapshots, private object-storage policies, atomic `SKIP LOCKED` job claiming with server-side job-type filters, owner-bound lease renewal, bounded expired-lease recovery and lease-fenced completion RPCs; provider-neutral PostgREST queue adapter calls the four RPCs with server-only credentials, schema-scoped headers, argument/result validation and bounded request timeouts; private object-storage adapter supports bounded uploads, exact-path removal and same-origin expiring signed URLs; ownership-aware object-path builder matches the bucket policies (project UUID prefix for project assets, owner UUID for personal assets); generic cloud worker cycle claims, heartbeats, executes with an abort signal, and lease-fenced finishes or failures; cloud media worker factory composes the cloud queue, private asset service, media IO and executor into an explicit one-cycle worker entry point; its claim filter ensures it only leases supported media jobs (it does not start automatically); cloud media executor connects leased single-source media jobs (probe, thumbnail, audio extraction/cleanup, video enhancement, proxy and transcode) to verified cloud asset materialization and streamed derivative publication with checksum lineage; authorization-aware cloud asset repository validates ownership/project permissions before upload/read/delete, verifies SHA-256, persists metadata through the isolated schema, compensates failed metadata inserts by removing uploaded objects, and reports cleanup-pending states | Adapter contract tests are in CI, but the migration is **not applied**, the custom schema must be exposed in the isolated project's API settings, cloud storage policies must be applied, the cloud worker cycle and single-source cloud media executor are implemented and contract-tested, but no cloud worker process is deployed or auto-started; workflow execution still depends on SQLite and local asset paths; cloud timeline rendering now has a dedicated materialized-file FFmpeg worker, and a separate opt-in cloud asset API now supports bounded streaming ingest, private signed reads and soft-delete, but it is **not yet integrated into the existing asset-library UI/local asset API**; an opt-in authenticated cloud timeline API now exposes revision-checked timeline create/read/update, durable timeline.render job submission with idempotency, and role-checked job/event inspection using the verified Supabase user ID; CLOUD_TIMELINE_API_ENABLED defaults to false and refuses to start unless AUTH_MODE=supabase; never apply to shared staging or another product's database |
| Text-model adapter | Server-side chat-completions-compatible text gateway with request timeouts, sanitized errors, usage normalization, server-only credentials and upstream approval ancestry | Disabled by default; remote gateways require explicit server opt-in; no provider price estimator; local/remote endpoint must be configured |
| Speech synthesis | Approved `voice.generate` workflow node using a provider-neutral speech gateway; checks presenter voice scope when an identity profile is selected; validates and stores MP3/WAV/FLAC/OGG narration as a private checksummed asset | Disabled by default; remote HTTPS requires explicit server opt-in; no live provider call used for verification; transcription, diarization, cloning, dubbing and lip-sync remain unimplemented |
| Speech transcription | `voice.transcribe` workflow node accepts an accessible audio asset, verifies its path, size and SHA-256, requires upstream human approval, sends bounded multipart audio to the configured speech gateway and persists transcript, language, duration and timestamped segments in the immutable workflow node output | Disabled by default; shares server-side speech gateway and remote HTTPS opt-in; local mock-server end-to-end test; no provider call used |
| Timed captions | `voice.caption` converts timestamped transcript segments into sanitized WebVTT, persists a private `text/vtt` asset with SHA-256 and source-audio/language provenance, and exposes typed subtitle/asset outputs for downstream editorial workflows | Up to 5,000 cues and 2 MiB per caption asset; captions can be placed on an existing timeline caption track; no automatic timeline mutation |
| Caption localization | `voice.translate` uses the existing approval-gated text gateway to translate caption text while preserving cue count, order and exact source timing; output includes target-language metadata and normalized usage | Up to 500 cues and 30,000 source characters per request; requires explicit upstream approval and a configured text gateway; disabled unless server opt-in; no provider pricing estimator |
| AI Transformation Studio | Enhancement Lab creates and reloads private cloud transformation plans through authenticated `/api/cloud/transformations` routes; plans use the existing `jobs` table with `video.transform.plan` type, draft state, project authorization, source/reference validation, idempotency, rights/consent attestation and separate budget approval | Submission remains blocked with `TRANSFORMATION_ADAPTER_UNAVAILABLE`; no video adapter, transformation worker or paid execution; consent checkbox is an attestation, not verified evidence; cloud API requires the isolated schema to be provisioned |
| Model usage ledger | Durable, project-scoped usage events for text, image, video, speech synthesis and transcription workflow calls; records provider/model/capability, token counts when supplied, latency and workflow/job/node lineage; owner-authenticated API readout | Cost is deliberately null until verified provider pricing is configured; ledger does not store prompts, generated content or credentials; first 200 events returned per query |
| Security posture | Restrictive HTML CSP, anti-framing, referrer and cross-origin headers; role-checked project documents; no provider secrets in browser | Cloud identity/session hardening still pending |

| Quality checks | Capability parity, queue lease/retry tests, approval-gated AI workflow integration, project workspace API role/revision tests, workflow planner, timeline validation, real FFmpeg MP4 output/probe and pixel checks, API security tests, TypeScript and Vite build | CI verifies local behavior, not cloud durability or external media-generation providers |

## C2PA transformation-preservation expansion — current branch

- The shared preserver accepts multiple source assets, checks each registered SHA-256, validates each embedded source manifest, and writes the primary credential-bearing source as `parentOf` and additional sources as `componentOf` ingredients.
- Local media output paths now call preservation before asset insertion, including AI upscaling and the FFmpeg finishing operations. Timeline masters include all enabled video, audio and still-image overlay sources; caption text assets are not treated as media ingredients.
- Cloud timeline rendering now performs the same preservation step after rendering and before final probe/checksum/publication.
- Signed outputs are re-hashed after preservation; metadata records the preservation result. Local cancellation and cloud abort signals are passed through the preservation step.
- Baseline CI passed at exact branch head `d9784b4`: reproducible `npm ci`, typecheck, full build/regression suite, real CAI SDK multi-source signing/ingredient validation, local timeline provenance-hook checks (including real FFmpeg render), cloud timeline preservation-before-publication test, and disposable PostgreSQL asset-publication integration.
- Expanded acceptance CI passed at commit `4edd495` in run `8435`: `npm ci`, typecheck, full build/regression suite including the new local SQLite C2PA transcode round-trip (21/21 provenance tests), and the disposable PostgreSQL publication integration job.
- No production signer, private key, trust anchor, external signing service, deployment, paid provider request or database migration is configured or invoked.
- Added `server/tests/local-c2pa-roundtrip.test.mjs` to exercise the real local SQLite `media.transcode` publication path with an upstream test-only CAI signer, then read the published MP4 back and verify its embedded source ingredient and post-signing checksum. The first CI attempt exposed a missing persisted-job fixture; after correcting the fixture to create the real queued job row, the test passed (21/21 provenance tests) in GitHub Actions run `8435` at commit `4edd495`.
- Added `server/tests/c2pa-format-roundtrip.test.mjs` for real CAI SDK signing, transformation preservation and Reader validation across the application's six media formats: JPEG, PNG, WebP, MP3, WAV and MP4. All six round-trips passed; the provenance suite passed 28/28 tests in GitHub Actions run `8439` at commit `f5a4cc0`.
- Full branch CI run `8439` also passed dependency installation, typecheck, full build/regression suite and disposable PostgreSQL asset-publication integration.
- The preserver now hashes with native `AbortSignal` support, checks cancellation between SDK stages, normalizes aborts to `C2PA_TRANSFORM_ABORTED`, and retains compatibility with the local executor's lightweight cancellation adapter. Tests cover pre-abort, abort during callback signing (no output replacement and temp cleanup), streaming-hash cancellation, and oversize rejection before SDK loading. CI run `8447` passed the provenance suite (32/32), full server/build regression suite (453/453), typecheck and disposable PostgreSQL integration.
- Added `server/c2pa-callback-signer.mjs`, which wraps the official CAI `CallbackSigner.newSigner` using public X.509 certificates and a protected signing callback; it validates algorithm, certificate chain, reserve size, HTTPS TSA URL and returned signature bounds. A real CAI callback-signing transformation round-trip passed with test-only key material. CI run `8453` passed 33/33 provenance tests, 453/453 broader server tests, typecheck, full build and disposable PostgreSQL integration.
- Added `server/tests/local-c2pa-timeline-roundtrip.test.mjs`: the actual local SQLite timeline executor renders a signed video source with signed audio and still-image overlay inputs, then verifies all three embedded ingredient manifests in the final MP4 and checks the post-signing asset checksum. CI run `8456` passed 34/34 provenance tests, the full build/regression suite, typecheck and disposable PostgreSQL integration.
- Added `server/tests/local-c2pa-ai-upscale-roundtrip.test.mjs` and an injectable upscaler factory to the local executor. The test runs the actual SQLite `media.ai-upscale` job, uses a deterministic test-only Lanczos adapter (not a neural model), then verifies C2PA ingredient preservation, derivative linkage and post-signing checksum. CI run `8465` passed 35/35 provenance tests and 456/456 full regression tests, plus typecheck, full build and disposable PostgreSQL integration.
- Added visual Asset Library inspection for image/audio/video cards. The authenticated `GET /api/assets/:assetId/c2pa` response is displayed with separate trusted/valid-untrusted/invalid/not-present states, manifest summary, embedded source ingredients, validation findings and asset checksum. The existing API tests cover authenticated access and cross-user isolation; CI run `8460` passed the typecheck, full build/regression suite and disposable PostgreSQL integration.
- The KMS/HSM boundary, key isolation, workload-identity requirements, signing audit metadata, certificate policy and production release gates are documented in `docs/C2PA-PROTECTED-SIGNER-ARCHITECTURE.md`. No provider adapter or production key is activated.
- Remaining validation: actual Real-ESRGAN model inference end-to-end (the current executor test injects a deterministic non-neural fixture adapter), real near-limit large-file throughput/memory stress, broader codec/container variants, independent browser review of the asset inspection panel and isolated staging acceptance with an approved non-production signer.

## Build verification

The build pipeline runs:
1. Capability catalog parity and completeness checks.
2. Workflow graph validation, targeted-run behavior and project-knowledge retrieval checks.
3. API integration tests for authentication, ownership isolation, project workspace persistence, revision conflicts, role permissions, uploads and idempotency.
4. Mock-gateway tests for server-side text generation, remote-access controls and approval gating.
5. API tests for research-source URL validation, source-linked knowledge persistence, partial document saves, role enforcement and safe research import rejection.\n6. Workflow context tests ensure imported source text is passed as untrusted quoted data, not executable instructions.\n6. Research importer tests for HTTPS restrictions, private-network blocking, HTML extraction, metadata capture, size limits and unreadable pages.
5. Real CAI C2PA signing/Reader round-trip with an upstream test-only certificate, verifier trust-state and asset-integrity tests.
6. Local SQLite media transcode round-trip: signed source MP4 → FFmpeg derivative → embedded ingredient validation → post-signing SHA-256/publication metadata check (`npm run verify:provenance`).
6. Real FFmpeg rendering and output inspection.
6. Real FFmpeg/FFprobe fixture execution for denoise, color correction, resize, interpolation and scaling with invalid-parameter rejection.
6. TypeScript typecheck.
7. Production Vite build.

A green build does not prove external provider execution, cloud durability, frame-accurate playback or collaborative editing.

## Not yet production-complete

- Durable cloud database and object storage in a dedicated isolated project; PostgREST queue and private object-storage adapters plus a lease-aware worker-cycle orchestrator are implemented and contract-tested, but remain intentionally disconnected until the isolated schema is exposed, storage policies and credentials are configured, and the media/workflow data layer is cloud-compatible.
- Production OAuth/session refresh, email invitations and distributed multi-tenant collaboration. The current browser auth gate requires users to paste a Supabase access token; ordinary email/password sign-in and refresh-session UX are not yet implemented.
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


## Neural image upscaling — verification boundary

The Real-ESRGAN NCNN/Vulkan adapter is an optional, disabled-by-default worker capability. Its self-test verifies that the configured executable can run with an allowlisted model, that the model files remain unchanged during execution, and that a bounded output file is produced with the requested image container signature. This is **execution verification**, not proof that the output is perceptually better than the source.

The administrator self-test API now returns separate `executionVerified` and `inferenceVerified` fields from the engine, plus `qualityBenchmarkRequired: true`. It no longer promotes a successful process invocation to a claim of verified neural quality. No model is enabled by this change, and no remote inference or paid GPU service is activated.

The benchmark evidence gate now rejects a model's five-fixture summary if records mix the model version, executable SHA-256 or model-files SHA-256. The rule is enforced in `server/upscale-benchmark.mjs`, and regression tests cover mixed versions, weights and executable artifacts. The evidence reader therefore fails closed instead of aggregating individually valid reviews from different model builds. The human-review field names in `docs/AI-UPSCALE-QUALITY-EVIDENCE.md` now match the validator exactly. PR #268 passed the full GitHub Actions quality build and disposable PostgreSQL publication integration; PR #269 corrected the operator guide and README link.

The local benchmark runner can produce execution evidence only. It does not create human approvals. No genuine five-category reviewed dataset is configured in the hosted runtime, no neural model is enabled, and quality remains unverified until licensed fixtures are executed and independently reviewed.

Before enabling neural upscaling for general users, the release gate is a reproducible benchmark set containing licensed test images across portraits, fine textures, text, animation and low-light/noisy sources; source/output dimensions and integrity checks; 2×/3×/4× runs for each supported model; reference-based metrics where ground truth exists (PSNR/SSIM/LPIPS where available); no-reference artifact review; runtime and peak-memory measurements; and human side-by-side review. Results must be stored with model/binary hashes, hardware/runtime details and exact settings. If reference images or metric tooling are unavailable, report that limitation rather than inventing scores. Original assets must remain immutable and every result must retain derivative lineage.

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


Cloud asset authorization: `server/cloud-asset-auth.mjs` implements fail-closed project role checks against the isolated `executive_visuals` schema. Project owners and editors may write; editors, reviewers and viewers may read. Personal assets are owner-scoped by the asset repository. The authorization adapter is contract-tested and composed with storage and metadata through `server/cloud-asset-service.mjs`; the service factory is opt-in and is not wired to the live HTTP API; do not configure it with untrusted actor IDs or expose service-role credentials.


Cloud media IO: `server/cloud-media-io.mjs` provides an opt-in FFmpeg-worker boundary for materializing authorized cloud assets into isolated temporary files and publishing generated files through the cloud asset repository. It enforces download/upload size limits, validates signed download URLs as HTTPS without embedded credentials, verifies downloaded SHA-256 and byte size against metadata, rejects redirects, prefers checksum-producing streaming uploads for generated media files (with bounded buffered fallback for repositories that do not implement streaming), bounds fallback output-file reads before allocation, detects output mutation during reads, and exposes idempotent temporary-directory cleanup. The cloud storage adapter now streams regular files to the private bucket with a fixed content length, byte limit, SHA-256 receipt and mutation checks; the cloud asset repository can persist the returned receipt without buffering the entire render in memory. Contract-tested, but **not yet wired into `executeMediaJob`, timeline rendering, the HTTP asset routes, or a cloud worker deployment**. The current SQLite/local-disk execution path remains the active path.


## Cloud timeline renderer — implemented and contract-tested

The cloud timeline worker now defaults to a real FFmpeg renderer that consumes the verified temporary files supplied by the cloud media IO layer. It no longer requires an external render callback for the standard path.

- Reuses the shared FFmpeg process runner and the existing subtitle timing/style helpers; the local SQLite renderer remains unchanged.
- Renders a primary video track with still-image or video sources, black gap-fill, synchronized audio tracks, gain control, still-image overlays with bounded placement/opacity, and burned-in SRT/VTT caption clips.
- Enforces a single primary video track, non-overlapping clips, supported media types, bounded output dimensions/frame rate, no unimplemented speed changes, and a 2 MiB caption-source limit.
- Uses the cloud worker's abort signal for process cancellation, writes only inside the isolated job work directory, and returns a private MP4 master for checksum publication by the cloud timeline executor.
- CI includes a real FFmpeg/FFprobe integration test that verifies the rendered output contains both video and audio streams, plus overlap and cancellation checks.

This closes the renderer-adapter gap in the cloud timeline execution contract. It does **not** mean the cloud path is deployed or live: the isolated database migration is still unapplied, the custom schema/API exposure and credentials are not configured, and the cloud worker is not connected to the HTTP API or a running service. SQLite/local-disk rendering remains the active application path.


## Authenticated cloud timeline API — implemented, opt-in

- Added server routes for cloud timeline creation, read and optimistic-revision update, using the verified account ID supplied by the existing Supabase authentication middleware. Request bodies cannot assign or override the record owner.
- Added durable render-job submission against the isolated schema. The server reads the saved timeline and its current revision, checks project editor permission, derives the project ID from the saved record, and stores only the timeline ID/revision in the job input.
- Render submissions accept an idempotency key. A replay returns the original job only when it matches the same timeline and saved revision; conflicting reuse returns HTTP 409. The worker also verifies that the saved timeline revision still matches the queued revision before materializing assets, preventing a queued job from silently rendering later edits.
- Added role-checked job status and event-history reads. Project members with read permission can inspect shared project jobs; unrelated users cannot inspect personal jobs.
- Server-role credentials remain server-side. Database requests are bounded by a timeout and API payloads are capped at 5 MiB. Cloud API routes are disabled unless CLOUD_TIMELINE_API_ENABLED=true; startup also requires AUTH_MODE=supabase.
- Added mock-backed tests for verified ownership, revision conflicts, render enqueue, role enforcement, idempotency, job visibility and event history.

**Not yet connected:** cloud asset listing, asset-library browser UI, cloud worker deployment/activation, and cloud workflow execution. The API must remain disabled until the dedicated executive_visuals schema and private bucket policies are applied to an isolated Supabase project and verified. No migration was applied and no cloud job was submitted during implementation.

- Cloud asset ingest is streamed to an isolated temporary file, enforces the configured upload ceiling and MIME/file-signature agreement, then publishes through the private storage repository with checksum metadata. Temporary files are removed after completion or failure. The API exposes short-lived signed reads and soft deletion; original objects are not made public.
- Startup readiness checks verify the required isolated-schema tables and confirm the media bucket is private. The check runs only when the cloud API opt-in is enabled.


## Separate cloud worker process — implemented, not deployed

- Added a standalone `start:cloud-worker` entry point for separately hosted media and timeline worker families. It is independent of the web API process and does not start when imported.
- Both worker families are disabled by default and require explicit `CLOUD_WORKER_ENABLED`, `CLOUD_MEDIA_WORKER_ENABLED` and/or `CLOUD_TIMELINE_WORKER_ENABLED` flags plus server-side Supabase credentials.
- Startup checks the isolated schema and private media bucket, verifies FFmpeg/FFprobe availability, validates lease/heartbeat/poll/byte limits, and fails closed when prerequisites are missing.
- The supervisor runs supported worker cycles, recovers expired leases, reports bounded structured status/error events, and stops scheduling work during graceful shutdown.
- Tests cover disabled configuration, missing credentials/families, configuration bounds, recovery, family cycles and shutdown.

This is a runnable worker entry point, not a deployed worker. Do not set the enable flags until the isolated database migration, private bucket policies, API schema exposure and service credentials have been reviewed. No worker service was created or launched.


## Persistent creative-production linkage — 1 November 2026

- The local AI Director project now retains a stable mapping to its cloud project ID and last confirmed revision in the existing local planning state.
- Saving the same creative production updates its existing cloud project with optimistic revision checks instead of creating a duplicate project on every save.
- Existing project settings are merged before the creative-production record is updated, preserving unrelated project metadata owned by other production modules.
- The handoff includes the brief, audience, style, duration, planning blueprint, shots, character profiles and variants. The project identity remains shared with its cloud media register and timeline editor.
- If another editor has updated the cloud project, the revision check prevents a silent overwrite. Refresh the cloud workspace before retrying.
- This is a client-to-cloud project handoff, not yet a complete review/approval/delivery lifecycle. Current CI verification is pending.

## Creative brief to cloud production handoff — 1 November 2026

- The AI Director now offers an explicit action to create a private cloud project from the active creative brief.
- The handoff stores the brief, audience, style, duration, local planning blueprint, shot list, character profiles and campaign variants in the cloud project's versioned settings record. Project ownership is assigned server-side from the authenticated identity.
- The Cloud Projects view displays the saved audience, style and target duration, making the production brief visible alongside its media and timelines.
- The local planning flow remains available; this handoff does not claim the blueprint was generated by an AI provider. No provider request is made.
- Cloud handoff requires the opt-in cloud API and appropriate project configuration. Verification is pending current CI.

## Private cloud asset preview and download — 1 November 2026

- The Cloud Projects asset register now requests a short-lived signed URL from the authenticated asset route only when the user asks to open an asset.
- The UI exposes an open/download link after the server has verified ownership or project read permission. The underlying bucket remains private; no public object URL is introduced.
- Signed URLs are held in transient browser memory, not persisted with workspace drafts, and are cleared when switching projects. The link lifetime is five minutes; users can request a fresh one.
- This is a link-based preview/download path. It does not yet provide inline video playback, image thumbnails, or a cloud asset preview modal. Verification is pending current CI.

## Shared local/cloud editorial editor — 1 November 2026

- The existing multi-track timeline editor now has a workspace selector for local storage or an authorized cloud project. The editor loads the selected project's private cloud assets and saved timelines through the authenticated cloud API; no separate cloud-only editor is introduced.
- Cloud timelines can be created from the editor, selected from the saved-sequence control, edited using the existing clip/track/marker tools, and saved using optimistic cloud revision checks. The local SQLite timeline path remains unchanged.
- Cloud master renders are submitted as durable, idempotent `timeline.render` jobs. The editor retains the returned job ID and exposes a manual status refresh for queued/processing/succeeded/failed states; a successful refresh reloads the project's asset register.
- The cloud renderer and worker composition are implemented and tested, but cloud use still requires the isolated schema, private bucket, Supabase auth/API configuration and a running worker. The UI integration does not activate these services or imply cloud rendering is live.
- Verification of this editor integration is pending the current branch CI run.

## Cloud workspace consolidation — 1 November 2026

- Added a server-side cloud project repository with owner/member-aware listing, project creation, role-authorized reads and writes, optimistic revision checks, and soft archival.
- Added paginated cloud asset listing for personal and project scopes. Asset listing reuses the same authorization boundary as private uploads, signed reads, timeline materialization and deletion.
- Exposed authenticated API routes for cloud project create/list/read/update/archive and cloud asset list/read/upload/delete. Ownership is always taken from the verified auth middleware; clients cannot assign project or asset ownership.
- Added cloud project repository tests, cloud asset listing tests and API integration tests. Cloud verification includes the new project repository test suite.
- Added a Cloud Projects workspace in the browser app: create/select projects, upload source media, browse the private project asset register, and create/list project timelines. The workspace uses the existing authenticated API client and remains unavailable until the opt-in Supabase cloud API is correctly configured.
- These endpoints and UI are code-complete but remain opt-in. The isolated Supabase migration and private bucket must be applied and verified before use; no migration, cloud environment, worker or production service was activated as part of this change.

## Latest continuation — reference-conditioned video workflow

- The video-generation workflow now accepts an accessible image asset on its typed `Start Frame` input.
- Before any provider request, the executor verifies the asset is owner-accessible, remains within the media root, is no larger than 10 MiB, matches its recorded byte size and SHA-256 checksum, and has a valid JPEG, PNG or WebP signature.
- The image is converted to a data URL for the configured server-side video model. No public asset URL or browser-visible credential is required.
- The adapter sends a reference image only when `FAL_VIDEO_IMAGE_INPUT_FIELD` explicitly selects an allowed model input field. The selected field must match the configured model's documented contract; unsupported/missing configuration fails closed.
- Workflow validation now permits image/media assets to connect to the `Start Frame` port in both the browser planner and server validator.
- The inspector explains the model-specific configuration. Added payload validation, mock-provider submission tests, and workflow port-compatibility coverage.
- GitHub Actions run 1393 passed dependency installation, TypeScript typecheck and the full build/verification suite on 1 November 2026. No live provider request or paid generation was made.
- Remaining boundary: the provider model's actual input field must be configured correctly, and live model execution still requires a separate approved staging test. This change does not claim cloud-worker or production deployment readiness.


## Latest continuation — reference-conditioned image workflow

- The image-generation node now accepts one optional private image reference, so a source frame or visual guide can inform both image and video workflows in the same graph.
- Before provider dispatch, the executor checks asset ownership, path confinement within the media root, the 10 MiB limit, recorded byte size, SHA-256 and JPEG/PNG/WebP file signatures.
- The image adapter sends the reference only when `FAL_IMAGE_REFERENCE_FIELD` explicitly selects a supported field documented by the exact configured model. Missing or invalid configuration fails closed; unsupported providers do not silently ignore the reference.
- The workflow canvas exposes the typed Reference input. Mock-provider tests verify configured field submission and failure when the field is absent or invalid.
- No live provider request, paid generation, cloud activation or production database change was made for this feature.
- The configured model's real reference-input contract still requires review and an approved staging smoke test before enabling remote generation.


## Workflow integration fix — asset-to-image reference wiring

- The visual editor's Reference Asset node emits typed `asset` and `media` ports, while image generation consumes a typed `image` reference port. The frontend and backend validators now explicitly allow those asset/media outputs to connect to that image-reference input.
- Added workflow-engine validation coverage for this exact graph connection, preventing the editor from presenting a reference-image feature that its graph validator would reject.
- This is a local workflow validation change; it does not enable remote providers or perform paid generation.

## Remote AI usage guardrail — 1 November 2026

- Remote text, image, video, speech-synthesis and transcription workflow nodes reserve an account-level request slot **before** dispatching to the provider. Local providers do not consume this remote allowance.
- The default limit is 50 remote requests per account in a rolling 24-hour window. Configure `REMOTE_AI_DAILY_REQUEST_LIMIT` from 0 to 10,000; setting it to 0 blocks remote AI execution. Invalid values fail closed for remote requests.
- Reservations are recorded atomically in the local SQLite database so overlapping jobs cannot both consume the final slot. Failed provider calls remain counted for the window, a conservative choice that prevents retries from bypassing the guardrail.
- The limit is a request-count safety cap, not a money estimate: providers may price requests differently, and the existing usage ledger still does not estimate provider costs. Review provider pricing before enabling remote endpoints.
- Added unit tests for the cap, local-provider exemption, disabled remote execution and invalid configuration. This does not enable remote calls, make live provider requests, activate cloud services, apply migrations or change production.

### Usage guardrail visibility — 1 November 2026

- The authenticated `/api/usage` response now includes the account's rolling 24-hour remote request count, configured limit, remaining allowance, configuration validity and whether a zero limit disables remote execution.
- Usage counts are based on pre-dispatch reservation records, so a failed remote call remains visible and counted until it ages out of the window. Optional project usage is reported separately without changing the account-wide cap.
- The existing runtime console now displays the allowance alongside project, asset and job operations. Invalid limit configuration is surfaced as blocked rather than silently shown as zero remaining.
- Added an API regression test covering authentication, configured limit reporting, empty-account allowance and secret-safe output. Monetary costs remain explicitly unestimated.


## Blocked-workflow lease recovery — 1 November 2026

- Queue recovery now reads the associated workflow-run state before rescheduling a job whose worker lease expired.
- If the workflow run is already `blocked`, recovery preserves that decision: the queue job becomes terminal `blocked`, its lease and retry schedule are cleared, and a `job.blocked` event is recorded.
- Other expired jobs retain the existing bounded retry and terminal-failure behavior.
- Added a regression to `scripts/verify-queue-leases.mjs` covering the blocked workflow, terminal queue state, cleared schedule, error code and event history.
- GitHub Actions run 1421 passed dependency installation, TypeScript typecheck and the full verification/build pipeline on commit `b6d864407f88347f577ea5c580a3d001da3785ac`.
- This is a local queue reliability change; it does not enable remote providers, cloud services, deployment or production database changes.


## Character and scene continuity records — 1 November 2026

- Project creative-workspace documents now preserve structured character continuity fields: appearance, wardrobe, voice profile, continuity notes and reference asset IDs, alongside existing consent scope/evidence/expiry.
- Shot records now preserve character links, location, time of day, visual prompt, continuity-in/out notes, reference asset IDs and aspect ratio, alongside camera/lens/movement/lighting/duration.
- Lists are deduplicated and bounded; strings are length-limited by the server-side workspace sanitizer. Existing project revision conflict protection and owner/editor write authorization remain in force.
- API regression coverage verifies that these fields survive persistence and reload. These records establish a durable continuity foundation; automatic reference-frame selection and model-specific conditioning still require the corresponding generation adapters and explicit model field configuration.


## Shot continuity applied to generation — 1 November 2026

- Image and video workflow nodes can select a saved project shot by setting `shotId` in node configuration. The workflow inspector documents this option.
- The executor loads the saved project workspace on the server and combines the original prompt with the selected shot's scene, action, location, time of day, visual direction, camera, lens, movement, lighting, aspect ratio and continuity notes.
- Only explicitly linked characters are included. Missing or duplicate shot or character IDs fail closed. Every linked character must pass the existing authorization check for image likeness or video face-animation use before continuity details are sent to a provider.
- Reference asset IDs are not automatically attached. The existing path still requires a separately connected, owner-accessible, checksum-verified single image and a model-specific input field explicitly configured on the server.
- Prompt-builder tests cover context construction, missing and ambiguous links, empty prompts and per-character authorization. This feature does not make provider calls by itself, bypass approval gates, enable remote generation or change production data.


## Saved reference-image continuity — 1 November 2026

- Shot and linked-character reference asset IDs are now resolved from the selected saved project shot when an image or video generation node uses `shotId`.
- A connected reference asset explicitly selected in the workflow takes precedence. Otherwise, the executor considers only references attached to the selected shot and its linked characters.
- Automatic selection is deliberately limited to exactly one distinct reference. Multiple candidates fail closed and ask the editor to connect the intended asset explicitly; unrelated character references are not included.
- The selected identifier must resolve to an owner/project-accessible image asset before the existing generation adapter validates its storage path, byte size, SHA-256 checksum and JPEG/PNG/WebP signature.
- The model-specific reference input field remains an explicit server configuration. If the model has not been configured to accept reference images, the gateway continues to fail closed rather than silently ignoring the reference.
- Tests cover deterministic reference collection, deduplication, ignoring unlinked characters and missing/ambiguous shots. No provider request, paid generation, production data change or deployment was performed.


## Pre-delivery timeline quality checks — 1 November 2026

- Added a sequence-health panel to the existing editorial workspace. It checks for missing primary picture, gaps in the first enabled video track, missing audio, missing captions, empty overlay tracks, source assets absent from the currently loaded library, clip source ranges exceeding probed media duration, and review markers beyond the edit.
- Findings are severity-labelled as errors, warnings or information. The panel gives editors concrete issue descriptions before master export.
- These checks are advisory except for missing picture, missing source assets and source ranges exceeding known media duration. The existing server-side timeline validator and render path remain authoritative; the client panel cannot authorize or bypass rendering.
- This adds no provider calls, paid services, production migrations or deployment.


## Upscaling benchmark evidence contract — 2 November 2026

- Added `server/upscale-benchmark.mjs` to validate reproducible benchmark records: fixture/model identity, executable/model/input/output SHA-256 digests, input/output dimensions, scale, elapsed time, execution status, review state and optional non-negative PSNR/SSIM/LPIPS values.
- Added a summary that reports execution results separately from quality review. A successful process is not quality-verified; quality verification remains false until every included record is valid, successfully executed and human-reviewed as passing.
- Added automated tests for invalid hashes, unsupported scales, malformed records, failed execution, pending review and rejected visual review.
- Added the benchmark contract tests to the normal build verification pipeline. These tests require no GPU, large model download, external provider or paid service.
- This is the auditable report contract and gate, not a claim that an image benchmark has already been run. A real fixture corpus and actual model outputs still need to be collected and reviewed before quality can be verified.


## Upscaling benchmark coverage gate — 2 November 2026

- Benchmark records now require a controlled fixture category: portrait, fine texture, text, animation, or low-light/noisy footage.
- The summary reports category coverage and missing categories. It will not set `qualityVerified` unless every required category has at least one successful, human-reviewed passing fixture, all submitted records are valid, and no record failed execution or review.
- This is a stricter evidence gate, not evidence that any real model has passed. The actual licensed fixture corpus, pinned model/binary runs, reference metrics and human side-by-side review are still outstanding. Empty or incomplete evidence remains unverified.
- No model was downloaded or activated; no remote GPU/provider, paid service, production database, storage bucket, Render service or deployment was changed.


## Upscale benchmark integrity checks — 2 November 2026

- Successful benchmark records must have output dimensions exactly equal to input dimensions multiplied by the declared 2×, 3×, or 4× factor.
- Fixture IDs must be unique in a summary so duplicated evidence cannot inflate category coverage.
- SSIM values above 1 are rejected as invalid evidence.
- Automated tests cover dimension mismatch, duplicate fixture IDs, and invalid SSIM. These checks validate evidence structure only; they do not replace actual inference, reference-based metrics, or human review.


## Benchmark schema hardening — 2 November 2026

- Input/output pixel dimensions must be positive integers, not fractional values.
- SSIM is constrained to [0, 1]. PSNR and LPIPS must be finite, non-negative values; no universal upper bound is assumed for LPIPS.
- Malformed summary input now fails closed as an empty, unverified report rather than throwing.
- Added tests for fractional dimensions, metric bounds, optional metrics and malformed summary inputs.
- These are schema and safety checks only. They do not indicate that the required fixture set has been run or that any upscaling model has passed perceptual review.


## AI Transformation Studio foundation — 2 November 2026

- Added a provider-neutral transformation request contract for vehicle, wardrobe, object, background/scene, person, style, object-removal and relighting edits to existing video.
- Added validation for video source identity/type, optional SHA-256, 1–30 second draft clips, up to four unique reference asset IDs, allowed preservation constraints, source/reference rights confirmation and explicit subject consent for person replacement.
- Added fail-closed adapter capability checks for supported operations, duration, reference count and requested preservation behavior. Added immutable request provenance hashing.
- Registered five transformation capabilities in the typed capability atlas and machine-readable catalog; all are marked adapter-required, not provider-ready.
- Added focused regression tests and a dedicated Transformation Studio design/release document. Corrected the existing audio-recipe test so it no longer expects unsupported parameters to be silently ignored.
- **Not yet implemented:** provider execution, UI submission, private-media ingestion for remote adapters, asynchronous transform jobs, cost estimation, result download/ingestion, visual QA and production deployment. No paid provider was activated and no media was submitted.


## Resumable video transformation and finishing pipeline — 2 November 2026

- Added `server/video-finishing-pipeline.mjs`, a provider-neutral orchestrator for ordered transformation, upscale, frame-rate, HDR, audio finishing and transcode steps.
- The full plan is validated before execution: every step must declare a unique ID, kind, adapter, exact capability, remote/local status and known non-negative cost estimate. Remote execution requires a durable approval ID and a budget covering the entire plan.
- Each step must resolve to an enabled adapter that declares the exact requested capability and matching remote/local mode. Outputs must be new video derivatives with valid SHA-256 receipts and immediate-parent lineage.
- Successful steps are checkpointed with deterministic idempotency keys bound to pipeline ID, step ID, input asset checksum and settings. A resumed pipeline reuses successful matching checkpoints; stale or conflicting checkpoints fail closed.
- Added tests for approval and budget preflight, unknown costs, adapter readiness, output lineage, deterministic resume and checkpoint conflict. Added the tests to the standard build and registered the finishing pipeline in the typed capability atlas and JSON catalogue.
- **Still outstanding:** durable database-backed checkpoint implementation, adapter-specific video-to-video execution, secure provider upload/download, real cost quotes, worker wiring, UI progress/review and actual visual-quality validation. The orchestrator itself makes no provider calls and spends no credits.


## Transformation Studio draft workspace — 2 November 2026

- Added an Enhancement Lab draft form backed by private cloud project assets. Users can choose a video source, one of eight transformation families, a target description, detailed prompt, clip duration, up to four image reference assets and per-shot preservation constraints.
- The draft form verifies references against image assets already loaded from the selected private cloud project. It requires source/reference rights confirmation and additionally requires explicit subject consent for person replacement.
- Drafts are stored in browser planning state, included in the project JSON export and visibly labelled as not submitted. No API job submission, provider request or credit spend is wired to this form.
- The next UI milestone is to replace browser-only drafts with durable, permission-checked server records and connect them to the approved asynchronous pipeline.


## Durable video pipeline checkpoints — 2 November 2026

- Added a local SQLite checkpoint table and `createSqliteVideoPipelineCheckpointStore` adapter for the finishing orchestrator.
- Checkpoints are scoped to authenticated owner and project, with unique pipeline/step identity, source asset ID/checksum, deterministic idempotency key, immutable output receipt and approval reference.
- Writes use insert-once semantics. Identical retries are idempotent; a different receipt for an already completed step is rejected instead of overwriting history.
- Store construction checks project ownership by default and supports an explicit server-side authorization callback for authorized project members. The store never accepts a client-supplied storage path.
- Added tests for durable reload, user/project isolation, editor authorization callback, idempotent retries, conflicting receipts and malformed checksums.
- **Still outstanding:** authenticated API routes that create and retrieve pipeline plans, worker integration that constructs the checkpoint store after permission checks, cloud DB migration, real adapter execution and UI polling/review. The browser draft form remains planning-only.


## AI Transformation Studio — current milestone

- Added authenticated cloud API persistence using the existing private `jobs` table, with project owner/editor checks, source-video and same-project image-reference validation, idempotent draft creation, rights checks and person-replacement consent attestation.
- Connected the Enhancement Lab to cloud draft create/list routes. Prompts and reference IDs are excluded from browser local storage; legacy local transformation drafts are purged on startup.
- Added separate owner/editor budget approval metadata (estimate, covering budget, currency, adapter/capability declaration) and audit/job events. The local SQLite plan API remains available for development.
- Submission remains intentionally blocked with an explicit adapter-unavailable response. The checkbox is not independent proof of person consent; evidence-backed consent verification is still required before person replacement can execute. No provider generation, credit spend, cloud migration or deployment has occurred.


## New implementation slice — asset provenance (PR #235)

**Status:** merged into `main` via PR #235 (squash commit `e0d379c157fd686d0f9a3c50213c02648c384bbd`). GitHub Quality checks passed on the exact reviewed PR head `68348abf04e4b7f5178c0adb5ca6c0243369e035` before merge; no production deployment was performed.

- New uploads receive a canonical SHA-256 application provenance record bound to asset ID, content hash, media type, byte size, source kind and ingest timestamp.
- The record is persisted with the existing asset metadata and its hash is included in the upload audit event.
- Authenticated `GET /api/assets/:assetId/provenance` verifies record integrity and asset-row binding through the existing asset authorization boundary.
- Legacy assets without a record return `not_available`, not a false pass.
- API integration tests cover successful verification and cross-account denial.
- Unit tests cover deterministic records, tampering, checksum mismatch, malformed inputs and missing records.
- The verifier explicitly returns `c2pa: not_checked`. This feature is not C2PA, a signature, identity proof, rights clearance or factual verification.
- Full build includes `verify:provenance`; the broader server suite includes the API authorization integration test.

**Next:** add the supported CAI C2PA SDK as a separate adapter after dependency review, certificate/trust policy design and supported-format tests. Do not claim signing/validation until real signed fixtures pass.


## C2PA provenance milestone — visible app evidence and expanded streaming test

- Added a dedicated **Manage → Trust & provenance** workspace to the browser app. It lists nine implemented/tested stages and five open release gates, with direct links to PR #249, the successful CI run, and the Asset Library inspection flow.
- The page distinguishes completed code/test evidence from release approval. It explicitly states that the callback signer is not a connected KMS/HSM, the AI-upscale executor fixture is not Real-ESRGAN inference, and no staging signer/deployment has been provisioned.
- Expanded cancellation/recovery verification with a 96 MiB streaming preservation test. The fake signer copies the file without whole-file buffering; the preserver hashes source/output streams, validates the embedded ingredient and confirms the final output hash. This is a large-file stress point, not a substitute for a measured near-limit throughput/memory run.
- The Asset Library continues to expose per-asset Content Credentials inspection for images, audio and video.
- Next independent gates remain: actual Real-ESRGAN inference, near-limit throughput/memory and additional codec/container coverage, a concrete provider-specific KMS/HSM adapter with protected key controls, independent browser acceptance, and isolated staging sign-off with a dedicated non-production signer.
- Safety boundary unchanged: no production or staging keys, paid provider calls, shared migrations, deployment or merge.


## Expanded C2PA format coverage — verified in CI run #8479

- Cross-checked the application's media upload allowlist with the current CAI supported-format documentation.
- Extended the real CAI SDK round-trip matrix from six to nine formats by adding GIF, QuickTime MOV and M4A, alongside JPEG, PNG, WebP, MP3, WAV and MP4. All nine real SDK round-trips passed.
- WebM, Matroska/MKV and Ogg remain accepted ingest formats but are not listed in the current CAI core supported-format table. Do not claim C2PA preservation for those formats; credential-bearing transformations remain fail-closed until an SDK-supported path is demonstrated.
- The previous revision passed 36/36 provenance tests and 457/457 regression tests in CI run #8473. The nine-format expansion passed CI run #8479: 39/39 provenance tests and 460/460 full regression tests passed, alongside typecheck, full build and disposable PostgreSQL publication integration.


## User-facing account and workspace identity — implementation in progress

- Added a persistent signed-in identity chip to the top bar and account identity in the sidebar footer.
- Added an account summary panel to the Overview dashboard showing authenticated email, auth mode, active project and project role; includes account-console navigation and sign-out.
- Identity is sourced from the authenticated `/api/me` response and selected project membership. No session token or internal account identifier is rendered.
- Added responsive mobile treatment and accessible control labels.
- The merged C2PA/provenance release is already live on the existing `EXECUTIVE-VISUALS` Render service at commit `a7643b9`; this account-display increment is on `feat/user-facing-account-dashboard` and is not yet deployed pending CI and review.
- Important platform limitation remains: the live service is on the free plan with no attached persistent disk and no Render Postgres instance. Its storage durability is not certified for customer-critical projects. Do not imply that the current app has durable cloud media storage.


### Project member display

- Runtime Console now renders the project member list and role badges from the authenticated members API.
- Owner-only controls add an existing account by email and remove a project member. The UI explicitly states that the person must already have an account and that adding them does not send an email invitation.
- Non-owners see the current role and a read-only membership list; the API continues to enforce owner-only membership changes.
