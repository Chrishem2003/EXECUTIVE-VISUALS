# CHRISHEM EXCLUSIVE VISUALS

**One integrated visual-production system — from creative brief to reviewed deliverable.**

CHRISHEM EXCLUSIVE VISUALS is an original, provider-neutral creative production platform for planning, media ingest, graph workflows, local processing, editing, enhancement, localization, review and campaign production. It is designed to connect creative intent, evidence, assets, people, shots, timelines and approved deliverables in one governed workspace.

> **Implementation truth:** this repository contains a substantial working foundation, but not every capability listed in the product roadmap is production-ready. Read [Implementation status](docs/IMPLEMENTATION-STATUS.md) and [Public release gates](docs/PUBLIC-RELEASE-GATES.md) before relying on a capability or deploying it.

## Product workspaces

- Creative direction, research, briefs, scripts and storyboards. The AI Director includes a deterministic Creative DNA compiler for audience promise, emotional journey, hook angles, visual grammar, sound identity, proof checks and platform cut planning.
- Workflow canvas, typed media ports, server-side validation and targeted run planning.
- Multi-track editorial timeline with frame-based trims, splits, clip movement, review markers, interchange export and local MP4 master rendering (H.264 video, synchronized AAC audio, still-image overlays and burned-in SRT/VTT captions).
- Intent-linked editing: clips can record the story beat, audience promise, purpose and proof reference they serve; a bounded, timestamped decision ledger preserves creative direction changes.
- Character, voice, identity, wardrobe and consent records; cinematic shot planning and continuity.
- Image/video production planning, voice/transcription/translation/localization planning and media enhancement workflows.
- Campaign and multi-format production planning; asset library, provenance and version lineage.
- Project collaboration with owner, editor, reviewer and viewer roles; timecoded review comments, approvals and change requests.
- Operations, capability readiness and audit history.

## Current runtime foundation

The local API service includes:

- Local account registration and sign-in for development.
- User-owned projects, project-scoped creative workspace documents and optimistic revision checks.
- Binary media uploads to local disk with SHA-256 integrity metadata, plus on-demand Content Credentials verification in the asset library using the official CAI Node SDK.
- Asset ownership isolation and original/derivative relationships.
- Persistent workflow records and an observable job/event queue with renewable leases, stale-worker recovery, bounded retries, backoff and cross-process cancellation polling.
- A local FFmpeg media adapter for probe, thumbnail, transcode, audio extraction, proxy generation and master-timeline rendering when FFmpeg/FFprobe are installed.
- Explicit rejection of unimplemented image/video/speech generation; no fake success. A server-side text gateway is available but disabled by default and requires explicit approval and remote-access opt-in.
- Audit events, idempotency keys, upload limits, secure cookies, restrictive content security policy and server-side credential boundaries.
- Persistent creative briefs, shot lists, characters, scripts and variants stored per project with optimistic revision conflicts.
- Searchable capability atlas with 110 definitions across 23 domains.
- Application-level asset provenance records bound to asset IDs, SHA-256, media type and size. **These records are not C2PA Content Credentials and do not constitute cryptographic signatures.**

The browser and API run together in development. SQLite and media files are stored under `data/`, which is ignored by Git. Back up that folder if you need to preserve local work.

## Requirements

