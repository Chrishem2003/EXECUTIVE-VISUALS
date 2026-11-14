# Cloudflare production Worker

The production Worker is `executive-visuals` in the `chrishem.workers.dev` account subdomain.

## Source of truth

- Entry point: `cloudflare/production-worker.mjs`
- Deployment config: `wrangler.production.jsonc`
- Built static assets: `dist/`
- API origin: `https://executive-visuals.onrender.com`
- Existing D1 staging Worker remains separate: `wrangler.jsonc` and `cloudflare/worker.mjs`

The production Worker serves the Vite static application from Cloudflare and proxies `/api/*` to the verified production Render service. It does not currently move the Node API, FFmpeg rendering process, or media storage into Cloudflare.

## Automated production deployment

The repository workflow `.github/workflows/cloudflare-production-deploy.yml` builds and verifies the full app, then deploys the Worker and the freshly built `dist/` assets using Wrangler 4.160.0. It runs on relevant changes to `main` and can also be started manually. Configure the GitHub Actions repository secret `CLOUDFLARE_API_TOKEN` with a token scoped to deploy Workers and manage Worker assets for this account. If the secret is absent, the deployment job is skipped; Render deployment does not update the Cloudflare static asset bundle.

## Safe deployment boundary

1. Build and run the repository verification suite.
2. Validate the production config against the installed Wrangler version.
3. Deploy only `wrangler.production.jsonc` after the production change is explicitly approved.
4. Verify `/edge-health`, `/`, and `/api/health` from the Cloudflare workers.dev URL.
5. Confirm `/edge-health` verifies the live API dependency and reports its safe capability flags. Then confirm the API's persistence, media, queue, provider and billing capabilities. An available API is not the same as a production-ready media pipeline.

The API origin is a public service URL, not a secret. Provider credentials, OAuth secrets, signing keys and worker tokens must remain Cloudflare secrets or protected backend configuration and must never be committed here.

## Current infrastructure boundary

The production Worker has static assets and an API-origin variable. The isolated D1 staging Worker has a D1 binding and still delegates identity to the staging Render service. The Cloudflare account currently has no R2 bucket and no Queue. D1 staging is metadata-only; job creation reports `execution: not-dispatched`. Do not describe media uploads or background video execution as Cloudflare-ready until the corresponding private storage and execution bindings are provisioned and live acceptance tests pass.
