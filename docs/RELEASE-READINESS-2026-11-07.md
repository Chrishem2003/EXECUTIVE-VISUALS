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

## Continuation update — 2026-11-07 14:28 UTC

- PR #206 remains open and draft. Its current integration head is `7936afb560dde982325b28bae42dc3f80fb6e9ef`; it is 414 commits ahead of `main`, 0 behind, with 133 changed files. Do not merge this broad integration candidate into production.
- Quality Checks passed on this exact code head: dependency installation, TypeScript typecheck, production build, and full regression suite. Google Drive integration quality passed, including disposable PostgreSQL integration. The full suite reported 768 tests passed and 0 failed.
- Added an opt-in Runway Model Router image adapter using the documented `POST /v1/generate/image` endpoint. It requires a saved config slug and explicit server-side enablement; the adapter performs a non-billable dry-run quote before customer-credit reservation and paid task submission.
- Runway routed image output is limited to 1–4 variations by this workflow (the provider API permits a larger maximum). It validates the route metadata, estimated credit amount, output cardinality, private reference payload sizes, and downloaded PNG signatures. Each variation is saved as its own private application asset and is exposed through the existing multi-value `images` output for Batch Inputs fan-out.
- Routed Runway billing uses the dry-run estimated credits with configured platform markup and requires `BILLING_CREDIT_VALUE_MICROS` when billing enforcement is active. Task-level actual credits are captured in the adapter result; task-correlated settlement/refund reconciliation remains a release gate, so the estimate is not claimed as final provider settlement.
- Added provider catalog discovery, workflow inspector guidance, environment examples, documentation, and tests for route preflight, task execution, output count, reference limits, provider opt-in, and billing estimate conversion.
- No paid provider generation was run. No Render production service, production database, production credentials, Cloudflare API origin, or R2 bucket was changed.

The release remains blocked pending isolated staging acceptance, durable private storage and backup/restore verification, payment sandbox acceptance, end-to-end task-correlated provider-cost settlement, and full production smoke tests. Keep PR #206 as draft and keep production untouched.

## Continuation update — 2026-11-07 (Runway routed video)

- Integrated the existing Runway Model Router video adapter into the opt-in Supabase-backed hosted worker composition. It requires an explicit saved config slug and server-side remote gates; the environment example keeps it disabled.
- Added a synthetic `runway:model-router` capability entry, plus queue-side gate validation and an explicit approved USD budget ceiling. The queue does not invent a provider price for this dynamic route.
- The worker now runs the provider's non-billable dry-run before the paid POST, checks the returned USD estimate against the job's approved reservation, and stores compact quote evidence in the durable submission ledger. Rejected quotes are quarantined before provider submission.
- Extended owner/project-scoped source asset preparation for private image and video references, and mapped normalized audio mode and provider-default resolution into the router request.
- Added tests for worker registration, queue gating, budget ceiling, dry-run ordering, quote rejection, registry state, and private reference resolution.
- This is not yet a complete customer-facing purchase flow: a pre-approval quote endpoint that binds prepared-input hash, quote expiry and explicit user approval remains outstanding. Audio-reference, source-video edit/extend and user-facing router config management remain unsupported. No paid API requests were made and all production gates remain off.

## Verification update — 2026-11-07 (typed Runway reference media)

- Extended the provider-neutral video contract to preserve and validate typed image, video and audio reference asset IDs. Model-specific reference-count limits are enforced at capability validation rather than globally restricting other providers.
- Runway Model Router now supports one owner/project-scoped reference-audio asset in addition to up to four images and two reference videos. The worker resolves each asset to a short-lived signed URL, validates its media type and stored size, and passes only the supported URI/role shape to Runway.
- Reference-audio mode fails closed unless exactly one authorized audio asset is present. The registry now exposes the matching capability and count limits.
- CI on commit `ba0ef47e99e96f8d14aed8ff3110ac7de230745e`: typecheck passed, build and 782/782 regression tests passed, Google Drive integration suite passed, and disposable PostgreSQL integration passed.
- The integration branch remains 454 commits ahead of main and zero commits behind; PR #206 remains draft. The route remains disabled by default and no paid provider generation or production mutation was performed.
- Still outstanding: customer-facing pre-approval quote endpoint binding the exact prepared input hash and quote expiry to explicit approval; task-correlated provider-cost settlement/refund UX; source-video edit/extend through Model Router; user-facing router configuration; isolated staging acceptance and full production smoke tests.

## Reverse-engineering finding — interactive video path is not yet unified

A read-only trace of the application UI and backend found two separate video execution paths:

