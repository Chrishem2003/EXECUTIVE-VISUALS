# Executive Visuals — release readiness checkpoint (2026-11-07)

## Decision

**Code candidate: CI green. Production release: blocked pending isolated staging and infrastructure prerequisites.**

The consolidated candidate is PR #206:
https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/206

- Current head at latest continuation check: `cd9974577850a4d28850301f0edcc3313bbb6141`
- Base: `main` (`18cb97bf027dc5037fc1d932f36dd4d00f6e6c67`)
- Branch comparison: 385 commits ahead, 0 behind; 128 changed files.
- Quality checks on the current head: passed.
- Google Drive integration quality on the current head: passed, including disposable PostgreSQL integration.
- No production migrations, live provider requests, Google account transfers, or payment transactions were performed.

## Confirmed deployment topology

| Role | Render service | Branch | Plan | State at audit |
|---|---|---|---|---|
| Production | `EXECUTIVE-VISUALS` | `main` | Free | Not suspended; latest observed deploy live |
| Separate testing | `EXECUTIVE-VISUALS-1` | `feat/credits` | Free | **Suspended by user** |

Production service URL: https://executive-visuals.onrender.com  
Testing service URL: https://executive-visuals-1.onrender.com

The production service has automatic deploys enabled, no configured health-check path, and no persistent disk in its current Render service details. The testing service is on an older branch and was suspended by the user on 2026-11-07 at 09:39 UTC. Do not resume it, change its branch, or trigger a deployment until the user explicitly approves staging activation.

The repository `render.yaml` describes a third service called `executive-visuals-staging`, on a different branch, with a Starter plan, a persistent disk, and a health check. It does not match either existing service. Do not apply this Blueprint automatically.

## Production runtime observations

- Production's most recent observed deployment is commit `18cb97bf027dc5037fc1d932f36dd4d00f6e6c67`, status `live`.
- The latest build log reports 378 tests passed and zero failed; the build completed and the API logged that it was listening.
- Historical production logs on 2026-11-06 contain repeated startup failures with `AUTH_MODE=local` rejected as development-only. The app requires Supabase Auth configuration in production.
- The 2026-11-07 log window shows the latest process starting at 09:40:25 UTC and receiving SIGTERM at 09:55:39 UTC. Render still reported the service as not suspended; this log alone does not establish an application crash.
- No request logs were returned for the inspected window, and external health endpoint retrieval was unavailable. Therefore end-to-end live health and authentication are not verified.

## Supabase isolation findings

The connected Supabase projects inspected read-only were:

- `Chrishem Project` (`tymqdhwomggtnsjskxuk`): contains NEMA case/audit tables, platform job tables, and an empty `ev_workspace_snapshots` table. It has no `executive_visuals` schema.
- `Chrishem Platform Staging` (`bokxljngydmqrmktofwm`): contains NEMA case/audit and platform job/quota tables. It has no `executive_visuals` schema.

Neither project is an approved isolated Executive Visuals database. The existing app README also prohibits attaching this product to another product's database. Do not apply the new Executive Visuals migrations to either project. A dedicated project or explicitly approved isolated database is required. Creating a Supabase project may incur a recurring charge and requires the user to choose/confirm the organization and cost first.

## Required acceptance gates

### A. Durable production foundation
- Select and fund durable storage/database for the production service; the current Free Render service has no persistent disk.
- Confirm backup/restore and complete an isolated restore drill.
- Configure a real health-check path and verify the live endpoint.
- Set `AUTH_MODE=supabase` only after the correct dedicated Supabase project URL, publishable key and server-only secret are configured. Never place server-side secret keys in browser code.
- Confirm no production customer data is stored only on ephemeral local disk.

### B. Dedicated isolated staging
- Obtain approval to resume or replace the currently suspended testing deployment.
- Connect it only to the dedicated Executive Visuals staging database and private storage bucket.
- Apply the source-controlled migrations to that isolated database only; verify RLS, grants, indexes, retention, and Storage access.
- Run registration/login, project ownership, upload/download, Google Drive import/export, billing sandbox, model readiness and provider worker acceptance tests.
- Keep production credentials and buckets separate from staging.

