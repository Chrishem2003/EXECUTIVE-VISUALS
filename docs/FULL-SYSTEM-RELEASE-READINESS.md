# Executive Visuals — full-system release readiness plan

**Audit date:** 13 November 2026  
**Baseline:** current `main` includes PRs #540, #541 and #542 after the earlier PR #538 checkpoint; see `docs/IMPLEMENTATION-STATUS.md` for the authoritative merged-PR and live-deployment ledger. Main commit `e2ccf5930aae0ae67e48e908c15f7759458454ef` is live on Render; isolated D1 staging Worker version 9 is active.

This plan distinguishes code that is merged, code that has passed CI but is still on a branch, and features that cannot work end-to-end until external infrastructure and credentials exist. A passing test suite does not mean a provider, persistent store or production workflow is activated.

## 0. Mainline checkpoint — 13 November 2026

- PR #540 adds fenced D1 staging job leases (claim, heartbeat, completion and retry-safe failure). It does not connect the D1 metadata queue to the cloud-video executor.
- PR #541 exposes D1 staging job history and append-only audit events in the isolated workspace. The UI clearly reports that queued jobs are not dispatched.
- PR #542 adds an opt-in embedded mode for the existing governed cloud video worker. It is default-off; Render configuration and provider credentials were not changed. Deployment `dep-dbrndk0jo6nc73eqt2tg` is live for commit `e2ccf5930aae0ae67e48e908c15f7759458454ef`.
- Mainline CI passed full build/verification and disposable PostgreSQL integrations. Supabase Preview failed because the integration's linked remote project contains NEMA/platform migration history that is absent from this repository. Live D1 acceptance was skipped because dedicated staging credentials are not configured.
- Do not attempt migration repair, `supabase db push`, schema changes or storage setup against the linked Supabase project. It is not an isolated Executive Visuals migration target. Keep paid generation and cloud storage default-off.


- PR #470 and PR #472 are merged: waveform-cache file and directory symlink escape regression tests now run on main.
- PR #515 is merged and deployed: variable-speed audio curves now flow through the Studio inspector, timeline model, local master renderer and cloud master renderer. Local variable-speed video rendering uses the same analytic inverse source-time mapping. Exact-head CI passed all five required workflows; Render deployment `ff73eb376d92a49b1facfeba96aeb1f390a499dc` is live. Rubber Band capability remains checked at render time and unsupported workers fail closed.
- PR #522 is merged and deployed: the Asset Library includes source-hash-bound evidence submission/review, append-only audit history and a live creative dependency graph with immutable review baselines. Exact-head Quality, Release, Billing, Financial and Remediation workflows passed; Render deployment `8a8f5355d8c48fe6423f376c41d8a7b152338666` is live. Production ledger writes remain intentionally gated until an operator-confirmed persistent volume is configured; this Render Free deployment does not claim durable evidence storage.
- PR #524 is merged and deployed: the creative dependency graph now includes bounded project-scoped timeline/clip projections, preserving metadata-only defaults for ordinary timeline listings. Clip-to-asset and clip-to-timeline dependencies are visible in the graph. Exact-head Quality, Release, Billing, Financial and Remediation workflows passed; Render deployment `a541c9510573c8e9f4b0d0fd1dbe4016f3bb2019` is live.
- PR #525 is merged and deployed: Google Drive private exports now use a durable attempt ledger, reserved provider file IDs, AES-GCM-encrypted resumable session URIs, expiring lease-token fencing, bounded byte-range recovery and provider-side reconciliation for ambiguous outcomes. Dedicated unit and isolated PostgreSQL integration workflows passed alongside the full mainline build. Render deployment `220f6a6472b12263c06d79a7a0fe0e8fced5f105` is live. The feature remains opt-in pending operator-applied Supabase migrations, OAuth configuration and distinct encryption keys; production credentials and schema were not changed.
- PR #533 is merged: timeline tracks can now be moved one lane up or down through accessible editor controls. Locked-track crossings and out-of-range moves are rejected; clips and source asset references remain intact; changes persist through the existing timeline save path and are undoable/redoable. A dedicated history regression test was added. Exact-head Quality, Release Integration, Billing, Google Drive recovery, Remediation, and Financial workflows passed.
- PR #534 is merged: completed approved storyboard outputs can be assembled into a cloud timeline as ordered video clips with source asset IDs, SHA-256 checksums, approval and provider/model provenance, plus original scene/shot markers. The workflow does not launch provider jobs during assembly.
- PR #535 is merged: clip deletion history regressions verify exact restoration, redo and fail-closed behavior when the original track is locked.
- PR #536 is merged: the isolated D1 Worker role-capability test matrix verifies owner/editor/reviewer/viewer permissions, outsider denial and immediate membership revocation. All six required CI workflows passed. Live D1 membership acceptance was skipped because dedicated staging credentials are not configured; do not treat local Worker tests as live D1 acceptance.
- PR #538 is merged: isolated D1 staging now exposes project-scoped job create/list/get with idempotent replay/conflict checks and append-only project audit-event append/list. Project owners can read editor-created job/audit records; reviewers/viewers can read but cannot enqueue or append; outsiders are denied. The API returns `execution: not-dispatched`, so this is durable job metadata, not an operational queue executor. Exact-head Quality, Release Integration, Billing, Google Drive recovery, Financial and Remediation workflows all passed. The D1 live acceptance jobs were skipped because dedicated staging credentials were not configured.
- Cloudflare `executive-visuals-d1-staging` Worker version 8 is deployed and receives 100% of staging Worker traffic. Its existing D1 `DB`, `API_ORIGIN`, `APP_ORIGIN` and `nodejs_compat` settings were preserved. Render deployment for main commit `fa9e420cf4a6827affbe9d5e49866077f5a30684` is live.
- PR #468 Content Credentials trust-anchor policy and PR #469 patched Node 22.23.4 runtime are merged. The latest live application-code deployment is tracked in `docs/IMPLEMENTATION-STATUS.md`.
- The isolated D1 staging schema and Worker are deployed and bound. Seven `ev_*` tables exist; the latest recorded aggregate audit found five users, five projects and five workspace documents, with zero memberships, assets, jobs and audit events. The staging Worker exposes project, asset-metadata, member-management, revisioned workspace, project-scoped job metadata and append-only audit APIs. PR #536 local role-matrix CI and PR #538 job/audit regression coverage are merged; live role/job/audit acceptance remains pending.
- The Render same-origin D1 bridge exists in code but remains disabled unless `D1_STAGING_WORKER_URL` is explicitly configured. It is not configured on the live production service; authenticated browser acceptance is outstanding.
- Production Render Free remains on ephemeral SQLite/disk. R2 remains inactive; no durable hosted media storage is available.
- Older PRs listed below are historical branch inventory. Their mergeability and exact-head checks must be refreshed before any merge; do not infer that a previously passing workflow or old base is current.