- Node.js 24.22.1 or later in the Node 24 line is the recommended baseline; the CAI Node SDK also supports patched Node 22.23.4+ and Node 26.12.1+ releases.
- npm (the lockfile is npm lockfile v3).
- FFmpeg and FFprobe on PATH for media processing and timeline rendering.
- The C2PA signed-fixture tests use the official upstream CAI test certificate/key pair to sign PNG and MP4 media, clearly marked test-only; no OpenSSL CLI is required.
- A supported operating system and architecture for the native CAI Node package. The package downloads precompiled binaries during installation on supported targets. See the [official CAI Node documentation](https://contentauth.github.io/c2pa-js/modules/_contentauth_c2pa-node.html).

## Run locally

```bash
npm ci
npm run dev
```

Open the Vite URL (normally http://localhost:5173). The API health endpoint is http://127.0.0.1:4179/api/health.

For media processing, install FFmpeg and FFprobe and ensure both executables are available on PATH. The application can still be explored without them, but media jobs requiring those binaries will not run.

## Verify changes

```bash
npm run typecheck
npm run verify:provenance
npm run verify:c2pa
npm run verify:server
npm run build
```

The C2PA suite exercises native SDK manifest inspection, signed/tampered PNG verification and callback-signer ingredient-lineage tests using the upstream test-only fixture. The build runs the repository's configured verification suites before TypeScript compilation and Vite bundling. Run the focused test for the subsystem you changed first, then the complete build. Do not describe a test as passing unless it was actually run against the current commit.

## Asset provenance and C2PA

The current asset-provenance endpoint is:

```http
GET /api/assets/:assetId/provenance
Cookie: ev_session=...
```

It is protected by the same asset-access boundary as the underlying asset. The current `integrity_verified` state means only that the application's SHA-256 record is internally consistent with the asset row. The route now invokes a server-side adapter backed by the maintained CAI package `@contentauth/c2pa-node` (pinned to 0.10.0). The adapter uses `Reader.fromAsset` with the stored file path and known MIME type, disables remote manifest fetching, and returns the SDK manifest validation state and bounded validation findings. It distinguishes `not_available`, `not_supported`, `invalid`, `valid_untrusted`, `valid_trusted` and `verification_error`. The initial format allowlist covers JPEG, PNG, WebP, GIF, MP4, MOV, MP3, M4A, WAV and PDF when the stored extension matches the MIME type. A C2PA `Trusted` result is only surfaced as `valid_trusted` when an explicit administrator-controlled trust policy is configured through `C2PA_TRUST_ANCHORS`; without that policy it is downgraded to `valid_untrusted`. The existing application SHA-256 integrity record remains separate.

The asset library now exposes a **Verify Content Credentials** action for each stored asset and displays the resulting state and validation findings. Verification remains a read-only server operation. A separate server-only callback signing adapter creates a new manifest for transformed bytes, records the original source as an ingredient, signs through an injected protected signer, then reopens and verifies the signed output. The cloud media executor can invoke this adapter before publishing a derivative when an authorized signer callback is injected. No signer is configured in the default worker process, so production signing remains disabled.

Current C2PA settings:

| Variable | Purpose | Guidance |
|---|---|---|
| `C2PA_TRUST_ANCHORS` | PEM root trust-anchor file path | Optional administrator-controlled root anchors. |
| `C2PA_MAX_VERIFY_BYTES` | Maximum bytes passed to the native verifier and signer | Defaults to 250 MiB; retain a conservative limit. |
| `C2PA_SIGNING_ENABLED` | Callback signing gate | Defaults to `false`; enabling it alone does not provision a signer. |
| `C2PA_SIGNING_KEY_REF` | External KMS/HSM key reference | Identifier only; never store private key material here. |
| `C2PA_TSA_URL` | Timestamp authority | HTTPS endpoint; required by default for signing. |
| `C2PA_SIGNING_MEDIA_ROOT` | Private signing workspace root | Must match the cloud worker's `CLOUD_WORKER_TEMP_ROOT`; use a dedicated, private scratch directory. |

Planned signing and lineage constraints:

- Use the official Node SDK on the server, not browser-supplied validation claims.
- Use `Reader.fromAsset` with a known MIME type and a file-backed asset for untrusted or large files; avoid allocating arbitrary uploads into memory before size checks.
- Preserve SDK validation findings and distinguish signature validity from certificate/trust-policy status.
- Keep missing credentials, invalid credentials, valid-but-untrusted credentials and trusted credentials distinct.
- Preserve ingredient relationships and record each transformation in a new manifest; do not claim an old signature remains valid after media bytes change.
- A server-only callback signing adapter now exists in `server/c2pa-signing.mjs`. It uses the official SDK `CallbackSigner`, writes a new transformation manifest, retains source ingredients and verifies the signed output.
- The adapter is disabled by default and requires an injected `signingProvider.sign({ keyRef, algorithm, payload })` implementation. The application never receives a private key; production integration must connect this callback to an authenticated KMS/HSM service.
- Timestamping is required by default. The test-only callback explicitly disables timestamp requirements; production must configure an approved HTTPS TSA.
- The callback is wired into `createCloudMediaExecutor` and `createCloudMediaWorker`: when injected, it signs the actual transformed file with the original source as its ingredient before durable publication, then verifies the signed output hash and media stream. The default `cloud-worker-process` does not instantiate a signing provider; no KMS/HSM provider, production certificate or TSA has been provisioned. Local timeline rendering/export is not yet connected.
- Keep signing keys outside the repository, browser, application configuration and ordinary environment-variable values. Do not enable production signing until certificate issuance, key custody, rotation, timestamping, revocation and incident-response procedures are approved.

See [Asset provenance and Content Credentials](docs/ASSET-PROVENANCE-AND-CONTENT-CREDENTIALS.md) for the detailed integration contract and acceptance criteria.

For C2PA verification, mount `C2PA_TRUST_ANCHORS` as a read-only PEM public-certificate bundle outside the repository. For optional cloud-worker signing, set `CLOUD_WORKER_TEMP_ROOT` and `C2PA_SIGNING_MEDIA_ROOT` to the same dedicated private scratch directory, set `C2PA_SIGNING_ENABLED=true`, and supply an authenticated `signingProvider` plus public certificate chain through `startCloudWorkerProcess(env, { signingProvider, certificateChain })`. The default CLI process does not contain a provider and fails closed if signing is enabled without the injected dependency. Do not enable signing until the provider, certificate chain, HTTPS TSA, key custody and rotation policy have been approved. Setting environment flags without the protected provider does not make signing operational.

## Configuration and secrets

The API reads configuration from environment variables. Important settings include:

| Variable | Purpose | Guidance |
|---|---|---|
| `NODE_ENV` | Runtime mode | Use `production` only with production-grade authentication and storage configured. |
| `PORT` / `API_PORT` | API listen port | Defaults to 4179. |
| `API_HOST` | Bind address | Defaults to loopback outside production. |
| `DATA_DIR` | Durable application data directory | Back up and persist this directory. |
| `MEDIA_ROOT` | Media storage root | Keep within the mounted persistent data volume when required. |
| `DB_FILE` | SQLite database path | Keep within `DATA_DIR` when persistent storage is required. |
| `REQUIRE_PERSISTENT_DATA_DIR` | Require persistent mount | Set to `true` for deployments that must fail closed without a persistent volume. |
| `AUTH_MODE` | Authentication mode | Local mode is development-only; hosted production requires Supabase mode. |
| `SUPABASE_URL` | Supabase project URL | Configure only for a dedicated, approved project. |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase public client key | Configure as deployment secret/config; never commit credentials. |
| `COOKIE_SECURE` | Secure cookie override | Set to `true` behind HTTPS where required. |
| `MAX_UPLOAD_BYTES` | Upload limit | Keep limits conservative and validate actual media signatures. |
| `CLOUD_TIMELINE_API_ENABLED` | Cloud Projects, private cloud asset shelf and timeline API gate | Keep disabled until the dedicated isolated Supabase schema, private bucket, RLS/storage policies and staging release gates pass. Requires `AUTH_MODE=supabase`. |
| `CLOUD_WORKER_TEMP_ROOT` | Private cloud worker scratch directory | Must exist and be private; when C2PA signing is enabled it must match `C2PA_SIGNING_MEDIA_ROOT`. |
| `C2PA_TRUST_ANCHORS` | PEM public trust bundle path | Administrator-managed, read-only public certificates only. |
| `C2PA_MAX_VERIFY_BYTES` | C2PA parser/signing size limit | Defaults to 250 MiB. |
| `C2PA_SIGNING_MEDIA_ROOT` | Dedicated signing workspace root | Must match `CLOUD_WORKER_TEMP_ROOT`; never use a shared or browser-writable directory. |
| `C2PA_SIGNING_ENABLED` | Callback signing gate | Defaults to `false`; do not enable without an approved protected signer provider. |
| `C2PA_SIGNING_KEY_REF` | External key reference | Identifier only; never a private key or secret value. |
| `C2PA_TSA_URL` | Timestamp authority | Must be HTTPS; required by default for signing. |

Never commit API keys, service-role keys, provider tokens, certificates, private keys, signing-service credentials or production data. Do not put Supabase service-role credentials in browser-visible variables. A `.env.example` file should contain placeholders only.

The Runtime Asset Library includes a separate **Private Cloud Storage** shelf when `CLOUD_TIMELINE_API_ENABLED=true` and verified Supabase authentication is active. It lists account-authorized cloud assets, accepts streamed personal uploads, displays recorded SHA-256 metadata and creates short-lived signed preview/download links on demand. This shelf does not silently switch local media jobs to cloud execution; local `/api/assets` remains the processing path until the cloud worker and media lifecycle are explicitly integrated and accepted in staging. The Cloud Projects workspace continues to provide project-scoped uploads.

For detailed operational steps, see [Developer and operations guide](docs/DEVELOPMENT-AND-OPERATIONS.md).

## Staging and production boundary

A Docker-based Render Blueprint is provided in `render.yaml`. It expects a private persistent disk mounted at `/var/data`, Supabase authentication and a worker process. Review the Blueprint and its costs before creating or resuming any service.

Production mode refuses local-password authentication. Configure a trusted identity provider, persistent storage, HTTPS, rate limits and deployment-specific security controls before exposing the service. Do not attach this project to another product's database or shared storage. Dedicated database migrations are review-only unless explicitly approved and applied through a controlled release.

**Merging code into `main` may trigger deployment.** Use a feature branch and pull request for implementation. Do not merge or deploy merely because code exists. Keep production, shared Supabase projects, external storage buckets and paid provider execution untouched until their separate approvals and release gates are satisfied.

## Known incomplete capabilities

Actual image/video generation, speech/dubbing, timeline preview playback, transitions, effects, animated/video overlays, multi-host cloud storage, live collaboration and publishing are not considered complete until their adapters and end-to-end tests pass. The text gateway records usage but does not calculate provider pricing; verify cost before enabling a remote/billable endpoint.

## Research, architecture and implementation records

- [Product North Star and Master Build Plan (2026)](docs/PRODUCT-NORTH-STAR-AND-MASTER-BUILD-PLAN-2026.md) — competitive discoveries, original feature strategy, domain model, phased backlog and acceptance evidence.
- [Developer and operations guide](docs/DEVELOPMENT-AND-OPERATIONS.md) — local setup, environment, testing, security, staging and troubleshooting.
- [Asset provenance and Content Credentials](docs/ASSET-PROVENANCE-AND-CONTENT-CREDENTIALS.md) — upload-bound integrity records, verification API and C2PA integration path.
- [Public release gates](docs/PUBLIC-RELEASE-GATES.md)
- [Product integration and scale plan](docs/PRODUCT-INTEGRATION-AND-SCALE-PLAN.md)
- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Cross-ecosystem capability expansion](docs/CROSS-ECOSYSTEM-CAPABILITY-EXPANSION.md)
- [Expanded capability atlas](docs/EXPANDED-CAPABILITY-ATLAS.md)
- [Additional workflow research](docs/ADDITIONAL-WORKFLOW-RESEARCH.md)
- [Adapter contract](docs/ADAPTER-CONTRACT.md)
- [Original creative intelligence and innovation atlas](docs/ORIGINAL-CREATIVE-INTELLIGENCE-AND-INNOVATION-ATLAS.md)


### Creative Intelligence Graph

Open **AI Director** and save a production to a private cloud project. The graph panel reads the saved creative-production record, private project assets and each accessible cloud timeline. It follows explicit shot/character IDs, series story-bible entry IDs attached to scenes and shots, scene and shot marker IDs, and timeline clip asset IDs. Project-scope membership is labelled separately from authored dependencies. Missing or unresolved relationships are not guessed.

Choose a graph node and run **Analyze downstream impact** before changing it. The report lists dependent shots, clips and timelines that may need human review. Source asset nodes include SHA-256 fingerprints and byte size, so a changed source fingerprint is treated as a graph revision and its dependent characters, evidence and timeline clips are surfaced for review. It is a dependency analysis only: it does not automatically rewrite timelines, invalidate exports, or claim semantic understanding of media. The automated test is `npm run verify:creative-graph`.


## Evidence intelligence and review

Executive Visuals now has a project-scoped evidence ledger for source-backed production claims. Editors submit evidence against an asset and an explicit project/scene/shot/timeline/asset target; the API snapshots the source SHA-256 and records a submission event. Project owners, editors and reviewers can review the record, with reviewer identity and decision preserved in a separate event history. Client-submitted records always begin as `submitted`; clients cannot self-verify evidence. See [Evidence intelligence and review ledger](docs/EVIDENCE-INTELLIGENCE-AND-REVIEW-LEDGER.md) for API routes, lifecycle, permission rules and interpretation limits. Reviewer-verified records now connect to their explicit scene, shot, timeline or asset targets in the AI Director graph only when the source SHA-256 and project scope match. In addition, the API re-hashes the actual managed source file and checks its byte size before accepting a submission and again before recording a review decision; missing, replaced or modified files fail closed. Every review decision requires a written reason of at least eight characters. The AI Director displays the source SHA-256 fingerprint and available method/reference alongside each record. Submitted or rejected records remain review-only; unresolved targets are shown as disconnected. Evidence review is not a guarantee of factual truth, legal rights or identity.


## Creative graph revision baselines

AI Director can record immutable, per-project Creative Intelligence Graph review baselines. Later graph changes are compared against the saved revision; added, removed and changed nodes are identified and downstream dependencies are surfaced as potentially stale for human review. Project-scope membership edges are excluded from change fingerprints to avoid falsely marking every project item stale. This does not automatically mutate timelines or invalidate exports. See [Creative graph revision baselines](docs/CREATIVE-GRAPH-REVISION-BASELINES.md).


## Production execution integration status

The current `main` contains the idempotent asset-publication ledger (merged PR #226). The consolidated feature branch `feat/c2pa-protected-signing` (PR #240) now carries the next cloud reliability slice: database-generated per-attempt UUID lease fencing; v2 claim/renew/assert/finish RPCs; heartbeat draining and pre-publication lease checks; job-bound publication reservations; atomic asset metadata + publication-ledger finalization under the active job row lock; immutable per-attempt object paths; same-tenant derivative enforcement; and tombstone-claimed cleanup for orphan attempts. PostgreSQL integration tests exercise stale-token rejection, atomic publication, cleanup claims and derivative scope. These changes are **feature-branch code only**: at the last exact-head inspection (`6e6034605fd10f888d79186eef38d11535470bf1`), PostgreSQL integration and TypeScript validation passed, while the full build was still running and Docker inspection was pending. Re-check [PR #240](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/240) for current checks. Migrations have not been applied to an isolated Supabase project, the default media-processing path remains local SQLite/disk, and no cloud worker is deployed. The separate opt-in cloud asset shelf is not a replacement for the local processing path. See [Implementation status](docs/IMPLEMENTATION-STATUS.md), [Product North Star and Master Build Plan](docs/PRODUCT-NORTH-STAR-AND-MASTER-BUILD-PLAN-2026.md) and [Public release gates](docs/PUBLIC-RELEASE-GATES.md). Do not merge or deploy until the current PR's combined CI and isolated staging acceptance pass.
