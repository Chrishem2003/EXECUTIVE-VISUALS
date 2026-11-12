# Current release status — 12 November 2026

The live mainline now includes the hardened Supabase account/session implementation (opaque HttpOnly sessions, encrypted provider tokens, refresh coordination and same-origin mutation checks); guarded batch image enhancement with idempotent replay and progress history; private cloud Asset Library listing/upload/read integration and gated cloud media-job submission/history; timeline speed remapping, audio mixer/waveform and preview improvements; and official CAI Content Credentials verification with real signed-MP4 trust and tamper tests. The latest C2PA trust-policy change is merged in [PR #468](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/468), with the patched Node 22.23.4 runtime in [PR #469](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/469). The latest live application-code deployment is commit `b92390778e9e65cc992808fc1e2e93e297d3deda` (PR #468), which Render reports as live. Subsequent commits in this checkpoint update documentation only and use `[skip render]`, so they do not redeploy or alter the running application.

Provider cancellation/restart reconciliation is **not** released: the earlier [PR #387](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/387) closed unmerged; the current customer cancellation work remains draft [PR #303](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/303), stacked on the broader integration candidate [PR #206](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/206). Google Drive and the broader provider integration also remain in that draft candidate; Google execution stays gated. The stale password-recovery duplicate [PR #251](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/251) was closed because the recovery routes/UI are already in main through [PR #436](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/436); hosted recovery delivery and isolated identity-provider acceptance remain release gates.

**Storage is not yet durable for hosted customer media.** The existing Render Free service uses ephemeral local storage and SQLite. The isolated Cloudflare D1 metadata schema and staging Worker are deployed, but the same-origin proxy remains deliberately disabled on production and an authenticated staging workspace round-trip has not been completed. R2 has not been activated. The two existing Supabase projects contain NEMA/platform data and must not be reused. See [D1 Staging Foundation](docs/D1-STAGING-FOUNDATION.md) and [Persistence and Release Blockers](docs/PERSISTENCE-AND-RELEASE-BLOCKERS.md).

**Public release remains not approved.** Passing CI and a live Render deployment do not prove durable customer storage, hosted auth acceptance, private media lifecycle, backup/restore, payment readiness or end-to-end provider execution. Keep paid providers, Google Drive execution, production database migrations and R2 activation gated until their dedicated staging and cost/approval requirements pass. The detailed implementation record is in [Full-System Release Readiness](docs/FULL-SYSTEM-RELEASE-READINESS.md).

The older Render Blueprint section below describes a paid-compute/persistent-disk deployment option, not an approved free staging environment. Do not provision it or incur charges as part of this plan. No production resources, credentials, database migrations, paid services, or provider execution should be changed without explicit approval.

---

## Storage persistence and deployment checks

See [Storage persistence status and deployment truth](docs/STORAGE-PERSISTENCE-TRUTH.md). Configure an operator-confirmed volume only after verifying the host mount, and test backup/restore separately.

# CHRISHEM EXCLUSIVE VISUALS

**One integrated visual-production system — from creative brief to reviewed deliverable.**

CHRISHEM EXCLUSIVE VISUALS is a provider-neutral platform for creative planning, media ingest, graph workflows, local processing, editing, enhancement, localization, review and campaign production. The implementation is original and based on publicly observable product behavior and public developer documentation.

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