### C. Google Drive
Required server-side configuration includes:
- `GOOGLE_DRIVE_OAUTH_ENABLED`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and exact `GOOGLE_OAUTH_REDIRECT_URI`
- Independent `GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY` and `GOOGLE_DRIVE_EXPORT_SESSION_ENCRYPTION_KEY`
- `GOOGLE_PICKER_API_KEY`
- Supabase Auth, server-only storage access, private bucket and the Google Drive migration set

Complete OAuth consent, Picker selection, private import, resumable export, disconnect/revoke, and ownership-isolation tests using a non-production Google account before enabling the feature.

### D. Billing and subscriptions
The code includes customer billing, subscription and credit-ledger foundations, but payment acceptance is not live-tested. Before enabling:
- Complete merchant onboarding and approve the selected payment environment.
- Configure server-only Dodo API/webhook credentials, per-plan product IDs and public return URL.
- Verify webhook signature validation, replay handling, subscription state transitions, refunds/cancellations, idempotency, credit grants/deductions and reconciliation in sandbox.
- Verify model-specific provider costs, currency conversion, payment fees, credit-pack pricing and target margin.
- Keep checkout and paid generation disabled until these tests pass.

### E. Models and video workers
- FAL: configure one exact endpoint, server-only API/billing credentials, private input resolver, private output ingestion and a narrow output-host allowlist; test billed-event reconciliation in staging.
- Runway: adapter profiles are integrated, but the direct task API returns estimated task cost; organization usage is aggregate by model/day. Enterprise linked-workspace reporting is a separate scope and must not be treated as task-level settlement for direct API jobs. Keep durable paid Runway execution disabled until task-correlated actual-cost evidence and refunds/cancellations are reconciled.
- Gemini Omni: keep disabled until the application supplies explicit approval, authenticated owner/project authorization, private-input planning and retention/deletion execution.
- Keep all remote worker flags false by default and test with low-cost sandbox caps.

## Release rule

Do not convert PR #206 from draft, merge it to `main`, apply migrations to either existing Supabase project, resume the suspended testing service, alter Render environment variables, or enable paid providers until the isolated staging acceptance gates and required credentials are confirmed. Because production auto-deploys from `main`, merging this PR would trigger a production deployment.

This checkpoint is intentionally conservative: the implementation is pushed and automated tests are green, but staging acceptance, durable data infrastructure, live credentials and real transaction verification are not complete.


## Live health recheck — 2026-11-07

A fresh public request to `https://executive-visuals.onrender.com/api/health` first received Render's `503 Application loading` response, then returned HTTP 200 after allowing the Free instance to wake. The successful health payload reported:

- `status: ok`
- `authMode: supabase`
- `storage: local-disk`
- `database: sqlite`
- FFmpeg and FFprobe available
- image and text gateways disabled and unconfigured

This confirms the earlier `AUTH_MODE=local` failures are historical; the current health response reports Supabase auth mode. It does **not** prove end-to-end user sign-in. More importantly, the live service is still using local-disk/SQLite storage, with no persistent disk in Render service metadata. The 503-to-200 wake-up behavior is consistent with a sleeping Free instance and is not itself evidence of an application defect. A reliable production release still requires durable database/media storage, backup/restore verification and a configured health-check path.


## Billing persistence boundary

The current billing and Dodo subscription repositories create their ledger/account/subscription tables in the application's SQLite database. The live production health endpoint confirms `database=sqlite` and `storage=local-disk`. Therefore, the billing UI and webhook/credit logic are code-integrated, but they are not yet backed by an independently durable managed database. A persistent Render disk could preserve the SQLite database for a single-instance deployment, but requires a paid service configuration and backup/restore plan. A dedicated Postgres implementation would require a separately designed and tested repository/migration path. Do not accept real customer payments or sell credit balances until the selected durable persistence path is in place and verified.


## Continuation update — 2026-11-07 13:57 UTC

The latest isolated implementation work on PR #206 includes:

