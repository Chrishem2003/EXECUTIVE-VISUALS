## Live application and environment boundaries

- **Existing Render production:** https://executive-visuals.onrender.com
- **Cloudflare Workers preview:** https://executive-visuals.chrishem242.workers.dev

The Cloudflare URL is an edge/frontend preview, **not an isolated staging environment**. A read-only inspection of the latest deployed Worker version (2026-11-07 13:54 UTC) confirmed that its only binding is static assets and that `API_ORIGIN` is absent. Therefore its API proxy fails closed with HTTP 502 rather than routing to Render production. The branch also removes the production-origin default from `wrangler.jsonc`. Do not configure an API origin until a dedicated isolated staging backend exists. The Render production backend currently reports SQLite/local-disk storage, which is not durable customer storage.

# CHRISHEM EXCLUSIVE VISUALS

**One integrated visual-production system — from creative brief to reviewed deliverable.**

CHRISHEM EXCLUSIVE VISUALS is a provider-neutral platform for creative planning, media ingest, graph workflows, local processing, editing, enhancement, localization, review and campaign production. The implementation is original and based on publicly observable product behavior and public developer documentation.

## Governed cloud video workflow progress

The integration branch now has a non-billable Runway Model Router quote
contract for supported `video.generate` workflow nodes. The quote is bound
to the project and canonical request hash, and the quote ledger records its
actor, provider/model/operation, routed model, estimate, pricing source and
short expiry before the API returns it. Quote records are server-only and
covered by disposable PostgreSQL CI checks. This is not yet paid execution:
explicit quote approval, atomic customer-credit/provider-budget reservation,
durable workflow job mapping and private output publication remain release
gates. Cloud workflow mode and paid provider execution remain disabled.

## Governed Video Studio workflow bridge

The source-controlled cloud bridge now supports a non-billable, durable Model Router quote and an explicit approval endpoint that atomically creates the budget approval, reserves the project budget and queues one idempotent cloud video job. The quote and approval are bound to the authenticated actor, project, canonical request hash, operation, short expiry and saved router configuration. Both disposable PostgreSQL CI paths verify the ledger and enqueue contract. Provider execution remains independently gated; the interactive workflow executor has not yet switched to cloud mode, and provider output-to-node handoff remains a release gate.

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

## Runtime milestone
The application now includes a local API service with:
- Local account registration and sign-in for development.
- User-owned projects, project-scoped creative workspace documents and optimistic revision checks.
- Binary media uploads to local disk with SHA-256 integrity metadata.
- Asset ownership isolation and original/derivative relationships.
- Persistent workflow records and an observable job/event queue with renewable leases, stale-worker recovery, bounded retries, backoff and cross-process cancellation polling.
- A local FFmpeg media adapter for probe, thumbnail, transcode, audio extraction, proxy generation and master-timeline rendering with synchronized audio, still-image overlays and burned-in captions when FFmpeg/FFprobe are installed.
- Provider-backed image generation through the existing compatible gateway, Fal, Gemini and the new guarded Runway GPT Image 2.6 adapter. Image jobs require a completed upstream human-approval node; remote execution is disabled unless explicitly opted in. Video and speech generation remain adapter- and provider-configuration-dependent; unsupported paths fail closed.
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

Actual video generation, speech/dubbing, timeline preview playback, transitions, effects, animated/video overlays, multi-host cloud storage, live collaboration and publishing are not considered complete until their adapters and end-to-end tests pass. Runway GPT Image 2.6 supports one output per workflow job today; multi-output fan-out, production billing settlement and staging acceptance remain open. The text gateway records usage but does not calculate provider pricing; verify cost before enabling a remote/billable endpoint.


## Staging deployment

A Docker-based Render Blueprint is provided in `render.yaml`. It uses a private 1 GB persistent disk mounted at `/var/data`; the API refuses to start when the required mount is absent, preventing accidental use of an ephemeral filesystem. The staging blueprint requires Supabase authentication (SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured as Render secrets) and one worker process. The runtime currently accepts a Supabase access token in its sign-in gate; a polished email/password and refresh-session flow remains a release blocker. Its lease-based queue supports multiple processes only when they share the same SQLite database and media volume. Do not deploy this blueprint on the free ephemeral plan for user data. Review the monthly compute and disk charge before creating the service.


## Research and implementation records

- [Public release gates](docs/PUBLIC-RELEASE-GATES.md)
- [Product integration and scale plan](docs/PRODUCT-INTEGRATION-AND-SCALE-PLAN.md)
- [Implementation status](docs/IMPLEMENTATION-STATUS.md)
- [Cross-ecosystem capability expansion](docs/CROSS-ECOSYSTEM-CAPABILITY-EXPANSION.md)
- [Expanded capability atlas](docs/EXPANDED-CAPABILITY-ATLAS.md)
- [Additional workflow research](docs/ADDITIONAL-WORKFLOW-RESEARCH.md)
- [Adapter contract](docs/ADAPTER-CONTRACT.md)
- [Original creative intelligence and innovation atlas](docs/ORIGINAL-CREATIVE-INTELLIGENCE-AND-INNOVATION-ATLAS.md)