See [Persistence and Release Blockers](PERSISTENCE-AND-RELEASE-BLOCKERS.md) for the current infrastructure boundary.

## 1. Merged and live on main

| Capability | Status | Evidence / limits |
|---|---|---|
| C2PA provenance verification and protected callback-signer adapter | Merged | PR #249; test fixtures and callback contract are verified. Production KMS/HSM, certificate trust anchors and TSA are not configured. |
| Local SQLite media transcode and timeline provenance round-trips | Merged | PR #249; local/test storage only, not proof of durable hosted storage. |
| Six-format C2PA round-trip matrix | Merged | JPEG, PNG, WebP, MP3, WAV and MP4 tested. This is not every format in the CAI SDK. |
| Asset Library Content Credentials inspection | Merged | Authenticated API and UI states are implemented; independent browser acceptance remains. |
| Project evidence ledger and creative dependency graph | Merged and live | PR #522; source SHA-256 binding, reviewer permissions, append-only SQLite audit events, immutable graph snapshots and UI. Production writes fail closed until persistent storage is operator-confirmed. |
| Account identity in app shell and Overview | Merged | PR #250; email, role, active project and sign-out navigation are visible. |
| Full-system Release readiness workspace | Merged | PR #252; in-app inventory separates merged capabilities, in-progress branches and blocked release gates. |
| Project member list and owner-only add/remove | Merged | PR #250; adds existing accounts only and does not send invitations. |