- Runway GPT Image 2.6 Flare/Sunburst execution adapter, strict input validation and published-price estimation.
- Runway Kling 4.0 Flash and Gemini Omni 1.2 Flash video profiles; Gemini native-audio capability is now represented accurately.
- Billing reservations now use the model-specific published Runway image/video price estimator when platform credit value and markup are configured. These remain **preflight estimates**, not actual provider settlement or task-correlated invoices.
- CI on head `47f5d92606971930c3f2e2fc161a744d92e916b4`: Quality Checks passed; Google Drive Integration Quality passed; PostgreSQL integration passed.

### Cloudflare edge isolation correction

A read-only Cloudflare API inspection confirmed that Worker `executive-visuals` is built from `integration/omni-provider-workers-2026` with previews disabled. The latest deployed version observed at 2026-11-07 13:54 UTC is `97936ed8-e869-4c9f-9540-bfb6fb141f92`. Its only binding is `ASSETS`; `API_ORIGIN` is absent. Thus `/api/*` fails closed rather than proxying to Render production. The repository's `wrangler.jsonc` no longer defaults `API_ORIGIN` to the production Render URL.

Because the integration branch is the Workers Builds production branch, future changes to Worker-relevant files on this branch may publish another edge version. This is a separate Cloudflare Worker deployment, not a Render production deployment. Do not add an API origin until an isolated staging backend exists.

### Current release decision

PR #206 remains open and draft. Do not merge it: Render production auto-deploys from `main`, the branch is 376 commits ahead, and the candidate still lacks isolated staging acceptance, durable database/media storage, backup/restore verification, payment sandbox acceptance, and actual provider-cost reconciliation. The separate Render testing service remains suspended. No Render service configuration, production database, production credentials, or paid provider request was changed during this continuation.

## Continuation update — 2026-11-07 14:03 UTC

- Latest PR #206 head: `cd9974577850a4d28850301f0edcc3313bbb6141`; 385 commits ahead of `main`, 0 behind; 128 changed files.
- Quality Checks passed on this exact head.
- Google Drive Integration Quality passed on this exact head, including disposable PostgreSQL integration.
- Added a read-only Runway daily-usage reconciliation module and CLI. It compares Runway's organization-level daily model/API-key usage totals with local platform generation-spend estimates. It deliberately reports variance only and marks every row `settlementEligible=false`; it cannot settle individual customer jobs because the direct API usage endpoint is not task-correlated.
- The new CLI uses the existing SQLite billing ledger in read-only mode and makes one bounded organization-usage request. It does not mutate balances, refunds, provider settings, or deployment resources.

The release decision remains **blocked** for the same infrastructure and financial reasons above. The Cloudflare Worker remains a separate static/frontend preview with no `API_ORIGIN`; the Render production backend remains on `main` and has not been modified.

## Continuation update — 2026-11-07 14:16 UTC

- Current PR #206 head: `2dab5068f4529c86d9183b5b072e0c6679bd183f`; 399 commits ahead of `main`, 0 behind; 133 changed files.
- Quality Checks passed on this exact head: dependency install, TypeScript typecheck, production build and the complete regression suite.
- Google Drive Integration Quality passed on this exact head, including disposable PostgreSQL integration. The complete suite reported 763 tests passed and 0 failed.
- Implemented multi-image generation for the OpenAI-compatible image gateway: `outputCount` 1–4 is sent as the OpenAI Images API `n` parameter; response cardinality and every base64 image payload are validated.
- The workflow image node persists each variation as a separate private asset. The original single `image` output remains backward-compatible; a new multi-value `images` asset output can feed the existing Batch Inputs node for downstream fan-out. Reference inputs are now normalized across singular and plural workflow port IDs.
- Runway direct image tasks remain single-output in this adapter; its catalog was corrected to reflect that. The separately documented Runway Model Router can accept 1–4 outputs but requires a saved router config and has not been substituted implicitly. Gemini and FAL remain single-output until their adapters are verified.
- No paid provider generation was run. No Render production service, production database, Cloudflare API origin, R2 bucket, or production credential was changed.

The release remains blocked pending isolated staging acceptance, durable private storage and backup/restore verification, payment sandbox acceptance, and task-correlated provider-cost settlement. Keep PR #206 as draft; do not merge this 399-commit integration candidate into production.
