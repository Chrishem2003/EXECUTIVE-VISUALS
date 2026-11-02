# Development

## Requirements
- Node.js 22.12+ (Node 22 is used in CI)
- npm
- Optional: FFmpeg and FFprobe for local media processing

## Run the complete local stack
```bash
npm install
npm run dev
```
This starts the API on `127.0.0.1:4179` and the Vite frontend on `0.0.0.0:5173`. Vite proxies `/api` requests to the API service.

Create a local development account on first use. Passwords are hashed with scrypt; session tokens are random, stored only as SHA-256 hashes, and sent in HttpOnly, SameSite=Strict cookies.

## Runtime storage
- SQLite database: `data/executive-visuals.sqlite`
- Original media: `data/media/uploads/`
- Derived media: `data/media/derived/`

The `data/` directory is ignored by Git. Preserve it when backing up local projects and media.

## Implemented API
- `GET /api/health`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`
- `GET/POST /api/projects`, `PUT/DELETE /api/projects/:id`
- `GET/POST /api/assets`, `GET /api/assets/:id/file`, `DELETE /api/assets/:id`
- `GET/POST /api/workflows`, `GET/PUT /api/workflows/:id`, `POST /api/workflows/:id/run`, `GET /api/workflows/:id/runs`
- `GET /api/workflow-runs/:id`, `POST /api/workflow-runs/:id/approve`
- `GET/POST /api/timelines`, `GET/PUT/DELETE /api/timelines/:id`, `GET /api/timelines/:id/otio`
- `GET/POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events`, `POST /api/jobs/:id/cancel`
- `GET/POST /api/reviews`, `PUT /api/reviews/:id`
- `GET /api/audit`

Uploads are raw binary request bodies. The client sends `Content-Type`, `X-File-Name` and optional `X-Project-Id` headers. Maximum size defaults to 250 MiB.

## Project collaboration and review
Project owners can invite existing accounts as editor, reviewer or viewer. Editors can upload and modify project production records, reviewers can comment and approve/request changes, and viewers are read-only. Removing a member revokes access to project-scoped assets, jobs, workflows and timelines. Review comments support optional timecodes and auditable status changes.

## Workflow execution
Workflow runs store an immutable graph snapshot and hash plus a status record for every node. Local nodes include text/data, uploaded asset references, frame extraction, audio extraction, media probe, transcode/compress, approval, merge/batch, export and timeline render. Approval nodes pause the run until an authorized owner/editor/reviewer approves. Nodes without a registered local adapter are marked blocked; they do not call a paid service.

## Editorial timeline
The Video Editor uses a persisted multi-track timeline model with rational frame timing, source ranges, track locking, clip placement, trim, split, move, markers, overlap validation and interchange JSON export. Timelines are owner-scoped, versioned and saved through optimistic revision checks. Local MP4 master rendering supports one primary video track, synchronized audio-only clips mixed into AAC, still-image overlays, per-clip gain and burned-in SRT/VTT captions. Preview playback, transitions, advanced effects, animated/video overlays and multi-video compositing remain pending.

## Local media jobs
- `media.probe` — inspect streams and container metadata.
- `media.thumbnail` — extract a still frame.
- `media.transcode` — transcode to an allowlisted container/codec.
- `media.audio_extract` — extract audio.
- `media.proxy` — create a lower-resolution editing proxy.

The worker runs only jobs with registered local adapters. Unsupported AI generation tasks return `ENGINE_UNAVAILABLE` rather than pretending to run.

## Verification
```bash
npm run typecheck
npm run verify:capabilities
npm run verify:workflow
npm run verify:server
npm run build
```

## Production safety
- Local auth is development-only; production startup rejects it.
- Production authentication requires a verified bearer token from the configured identity service.
- Never expose a service-role key or provider credential to the browser.
- Keep persistent media storage outside the application bundle.
- Do not reuse another application's database without a dedicated schema, explicit RLS policies and an approved isolated environment.
- No paid media generation or provider call is enabled by default.
