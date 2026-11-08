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
- The C2PA signed-fixture test uses the official upstream CAI test certificate/key pair, clearly marked test-only; no OpenSSL CLI is required.
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

The build runs the repository's configured verification suites before TypeScript compilation and Vite bundling. Run the focused test for the subsystem you changed first, then the complete build. Do not describe a test as passing unless it was actually run against the current commit.

## Asset provenance and C2PA

The current asset-provenance endpoint is:

```http
GET /api/assets/:assetId/provenance
Cookie: ev_session=...
```

It is protected by the same asset-access boundary as the underlying asset. The current `integrity_verified` state means only that the application's SHA-256 record is internally consistent with the asset row. The route now invokes a server-side adapter backed by the maintained CAI package `@contentauth/c2pa-node` (pinned to 0.10.0). The adapter uses `Reader.fromAsset` with the stored file path and known MIME type, disables remote manifest fetching, and returns the SDK manifest validation state and bounded validation findings. It distinguishes `not_available`, `not_supported`, `invalid`, `valid_untrusted`, `valid_trusted` and `verification_error`. The initial format allowlist covers JPEG, PNG, WebP, GIF, MP4, MOV, MP3, M4A, WAV and PDF when the stored extension matches the MIME type. A C2PA `Trusted` result is only surfaced as `valid_trusted` when an explicit administrator-controlled trust policy is configured through `C2PA_TRUST_ANCHORS`; without that policy it is downgraded to `valid_untrusted`. The existing application SHA-256 integrity record remains separate.

The asset library now exposes a **Verify Content Credentials** action for each stored asset and displays the resulting state and validation findings. The current adapter performs verification only. It does not yet create or sign manifests. Do not report an asset as trusted merely because a manifest is present. Signing requires a protected signer and an approved certificate/timestamp policy.

Current C2PA settings:

| Variable | Purpose | Guidance |
|---|---|---|
| `C2PA_TRUST_ANCHORS` | PEM root trust-anchor file path | Optional administrator-controlled root anchors. |
| `C2PA_MAX_VERIFY_BYTES` | Maximum bytes passed to the native verifier | Defaults to 250 MiB; retain a conservative limit. |

Planned signing and lineage constraints:

- Use the official Node SDK on the server, not browser-supplied validation claims.
- Use `Reader.fromAsset` with a known MIME type and a file-backed asset for untrusted or large files; avoid allocating arbitrary uploads into memory before size checks.
- Preserve SDK validation findings and distinguish signature validity from certificate/trust-policy status.
- Keep missing credentials, invalid credentials, valid-but-untrusted credentials and trusted credentials distinct.
- Preserve ingredient relationships and record each transformation in a new manifest; do not claim an old signature remains valid after media bytes change.
- Keep signing keys outside the repository, browser, application configuration and ordinary environment-variable values. Production signing should use an authenticated KMS/HSM-backed callback signer and an approved certificate/timestamp policy.
- Do not enable production signing until certificate issuance, key custody, rotation, timestamping, revocation and incident-response procedures are approved.

See [Asset provenance and Content Credentials](docs/ASSET-PROVENANCE-AND-CONTENT-CREDENTIALS.md) for the detailed integration contract and acceptance criteria.

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
| `CLOUD_TIMELINE_API_ENABLED` | Cloud timeline API gate | Keep disabled until the isolated staging release gates pass. |

Never commit API keys, service-role keys, provider tokens, certificates, private keys, signing-service credentials or production data. Do not put Supabase service-role credentials in browser-visible variables. A `.env.example` file should contain placeholders only.

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
