# Executive Visuals

**One integrated visual-production system — from creative brief to reviewed deliverable.**

A provider-neutral platform for creative planning, media ingest, graph workflows, local processing, editing, enhancement, localization, review and campaign production. The implementation is original and based on publicly observable product behavior and public developer documentation.

## Workspaces
- Creative direction, research, briefs, scripts and storyboards.
- Workflow canvas, typed media ports, server-side validation and targeted run planning.
- Multi-track editorial timeline with frame-based trims, splits, clip movement, review markers, interchange export and local MP4 master rendering (H.264 video, synchronized AAC audio, still-image overlays and burned-in SRT/VTT captions).
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
```

## Production boundary
Production mode refuses local-password authentication. Configure a trusted identity provider, persistent storage, HTTPS, rate limits and deployment-specific security controls before exposing the service. Do not attach this project to another product's database. A dedicated database migration is included for review but is not automatically applied.

Actual image/video generation, speech/dubbing, timeline preview playback, transitions, effects, animated/video overlays, multi-host cloud storage, live collaboration and publishing are not considered complete until their adapters and end-to-end tests pass. The text gateway records usage but does not calculate provider pricing; verify cost before enabling a remote/billable endpoint.


## Staging deployment

A Docker-based Render Blueprint is provided in `render.yaml`. It uses a private 1 GB persistent disk mounted at `/var/data`; the API refuses to start when the required mount is absent, preventing accidental use of an ephemeral filesystem. The staging blueprint uses local account authentication and one worker process; its lease-based queue supports multiple processes only when they share the same SQLite database and media volume. Do not deploy this blueprint on the free ephemeral plan for user data. Review the monthly compute and disk charge before creating the service.


## Research and implementation records

- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Cross-ecosystem capability expansion](docs/CROSS-ECOSYSTEM-CAPABILITY-EXPANSION.md)
- [Expanded capability atlas](docs/EXPANDED-CAPABILITY-ATLAS.md)
- [Additional workflow research](docs/ADDITIONAL-WORKFLOW-RESEARCH.md)
- [Adapter contract](docs/ADAPTER-CONTRACT.md)
