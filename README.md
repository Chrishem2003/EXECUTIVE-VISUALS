# Current release status — 18 November 2026

GitHub `main` now includes the verified 17 November production-editor and media-reliability batch through PR #696, merge commit `f5131d1b6635cc995a2b6202a3c38db3659c575c`. Merged work includes: PR #691 bounded cleanup of abandoned B2 multipart sessions (worker disabled by default); PR #692 bounded browser part-upload retries with fresh signed URLs; PR #693 eight validated directional wipe/slide transitions in local/cloud FFmpeg rendering; PR #694 accurate browser preview composition for those transitions; PR #695 live storyboard-to-timeline attachment status; and PR #696 validated attachment of authorized, probed project videos to exact storyboard shots as editable clips with lineage and undo/history support.

These merges improve the editor and upload code paths; they do **not** change the public-release decision. Cloud storage, B2 and remote provider execution remain fail-closed until their separate operator configuration and live acceptance gates pass. In particular, issue #663 still requires protected `SUPABASE_SERVICE_ROLE_KEY` configuration on the dedicated cloud-staging service and successful isolated staging acceptance for auth, private media, project isolation, timeline persistence, durable queue/worker recovery and the complete creative-production journey. Do not request or commit the secret in chat or source control.

The production runtime is still not approved for customer uploads or public launch until durable hosted persistence, isolated identity/database configuration, private object storage, worker recovery, backup/restore, billing acceptance and operational monitoring are verified. Preserve production and shared NEMA/platform resources; do not repair shared Supabase migration history or apply this repository's migrations to a shared/production database. See [P0 cloud staging and end-to-end pipeline acceptance](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/issues/663) and [Public release gates](docs/PUBLIC-RELEASE-GATES.md).

---


GitHub `main` is at `563e2d0fe8642449ac4dc222cff666da8f5a4ab7`. PR #685 adds bounded-memory incremental SHA-256 for the B2 multipart upload client: source files and each part are hashed in 8 MiB slices rather than loading the entire media file into one ArrayBuffer. The B2 workflow itself remains fail-closed and is not activated by this checksum improvement.

Render production deployment `dep-dbua35fb9u1s73a9rmqg` and the separate `executive-visuals-cloud-staging` deployment `dep-dbua35fb9u1s73a9rmag` both completed successfully on this commit. The API process started and Render marked both services live. Both remain Free preview/testing services, not a public-ready hosted production system.

**Public release remains NOT APPROVED.** The production API still uses SQLite/local-disk persistence, and the Render Free filesystem is ephemeral. Do not accept customer uploads or claim durable customer storage on the current production service. The new B2 workflow is not available to customers until the additive Supabase migration is applied to an isolated Executive Visuals database, a private B2 bucket and exact-origin CORS are configured, and end-to-end upload/resume/authorization/revocation/recovery acceptance passes.

PR #685 passed all 30 exact-head checks before merge. The merge commit's mainline checks are still running; at the latest read, 17 had succeeded, 3 were in progress, 7 queued, one was skipped, and the only failure was Supabase Preview. Build and deploy checks for Render and the Cloudflare workflow completed; the Cloudflare production Worker deploy step was skipped because `CLOUDFLARE_API_TOKEN` is not configured, so no Cloudflare production Worker or static assets were changed. Supabase Preview reports: `Remote migration versions not found in local migrations directory.` A read-only comparison found that the connected shared staging database has 96 migration records, only 4 exact filename-version matches, 81 same-name migrations with different timestamps, and 11 remote-only migration names (including NEMA/shared-AI and API-schema changes). Do not repair this by resetting or rewriting the shared migration history, or by applying migrations to a shared/production database. See [Public release gates](docs/PUBLIC-RELEASE-GATES.md).