## 2. Current verified branch work
| [#254](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/254) | Expand the in-app completed-stage inventory to list all verified provenance and account milestones | Open; UI-only; exact-head CI pending. |

| PR | Scope | State / decision |
|---|---|---|
| [#251](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/251) | Supabase password recovery, verified recovery-only JWT claim, recovery rate limit, and infrastructure blocker documentation | Draft; exact-head CI #8497 passed (465 regression tests, 0 failures, build and disposable PostgreSQL integration). Not deployed because no dedicated Executive Visuals Auth project/redirect configuration is available. |
| [#247](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/247) | Reconciled C2PA, creative graph/evidence ledger and lease-fenced publication | Draft and currently conflicts with main. Its build job was still running at the last audit. Rebase/reconcile and rerun CI before review. |
| [#246](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/246) | Lease fencing, atomic media publication and cleanup outbox | Conflicts with main; build job was still running at the last audit. #247 is the consolidated reconciliation candidate. |
| [#245](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/245) | Earlier C2PA verification extraction | Overlaps with merged PR #249; do not merge as a duplicate without a deliberate diff review. |
| [#206](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/206) | Large integration branch: billing, Google Drive, provider-aware video workers, model routing and durable queues | Draft; CI passed on its recorded head. Execution flags remain default-off and provider credentials, OAuth configuration, private object storage, budget policy and merchant onboarding are external gates. |
| [#248](https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/248) | Authenticated non-billable video quote/approval ledger and workflow bridge | Draft; CI passed on its recorded head, but it targets the #206 integration branch, not main. Reconcile only after the integration base is accepted. |

## 3. Older chained feature branches

The open PR chain includes resumable uploads, byte-range downloads, job-stage telemetry, live job recovery, project activity/audit history, review notifications, frame-accurate annotations, review conversations, revision-aware feedback, audio gain/pan automation, audio mastering, delivery certification and caption packaging (PRs #130–#166 and related dependencies).

These branches are not independent mainline changes: many target one another rather than `main`. Merging them one-by-one out of order risks losing dependencies or introducing conflicts. Consolidate them into a single integration branch, rebase against current main, and run the full suite after each logical batch:
1. Upload/download and job recovery foundations.
2. Project activity, collaboration, review API and review UI.
3. Audio processing and preview/export parity.
4. Delivery profiles, AV sync and caption packaging.
5. Provider-aware workflow and quote/approval bridge.

## 4. Hard infrastructure blockers

See [Persistence and Release Blockers](PERSISTENCE-AND-RELEASE-BLOCKERS.md) for the complete observed facts. The short version:

- Render Free has ephemeral storage; local SQLite and media are lost on restart, spin-down and redeploy.
- Cloudflare D1 `executive-visuals-staging` is bound to its isolated staging Worker and has seven `ev_*` tables; it is not the production data plane and currently contains only limited staging metadata. The production edge Worker remains separate.
- Cloudflare R2 is not activated. Its free allowance is useful for a pilot, but activation requires a subscription/checkout flow and usage above free allowances is billable.
- The production Cloudflare edge Worker still has only its static `ASSETS` binding and proxies API calls to Render; the separate staging Worker has the D1 binding and restricted `/api/d1/*` routes.
- The two Supabase Free projects already contain NEMA/platform data and use the free-project allowance. They must not be repurposed for Executive Visuals.
- Cloudflare Email Sending requires Workers Paid for arbitrary-recipient transactional email; Free Email Routing is inbound/forwarding only.

## 5. Recommended execution order

### P0 — establish isolated, durable foundations
- Obtain explicit approval for a storage option: activate R2 with strict app-level quotas and overage monitoring, or select another durable object store.
- Extend the existing isolated D1 staging Worker/API toward the complete project, asset, job and audit data plane; finish live owner/editor/reviewer/viewer role acceptance. Keep production routing disabled until the full tenant-scoped migration and acceptance suite passes.
- Select a dedicated identity provider for Executive Visuals; do not change NEMA projects.
- Move hosted project, asset metadata, job state and audit records off Render's ephemeral SQLite. Keep local files as scratch only.

### P1 — complete the real media lifecycle
- Store source media and final derivatives in private object storage.
- Use resumable/multipart upload, checksum verification, HTTP range downloads, retention rules and recoverable cleanup.
- Run FFmpeg/AI jobs as scratch-only workers; inputs and outputs must be read/written through durable object storage.
- Reconcile lease-fenced claims, atomic publication and cleanup outbox onto main with current migrations and CI.

### P1 — finish user workflows
- Account recovery, email verification and invitation delivery through the dedicated identity/email provider.
- Project member management with real invitations, role changes and revocation.
- Review inbox/notifications, revision-aware comments and approvals.
- Audio/video generation, editing, upscaling and export only when the exact provider is configured and the user approves the quote/budget.
- Billing UI remains in test mode until merchant onboarding, webhook verification and real transaction acceptance are complete.

### P2 — release acceptance
- Browser/mobile end-to-end tests for sign-in, recovery, project create/edit, upload/download, timeline render, job cancellation/retry, review approval and export.
- Cross-account isolation, object privacy, signed URL expiry, token revocation, abuse/rate-limit and security tests.
- Restart/redeploy recovery, backup/restore, data export and deletion tests.
- Independent security and accessibility review.
- Only then remove preview-only warnings and claim production readiness.

## 6. Non-negotiable safety boundary

No existing NEMA Supabase project, production Render service, production Cloudflare Worker, paid plan, provider credential, merchant account or production signing key is to be modified or activated as part of this plan without explicit authorization. Default-off integrations must stay off until their dependencies and acceptance gates pass.
