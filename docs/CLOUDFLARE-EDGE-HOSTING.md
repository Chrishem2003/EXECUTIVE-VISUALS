# Cloudflare edge hosting — Executive Visuals

## Architecture

- Cloudflare Worker `executive-visuals` serves the Vite-built SPA from Workers Static Assets.
- Same-origin `/api/*` requests require an explicitly configured `API_ORIGIN`. The repository must not default this to the production Render API. Configure only a dedicated, isolated staging API after its data store and credentials are approved.
- The backend remains responsible for Node.js APIs, FFmpeg/FFprobe, durable job workers and provider adapters. Those processes are not moved into the Workers runtime.
- The Worker validates a fixed upstream origin at runtime and does not accept arbitrary client-provided upstream URLs. If `API_ORIGIN` is absent or invalid, API requests fail closed with HTTP 502.
- API responses are not cached. Browser cookies and authorization headers are forwarded. The backend sees its own origin for its existing same-origin origin check.
- `/edge-health` verifies the edge process, not backend health. `/api/health` verifies the backend through the proxy.
- `robots.txt` and a minimal sitemap are served at the edge. The application shell is still an authenticated SPA, not a separate public marketing site.

## Deploy

The repository includes `wrangler.jsonc` and `cloudflare/worker.ts`. In Cloudflare Workers & Pages, connect the GitHub repository `Chrishem2003/EXECUTIVE-VISUALS` and configure a Workers Builds project:

- Preview branch: `integration/omni-provider-workers-2026` for static/frontend review only; API requests must remain disabled until an isolated staging backend is approved.
- Build command: `npm ci && npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`
- Worker name: `executive-visuals`

Do not point this Worker at `main` or enable automatic production releases until the edge preview has passed acceptance. Configure `API_ORIGIN` as a non-secret runtime variable only after confirming it points to an isolated staging API. Never point this preview Worker at `https://executive-visuals.onrender.com`.

## Account prerequisites

The Cloudflare account has an active `workers.dev` subdomain (`chrishem242.workers.dev`) and a deployed Worker named `executive-visuals`. R2 is not enabled yet and the R2 API previously returned Cloudflare error 10042 until it is enabled in the dashboard.

A dedicated Cloudflare D1 database named `executive-visuals-staging` was created in the EU jurisdiction as an empty isolated resource. It is not connected to the application. The current Node.js backend uses SQLite and local disk, so D1 must not be treated as a drop-in database replacement. A dedicated data-access adapter, schema migration, ownership/RLS-equivalent controls and backup/restore tests are required before using it for customer data.

## Remaining integration

1. Connect the GitHub repository in Cloudflare Workers Builds and authorize the repository.
2. Open Workers & Pages once to create the account's `workers.dev` subdomain.
3. Enable R2 in the dashboard, then create a private staging bucket and add an authenticated object-storage adapter. Do not make customer media public.
4. Add isolated D1/Postgres data access only after porting and testing the current SQLite repository semantics.
5. Test cookies, login/logout, project ownership, uploads/downloads, webhooks, provider callbacks, API streaming, health, 404/SPA routing and error handling through the edge.
6. Add a real public marketing landing page before requesting broad search indexing.

No Render service, production DNS zone, production database or customer media was modified by this Cloudflare preparation.


## Deployment result — 2026-11-07

Cloudflare GitHub authorization is now active and Workers Builds is connected to the repository. The existing Worker resource `executive-visuals` had previously been an unused Hello World placeholder (no workers.dev subdomain enabled); it was safely replaced with this application edge Worker.

- Account workers.dev subdomain: `chrishem242.workers.dev`
- Worker: `executive-visuals`
- Public URL: https://executive-visuals.chrishem242.workers.dev
- GitHub repository: `Chrishem2003/EXECUTIVE-VISUALS`
- Build branch: `integration/omni-provider-workers-2026`
- Build UUID: `ac75db88-ec36-4c76-8121-bac5b9e38db8`
- Build outcome: success
- Deployed Worker version: `684a2cf2-87e8-44b3-b66e-0ffb35d94ee9`
- Build command: `npx tsc -b && npx vite build`
- Deploy command: `npx wrangler@4.45.0 deploy`
- Static assets uploaded: index.html, CSS bundle and JS bundle.
- Workers Builds production branch is set to the integration branch and previews are disabled. The Worker is separate from Render's production service; the Worker proxy forwards API calls to the existing Render API origin.

### Live verification

- Public root: HTTP 200, page title `Executive Visuals — Creative Production Studio`.
- `/edge-health`: HTTP 200; Worker reports `status=ok` and API proxy configured.
- `/api/health`: HTTP 200 through Cloudflare proxy; backend reports `status=ok`, `authMode=supabase`, FFmpeg/FFprobe available.
- `/robots.txt`: HTTP 200.
- `/sitemap.xml`: HTTP 200.
- The first proxied health request returned Render's 503 cold-start page; after allowing the Free backend to wake, the same endpoint returned HTTP 200. This remains the Render Free sleep limitation.

### Important remaining boundaries

- The current backend health response still reports `storage=local-disk` and `database=sqlite`. Customer projects, billing, and generated media are therefore not yet on durable Cloudflare storage.
- Cloudflare D1 `executive-visuals-staging` exists in EU jurisdiction but has zero tables and is not bound to the Worker or backend. No SQLite-to-D1 repository adapter or migrations have been deployed.
- R2 is still not enabled for this account; the API returns error 10042 requiring dashboard activation. No R2 bucket exists and no customer media has been migrated.
- The Worker hosts the actual existing SPA and proxies API calls, but the current app shell is not yet a separate public marketing landing page. Search indexing and custom-domain setup remain future tasks.
- The successful Cloudflare build intentionally runs TypeScript/Vite frontend build only. Full FFmpeg/media integration and backend test suites remain in GitHub CI and the Render Node service, not in the Workers runtime.
- A first Cloudflare build against the prior configuration failed because the full application test suite tried to spawn FFmpeg in the Cloudflare build environment. The build command was corrected to frontend-only TypeScript/Vite build; the subsequent build and deployment passed.
