# Cloudflare edge hosting — Executive Visuals

## Architecture

- Cloudflare Worker `executive-visuals-edge` serves the Vite-built SPA from Workers Static Assets.
- Same-origin `/api/*` requests are streamed to the existing Render Node.js API at `https://executive-visuals.onrender.com`.
- The backend remains responsible for Node.js APIs, FFmpeg/FFprobe, durable job workers and provider adapters. Those processes are not moved into the Workers runtime.
- The Worker fixes the upstream origin in configuration; it does not accept arbitrary client-provided upstream URLs.
- API responses are not cached. Browser cookies and authorization headers are forwarded. The backend sees its own origin for its existing same-origin origin check.
- `/edge-health` verifies the edge process, not backend health. `/api/health` verifies the backend through the proxy.
- `robots.txt` and a minimal sitemap are served at the edge. The application shell is still an authenticated SPA, not a separate public marketing site.

## Deploy

The repository includes `wrangler.jsonc` and `cloudflare/worker.ts`. In Cloudflare Workers & Pages, connect the GitHub repository `Chrishem2003/EXECUTIVE-VISUALS` and configure a Workers Builds project:

- Production branch: `integration/omni-provider-workers-2026` for initial isolated validation only.
- Build command: `npm ci && npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`
- Worker name: `executive-visuals-edge`

Do not point this Worker at `main` or enable automatic production releases until the edge preview has passed acceptance. Configure `API_ORIGIN` as a non-secret runtime variable if the origin changes.

## Account prerequisites

The Cloudflare account currently has no Workers scripts and no `workers.dev` subdomain. Cloudflare's API directs the account owner to open the Workers & Pages dashboard once to provision the account subdomain. R2 is not enabled yet and the R2 API returns Cloudflare error 10042 until it is enabled in the dashboard.

A dedicated Cloudflare D1 database named `executive-visuals-staging` was created in the EU jurisdiction as an empty isolated resource. It is not connected to the application. The current Node.js backend uses SQLite and local disk, so D1 must not be treated as a drop-in database replacement. A dedicated data-access adapter, schema migration, ownership/RLS-equivalent controls and backup/restore tests are required before using it for customer data.

## Remaining integration

1. Connect the GitHub repository in Cloudflare Workers Builds and authorize the repository.
2. Open Workers & Pages once to create the account's `workers.dev` subdomain.
3. Enable R2 in the dashboard, then create a private staging bucket and add an authenticated object-storage adapter. Do not make customer media public.
4. Add isolated D1/Postgres data access only after porting and testing the current SQLite repository semantics.
5. Test cookies, login/logout, project ownership, uploads/downloads, webhooks, provider callbacks, API streaming, health, 404/SPA routing and error handling through the edge.
6. Add a real public marketing landing page before requesting broad search indexing.

No Render service, production DNS zone, production database or customer media was modified by this Cloudflare preparation.