The Cloudflare D1 workspace remains an isolated metadata/workspace staging path, not production persistence or large-media storage. The GCS mirror is in main but remains deliberately inactive: no real GCS bucket, WIF identity/IAM or live upload/read-back acceptance has been configured. `google-auth-library@11.3.4` is already declared and locked; dependency resolution is no longer the outstanding GCS blocker. See [Public release gates](docs/PUBLIC-RELEASE-GATES.md).

Paddle is the primary and Pesapal the secondary billing provider. Merchant sandbox acceptance and production webhook verification remain outstanding; Pesapal automatic recurring billing is not implemented. Keep live checkout and paid remote generation disabled until their respective isolated infrastructure, approval, budget and billing gates pass.

The latest Render build emits a 632.50 kB JavaScript entry bundle (170.25 kB gzip), a 126.96 kB CSS bundle (24.97 kB gzip), and a 238.67 kB timeline workspace chunk. The JavaScript entry still exceeds Vite's 500 kB warning threshold. Further lazy-loading and route/workspace modularization remain the next frontend performance milestone, not a substitute for release gates.

---

## Storage persistence and deployment checks

See [Storage persistence status and deployment truth](docs/STORAGE-PERSISTENCE-TRUTH.md). Configure an operator-confirmed volume only after verifying the host mount, and test backup/restore separately.

# CHRISHEM EXCLUSIVE VISUALS

**One integrated visual-production system — from creative brief to reviewed deliverable.**

CHRISHEM EXCLUSIVE VISUALS is a provider-neutral platform for creative planning, media ingest, graph workflows, local processing, editing, enhancement, localization, review and campaign production. The implementation is original and based on publicly observable product behavior and public developer documentation.

## Isolated staging update — 15 November 2026