- The interactive Video Studio builds a local `video.generate` workflow with a human approval node. `server/workflow-executor.mjs` then calls the legacy synchronous `generateRunwayVideo` / `generateFalVideo` gateways and writes the result into the local SQLite media library.
- The newer provider-aware hosted worker uses the Supabase queue, durable submission ledger, approved budget reservation, owner/project-scoped private assets and asynchronous provider polling. It is not currently invoked by the interactive workflow route; no customer-facing cloud video enqueue or quote endpoint is present in `server/index.mjs`.

This is now a P0 release blocker, not a cosmetic follow-up. Build an authenticated application bridge and customer quote/approval API before enabling or selling the hosted Model Router. The bridge must preserve the user's identity and project scope, use a single durable asset identity visible to downstream editing nodes, and never silently fall back to legacy local generation.

## Deployment boundary — read-only Render inspection

- The live `EXECUTIVE-VISUALS` service tracks `main`; its latest live deployment is commit `18cb97bf027dc5037fc1d932f36dd4d00f6e6c67`.
- The separate `EXECUTIVE-VISUALS-1` test service tracks `feat/credits` and is suspended.
- PR #206's integration branch is not attached to either service. It has not been deployed to isolated staging.
- No Render settings, production service, test service, database, secrets or storage were changed during this inspection.

Therefore, CI passing does not constitute staging acceptance or production readiness. Keep PR #206 draft and all remote generation gates disabled until a separate active staging target is authorized and the bridge is end-to-end verified.

## Runway Model Router source-video capability — implementation checkpoint

- Added `video-to-video` to the Model Router's accepted operations.
- Source videos are resolved from private owner/project-scoped assets, represented as Runway `referenceVideos` with exactly one `source` role; one distinct additional reference video is supported.
- Enqueue validates server-probed source metadata and the approved rounded-up duration before queue insertion.
- Adapter validates exactly one source video for this operation and rejects source role in text/image generation.
- No paid provider task was submitted. The route remains disabled behind existing remote/worker/config gates.
- This is routed source-video editing. Specific edit/extend behavior is model-dependent and described in the prompt; it is not a guarantee that every router model supports every operation.

## Latest CI verification — source-inclusive media limits

- Latest integration commit: `86a68d1944fa7da0377ba303b1c7d3e40322e712`.
- Quality checks: typecheck passed, build passed, 786/786 tests passed, zero failures.
- Google Drive integration build and disposable PostgreSQL integration passed.
- Runway Router source video plus at most one additional reference is enforced at contract, resolver, enqueue and adapter boundaries.
- PR #206 remains draft; branch is 469 commits ahead of main and 0 behind.
- Production and suspended test Render services remain unchanged; this branch is not deployed.


## Live continuation recheck — 2026-11-07 21:20 EAT

This addendum supersedes the earlier head and branch-size figures above.

### Current GitHub state

- PR #206 remains open, draft, and unmerged.
- Integration branch: `integration/omni-provider-workers-2026`.
- Current head after the documentation refresh: `f6545a43eea1f4e549eff3d07414326ca4159275`.
- Base `main`: `18cb97bf027dc5037fc1d932f36dd4d00f6e6c67`.
- Branch comparison: 484 commits ahead, 0 behind; 134 changed files.
- The immediately preceding code head `f61f4990231d456e3d9ae3be5ac68305d17e28aa` had both Quality Checks and Google Drive integration quality completed successfully.
- The current head is a documentation-only refresh. Its Quality Checks and Google Drive integration quality runs were observed in progress at this checkpoint; do not report them as passed until their exact-head conclusions are available.

### Additional source-level P0 confirmation

A fresh read-only inspection of the current branch confirms the Studio/cloud execution paths are still separate:

- `server/index.mjs` contains no cloud-video quote/enqueue API route or provider-aware worker composition wiring.
- `server/workflow-executor.mjs` still imports and invokes the legacy synchronous `generateRunwayVideo` / `generateFalVideo` gateways for the interactive `video.generate` node, then stores the generated result through the local generated-assets/SQLite path.
- `server/cloud-video-provider-worker-composition.mjs` constructs a separate opt-in Supabase-backed queue, submission ledger, budget-enforced enqueue service, provider adapters, and private output ingestion. It is not called by the interactive Studio execution route.

This confirms that a green worker test suite does not establish that a customer can safely use hosted generation from Video Studio. The P0 bridge must be implemented before hosted generation is offered as a paid customer feature. It must not silently fall back to local synchronous provider calls.

### Current model-catalogue guard

