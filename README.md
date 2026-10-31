# Executive Visuals

**One integrated visual-production system — from creative brief to reviewed deliverable.**

A provider-neutral platform for creative planning, media ingest, graph workflows, local processing, editing, enhancement, localization, review and campaign production. The implementation is original and based on publicly observable product behavior and public developer documentation.

## Workspaces
- Creative direction, research, briefs, scripts and storyboards.
- Workflow canvas, typed media ports, server-side validation and targeted run planning.\n- Multi-track editorial timeline with frame-based trims, splits, clip movement, review markers, interchange export and local MP4 master rendering (H.264 video plus synchronized AAC audio).
- Character, voice, identity, wardrobe and consent records.
- Cinematic shot planning and continuity.
- Image and video production planning.
- Voice, transcription, translation and localization.
- Media enhancement, repair and derivatives.
- Campaign and multi-format production.
- Asset library, provenance and version lineage.\n- Project collaboration with owner, editor, reviewer and viewer roles.\n- Timecoded review comments, approvals and change requests.
- Operations, capability readiness and audit history.

## Runtime milestone
The application now includes a local API service with:
- Local account registration and sign-in for development.
- User-owned projects and optimistic revision checks.
- Binary media uploads to local disk with SHA-256 integrity metadata.
- Asset ownership isolation and original/derivative relationships.
- Persistent workflow records and an observable job/event queue.
- A local FFmpeg media adapter for probe, thumbnail, transcode, audio extraction, proxy generation and master-timeline rendering when FFmpeg/FFprobe are installed.
- Explicit rejection of unimplemented generation capabilities; no fake success and no paid provider call.
- Audit events, idempotency keys, upload limits, secure cookies and server-side credential boundaries.

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

Actual model-based image/video generation, timeline preview playback, transitions, effects, overlay/caption compositing, cloud collaboration and publishing are not considered complete until their adapters and end-to-end tests pass.


## Staging deployment

A Docker-based Render Blueprint is provided in `render.yaml`. It uses a private 1 GB persistent disk mounted at `/var/data`; the API refuses to start when the required mount is absent, preventing accidental use of an ephemeral filesystem. The staging blueprint uses local account authentication and one local worker. Do not deploy this blueprint on the free ephemeral plan for user data. Review the monthly compute and disk charge before creating the service.