The Cloudflare D1 staging foundation is already provisioned and has passed its isolated live acceptance workflow (PR #499). The existing `executive-visuals-staging` D1 database records migration `0001_initial.sql`; read-only checks confirm SQLite integrity, no foreign-key violations, complete project workspace documents and no orphaned assets/jobs. The staging Worker and Render staging deployment are present. This is **metadata/workspace staging only**: R2 is disabled, assets are not durably stored in object storage, and the staging-only local-auth allowlist must never be enabled in production.

Do not create a third Supabase Free project or repurpose the two existing Chrishem Autos projects. Supabase Free allows two projects across organizations where the account is an owner/admin, and both existing projects are active. Cloudflare D1/Workers Free can support limited metadata staging (D1: 5M rows read/day, 100K rows written/day, 5 GB total; Workers: 100K requests/day, 10 ms CPU/request), but it is not a video-rendering runtime. No D1 data/schema, R2, billing setting, card or production service was changed during this review. See [Public release gates](docs/PUBLIC-RELEASE-GATES.md).

## Workspaces
- Creative direction, research, briefs, scripts and storyboards. The AI Director now includes a deterministic Creative DNA compiler for audience promise, emotional journey, hook angles, visual grammar, sound identity, proof checks and platform cut planning.
- Workflow canvas, typed media ports, server-side validation and targeted run planning.
- Multi-track editorial timeline with frame-based trims, splits, clip movement, review markers, interchange export and local MP4 master rendering (H.264 video, synchronized AAC audio, still-image overlays and burned-in SRT/VTT captions). One-click independent variants preserve the original and provide structural comparisons for clip, timing, source-trim, marker and creative-intent changes.
- Intent-linked editing: clips can record the story beat, audience promise, purpose and proof reference they serve; a bounded, timestamped decision ledger preserves creative direction changes.
- Character, voice, identity, wardrobe and consent records.
- Cinematic shot planning and continuity.
- Image and video production planning.
- Voice, transcription, translation and localization.
- Media enhancement, repair and derivatives.
- Campaign and multi-format production.
- Asset library, provenance and version lineage.
- Project collaboration with owner, editor, reviewer and viewer roles.
- Timecoded review comments, approvals and change requests.
- Operations, capability readiness and audit history.

## AI upscaling integrity and quality gate

The local Real-ESRGAN NCNN adapter validates source image dimensions, enforces safe pixel limits, checks output image signatures and requires exact 2×/3×/4× output dimensions. It refuses to overwrite source/output files and keeps execution self-tests separate from visual-quality approval.

Visual quality is not marked verified until representative portrait, fine-texture, text/graphics, animation and low-light/noisy fixtures have valid provenance-pinned benchmark records and independent human review. See [AI upscaling integrity and quality gate](docs/AI-UPSCALE-QUALITY-EVIDENCE.md).

AI upscaling remains fail-closed unless the executable, allowlisted model weights and explicit worker enablement are configured. No paid inference provider is enabled by default.

The Enhancement Lab exposes a read-only, per-model readiness summary for the general-purpose and anime presets, separating installation, execution self-tests and reviewed quality evidence. Presets remain disabled until the server confirms the model-specific quality gate; the panel does not run inference or incur provider charges. The Asset Library exposes the actual 2×/3×/4× actions only when that same server-side gate passes, and stores each result as a separate derivative with source lineage.

## Runtime milestone
The application now includes a local API service with:
- Local account registration and sign-in for development.
- User-owned projects, project-scoped creative workspace documents and optimistic revision checks.
- Binary media uploads to local disk with SHA-256 integrity metadata.
- Asset ownership isolation and original/derivative relationships.
- Persistent workflow records and an observable job/event queue with renewable leases, stale-worker recovery, bounded retries, backoff and cross-process cancellation polling.
- A local FFmpeg media adapter for probe, thumbnail, transcode, audio extraction, proxy generation and master-timeline rendering with synchronized audio, still-image overlays and burned-in captions when FFmpeg/FFprobe are installed.
- Explicit rejection of unimplemented image/video/speech generation; no fake success. A server-side text gateway is available but disabled by default, requires a completed upstream human-approval node, and requires explicit remote-access opt-in for non-local endpoints.
- Audit events, idempotency keys, upload limits, secure cookies, restrictive content security policy and server-side credential boundaries.
- Persistent creative briefs, shot lists, characters, scripts and variants stored per project with optimistic revision conflicts.
- Searchable capability atlas with 110 definitions across 23 domains.

The browser and API run together in development. SQLite and media files are stored under `data/`, which is ignored by Git. Back up that folder if you need to preserve local work.

## Run locally
```bash
npm install
npm run dev
```
Open the Vite URL (normally http://localhost:5173). The API health endpoint is http://127.0.0.1:4179/api/health.

For media processing, install FFmpeg and FFprobe and ensure both executables are available on PATH.

## Verify
```bash
npm run typecheck
npm run build
npm run verify:server
npm run verify:provenance
```

## Production boundary
Production mode refuses local-password authentication. Configure a trusted identity provider, persistent storage, HTTPS, rate limits and deployment-specific security controls before exposing the service. Do not attach this project to another product's database. A dedicated database migration is included for review but is not automatically applied.

Actual image/video generation, speech/dubbing, timeline preview playback, transitions, effects, animated/video overlays, multi-host cloud storage, live collaboration and publishing are not considered complete until their adapters and end-to-end tests pass. The text gateway records usage but does not calculate provider pricing; verify cost before enabling a remote/billable endpoint.


## Staging deployment

A Docker-based Render Blueprint is provided in `render.yaml`. It uses a private 1 GB persistent disk mounted at `/var/data`; the API refuses to start when the required mount is absent, preventing accidental use of an ephemeral filesystem. The staging blueprint requires Supabase authentication (SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured as Render secrets) and one worker process. The runtime currently accepts a Supabase access token in its sign-in gate; a polished email/password and refresh-session flow remains a release blocker. Its lease-based queue supports multiple processes only when they share the same SQLite database and media volume. Do not deploy this blueprint on the free ephemeral plan for user data. Review the monthly compute and disk charge before creating the service.


## Research and implementation records
- [Product North Star and Master Build Plan (2026)](docs/PRODUCT-NORTH-STAR-AND-MASTER-BUILD-PLAN-2026.md) — canonical competitive discoveries, original feature strategy, domain model, phased backlog and acceptance evidence.

- [Asset provenance and Content Credentials](docs/ASSET-PROVENANCE-AND-CONTENT-CREDENTIALS.md) — upload-bound integrity records, verification API and the separate C2PA integration path.
- [AI Upscale Quality Evidence](docs/AI-UPSCALE-QUALITY-EVIDENCE.md) — model-specific execution/quality gates and the offline reviewed-benchmark evidence contract.
- The local AI upscaler pins source-file identity and metadata across inference and rejects/deletes derivatives if the source changes mid-job.
- [Protected C2PA signer architecture](docs/C2PA-PROTECTED-SIGNER-ARCHITECTURE.md) — callback-based KMS/HSM boundary, key isolation, audit controls and release gates.


- [Public release gates](docs/PUBLIC-RELEASE-GATES.md)
- [Product integration and scale plan](docs/PRODUCT-INTEGRATION-AND-SCALE-PLAN.md)
- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Cross-ecosystem capability expansion](docs/CROSS-ECOSYSTEM-CAPABILITY-EXPANSION.md)
- [Expanded capability atlas](docs/EXPANDED-CAPABILITY-ATLAS.md)
- [Additional workflow research](docs/ADDITIONAL-WORKFLOW-RESEARCH.md)
- [Adapter contract](docs/ADAPTER-CONTRACT.md)
- [Original creative intelligence and innovation atlas](docs/ORIGINAL-CREATIVE-INTELLIGENCE-AND-INNOVATION-ATLAS.md)


## Content Credentials and asset provenance

Application-level SHA-256 provenance records are created for uploads. An authenticated `GET /api/assets/:assetId/c2pa` endpoint inspects embedded C2PA manifests with the pinned official CAI Node SDK, distinguishes trusted, valid-but-untrusted, invalid and absent credentials, and checks the stored asset checksum before and after parsing. This is not a signing service or rights/factual-accuracy verification. See `docs/ASSET-PROVENANCE-AND-CONTENT-CREDENTIALS.md`. Signer-injected C2PA transformation preservation now covers cloud media, local SQLite media and local/cloud timeline rendering. Multi-source timelines carry each credential-bearing source as an ingredient; outputs are re-hashed after signing and are not published if any known source credential cannot be preserved. No production signer is configured, so C2PA-bearing transformations remain blocked until an approved signer and trust policy are supplied. Run `npm run verify:provenance` to exercise the real CAI SDK verifier/signing fixture and local SQLite media transcode round-trip; the latter requires FFmpeg and FFprobe. The fixture key is public test-only material and must never be used for real assets. See `docs/ASSET-PROVENANCE-AND-CONTENT-CREDENTIALS.md`.


### Trust & provenance workspace

Open **Manage → Trust & provenance** in the app to see the completed Content Credentials stages, their verification evidence and the remaining release gates. The page links directly to the Asset Library inspection flow and the PR/CI evidence. It deliberately separates completed implementation from production sign-off; no KMS/HSM, neural model, or staging gate is marked complete without its own evidence.


The current app upload allowlist overlaps the CAI core format list for nine image/audio/video formats: JPEG, PNG, WebP, GIF, MP3, WAV, M4A, MP4 and MOV. WebM, MKV and OGG are ingestable by the app but are not listed in the current CAI core supported-format table, so do not assume C2PA signing/preservation support for them. The format round-trip matrix verifies the nine overlapping formats. The recovery suite also includes a 96 MiB streaming preservation stress point; near-limit memory/throughput certification remains a separate release gate.

Open **Manage → Trust & provenance** in the app for the implementation ledger, test evidence and remaining release gates. Open **Manage → Asset library** to inspect Content Credentials on individual image, audio and video assets.


## Signed-in account display

The application shell now surfaces the authenticated account in the persistent top bar and sidebar. The overview dashboard also shows the signed-in email, authentication mode, active project and project role, with direct access to the account/runtime console and sign-out. The display is populated from the authenticated `/api/me` response and the currently selected project membership; it does not expose internal account IDs or session tokens. On narrow screens the top-bar identity collapses to an accessible avatar control to preserve workspace space.


Project collaboration in the Runtime Console now includes a visible member list, each member's access role and owner-only add/remove controls. Adding a member requires an existing account in the workspace; the UI explicitly states that it does not send an email invitation. Editor, reviewer and viewer roles remain enforced by the API.


The in-app **Release readiness** workspace provides the current merged/in-progress/blocked inventory. See [Full-System Release Readiness](docs/FULL-SYSTEM-RELEASE-READINESS.md) and [Persistence and Release Blockers](docs/PERSISTENCE-AND-RELEASE-BLOCKERS.md) for detailed dependencies and infrastructure requirements.


### AI upscaling worker memory recovery

When NCNN tile size is left on automatic, recognized GPU-memory allocation failures trigger bounded retries with smaller tiles (256 → 192 → 128 → 96 → 64 → 32). Explicit tile settings are preserved. Failed partial outputs are removed, and successful fallback attempts are recorded in derivative processing metadata for review. See [AI upscale quality evidence and benchmark operations](docs/AI-UPSCALE-QUALITY-EVIDENCE.md).
AI upscaling also checks projected output dimensions and pixel count before starting inference. Requests above the bounded worker pixel budget are rejected before launching the GPU process; this complements, rather than replaces, the existing output-byte limit.


AI upscale integrity now detects alpha-bearing PNG/WebP sources, rejects JPEG output for transparent sources before inference, and rejects/deletes derivatives when the output drops transparency. Channel-presence validation does not claim pixel-perfect matte fidelity; quality review remains required.


The NCNN/Vulkan adapter rejects high-bit-depth PNG and JPEG sources until that execution path has passed independent precision-preservation tests. Source/output sample depth is recorded in derivative provenance when available. The Python Real-ESRGAN implementation's documented 16-bit capability is not assumed to apply to the separate NCNN executable.


## Cloudflare D1 staging foundation

The isolated D1 metadata schema, tenant-scoped repository adapter and staging Worker are deployed. The Worker is available at [the isolated staging endpoint](https://executive-visuals-d1-staging.chrishem.workers.dev); its live edge health and D1 health checks return HTTP 200, while anonymous project access returns HTTP 401. A read-only D1 audit confirmed migration `0001_initial.sql`, all seven `ev_*` tables, and zero application rows. The current-main same-origin `/api/d1/*` proxy and its authenticated-cookie regression test are merged; the proxy remains disabled in production because `D1_STAGING_WORKER_URL` has not been configured there. No authenticated browser workspace round-trip has been run. The implementation maps an already verified external identity subject to a D1 principal and stores metadata only; it does not store passwords, tokens, media bytes or provider credentials. See [D1 Staging Foundation](docs/D1-STAGING-FOUNDATION.md). Run `npm run verify:d1` for local schema, repository and Worker authentication tests. The Worker uses the existing Render authentication endpoints and `/api/me` to verify the session and derives the D1 principal from that verified identity; it does not accept client-supplied owner IDs. It exposes only `/api/d1/*` plus login/logout and `/api/me`; all production business routes (projects, assets, jobs, etc.) are blocked. Do not redirect the live `/api/projects` API to D1 until dependent routes and data migration are complete.


## Governed video workflow contract

The current-main implementation defines the immutable `video.generate` request and owner/project-scoped private source resolver. It is a preparatory security boundary only; it does not enable paid generation or claim the full workflow-to-cloud job lifecycle is complete. See [the contract and verification boundary](docs/VIDEO-WORKFLOW-CLOUD-CONTRACT.md).