The latest code head adds evidence-backed metadata for Kling 4.0 Flash and Gemini Omni 1.2 Flash. Both remain disabled with `executionAdapter: not_implemented`; regression tests assert they are not selectable. The SQL enqueue migration still allows only the existing exact `runway/gen4.5` and `google/gemini-omni-1.1-flash` identities. No new model should be enabled until adapter, exact quote/approval, SQL policy, private media and settlement contracts agree.

The detailed current model/SQL parity findings are appended to `docs/VIDEO-MODEL-PARITY-AUDIT-2026-11-07.md`.

### Immediate engineering sequence

1. Add authenticated quote and enqueue endpoints in the application API, with verified user/project write access and strict request normalization.
2. Bind a short-lived quote to a canonical hash of prompt, model, operation, duration, references, settings, owner and project; require explicit approval of that exact quote.
3. Atomically reserve platform credits and provider budget, enqueue idempotently to the durable queue, and return a job ID for Studio polling.
4. Publish only private asset IDs after output ingestion; ensure downstream workflow nodes can resolve the same durable asset identity.
5. Add PostgreSQL integration and end-to-end API tests for ownership isolation, replay, expiry, changed-input rejection, duplicate/ambiguous provider submission, cancellation, refunds, settlement, worker restart and partial output failure.
6. Keep the current legacy local workflow available only under its existing explicit development/local configuration; never use it as a hosted fallback.

### Release decision

No staging service was resumed, no production or shared Supabase database was modified, no R2 resource was enabled, no paid provider request was made, and no production deployment or merge was performed. PR #206 remains draft. Production release and paid hosted generation remain blocked pending the P0 bridge, isolated durable infrastructure, exact financial reconciliation and explicit staging acceptance.


## Continuation checkpoint — 2026-11-07 (latest live recheck)

### GitHub and CI

- PR #206: open, draft, unmerged.
- Exact PR head: `95bfd412b2d5440b07e029a5e7f01739017f60a3`.
- Current PR size: 485 commits, 134 changed files.
- Exact-head GitHub Actions: **Quality checks passed**; **Google Drive integration quality passed**, including the disposable PostgreSQL integration job.
- This establishes CI success only. It does not establish isolated staging acceptance, production readiness, or end-to-end customer usability.

### P0 tracked

Created issue [#209 — Connect Video Studio to the governed cloud video execution pipeline](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/issues/209).

The issue records the required authenticated Studio-to-worker bridge, request-hash-bound quote and approval, atomic credit/provider-budget reservation, idempotent durable enqueue, private output asset identity, actual-cost settlement, replay protection, tenant isolation, cancellation/refund and integration acceptance criteria.

### Source-level confirmation at exact PR head

- `server/workflow-executor.mjs` still invokes the legacy synchronous Runway/FAL gateways from interactive `video.generate` nodes.
- `server/index.mjs` has no customer-facing cloud-video quote/enqueue route.
- The provider-aware Supabase cloud worker remains a separate opt-in execution path.
- Therefore issue #209 remains a P0 release blocker. Do not enable hosted generation or describe the interactive Studio path as connected until this is implemented and verified.

### Competitive product direction

Current Runway workspace documentation highlights isolated workspace assets/credits, shared pools, member roles and separate billing boundaries. Its credits documentation explains usage-based generation costs and top-ups. Runway's August 20, 2026 enterprise update describes competition shifting from model leadership toward intuitive workflow products, editing, collaboration, integrations and efficient delivery. Adobe's June 2026 creative-work research emphasizes the value of human direction, selection, collaboration and accountable final output.

Implications for Executive Visuals:
1. Sell end-to-end outcomes and dependable editing/delivery, not model count alone.
2. Make costs, quotes, approvals and actual usage transparent before and after generation.
3. Build collaboration around project-level private assets, reviewer approvals, brand consistency and durable delivery.
4. Differentiate through reusable production workflows, continuity, traceability, provenance and export reliability.

References:
- Runway workspaces: https://help.runwayml.com/hc/en-us/articles/26120892253843-Introduction-to-Workspaces
- Runway credits: https://help.runwayml.com/hc/en-us/articles/15124877443219-How-do-credits-work
- Runway enterprise direction (August 20, 2026): https://runway.com/news/company-news%2Fthe-next-phase-of-enterprise-video-generation
- Adobe creative-work research (June 2026): https://www.adobe.com/ai/research/202606/ai-is-redistributing-creative-work.html

### Boundaries

No production merge/deploy, paid provider generation, billing transaction, production/shared database migration, suspended Render service activation or R2 enablement was performed. PR #206 remains draft.
