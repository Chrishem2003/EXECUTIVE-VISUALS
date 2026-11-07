# Public release gates

**Current decision: NOT APPROVED for public customer workloads or paid production use.**  
**Last reviewed:** 7 November 2026  
**Candidate:** `integration/omni-provider-workers-2026` / draft PR #206  
**Purpose:** distinguish source-code progress, staging readiness and production authorization.

A green build is necessary, not sufficient. This document records the current evidence and prevents a staging preview or implemented adapter from being mistaken for a production-ready service.

## Current evidence

| Gate | Status | Evidence / remaining work |
|---|---|---|
| Source quality | Passed on several recorded exact commits; current head still needs fresh verification | Quality and Google Drive integration workflows passed for commit `86a68d1944fa7da0377ba303b1c7d3e40322e712`. Later workflow runs for commits `5c75dc165eefbb9dd3d5a21456075c5095bb8828` and `eb305460dcaa0c4be6279f7d1b9131179f3a8d7b` were cancelled. Re-run both required workflows on the exact current PR head before accepting the candidate. |
| Hosted authentication | Source implementation advanced; hosted acceptance incomplete | Supabase sign-in/registration work exists on the integration branch. Verify email confirmation, refresh/session expiry, logout, recovery, abuse controls, cookie/token handling and owner/editor/reviewer/viewer isolation against a dedicated staging identity project. |
| Isolated application database | Blocked | The connected Supabase projects contain unrelated NEMA/shared-platform data and do not provide an approved isolated `executive_visuals` schema. Provision and review a dedicated project before applying any application migration. |
| Durable private media | Blocked for production | The production health evidence reports `storage=local-disk` and `database=sqlite`; production is on Render Free without a persistent disk. The cloud asset adapters are not proof that the active production asset lifecycle uses private object storage. R2 is not enabled. |
| Cloud queue and workers | Source foundation exists; hosted runtime unverified | Provider-aware video, media and timeline worker components exist behind explicit gates. They are not proof that the production application is connected to a durable Postgres queue and worker fleet. Complete the Studio workflow bridge in issue #209 and test worker recovery on isolated infrastructure. |
| General Video Studio execution | Blocked | The interactive workflow executor still has a legacy synchronous path. The cloud transformation lane supports a narrower approved Aleph 2 operation; it is not yet the general quote/approval/enqueue/status/output bridge for supported workflow nodes. |
| Billing and subscriptions | Source foundation exists; live acceptance blocked | Billing, credit ledger and webhook reconciliation code are present in the candidate. Merchant onboarding, live transaction acceptance, durable billing persistence and refund/cancellation reconciliation must be verified. Do not accept customer payments while production billing relies on non-durable SQLite/local disk. |
| Provider readiness | Opt-in adapters exist; customer execution remains gated | A configured key or catalogue entry is not proof of a live adapter. Require exact model capability tests, authoritative pricing, quote-bound approval, hard spend ceilings, actual-cost settlement, private output ingestion and cancellation/reconciliation tests. CI must never make paid calls. |
| Cloudflare edge preview | Staging preview only | The Workers frontend/API proxy is live, but its upstream is the existing Render API. The preview does not solve backend durability, isolated identity, database, media storage or worker hosting. D1 is not connected; R2 is unavailable until enabled by the account owner. |
| Backup and restore | Blocked | No accepted backup-and-restore rehearsal for the active production database and media store is recorded. |
| Monitoring and incident response | Incomplete | Add application-specific metrics/alerts, request and job correlation, redaction, bounded log retention, capacity limits, incident runbook and tested rollback. |
| User acceptance | Not run | Run hosted tests with distinct roles and real media: registration, project isolation, upload/download, queue, cancellation, media processing, timeline render, review, export, session expiry and recovery. |

## Mandatory delivery sequence

1. **Finish P0 workflow bridge (#209).** Reuse the existing queue, submission ledger, budget controls, approval records, provider adapters and private output ingestion. Do not create a second queue or ledger.
2. Define a supported-node contract for exact provider/model/operation/input combinations. Unsupported combinations must fail closed; hosted execution must not silently fall back to legacy synchronous generation.
3. Implement a non-billable quote bound to the canonical request hash, owner, project, assets, provider/model, pricing evidence, currency, limits and expiry. Require explicit approval of that exact quote.
4. Atomically reserve customer credits/provider budget and enqueue idempotently. Map durable job state, progress, cancellation and output asset IDs back to workflow runs and nodes.
5. Reconcile actual provider spend separately from estimates/reservations. Handle ambiguous submissions, retries, cancellation, partial outputs, refunds and duplicate settlement idempotently.
6. Complete the active private asset lifecycle and durable database/queue on a dedicated isolated project. Verify RLS, storage policy, signed URL expiry, quotas, checksums and cross-tenant denial.
7. Complete hosted authentication, session lifecycle, role isolation, operational monitoring, backup/restore and rollback tests.
8. Run full CI on the exact current PR head, then hosted end-to-end acceptance using non-production accounts and test media.
9. Review the client production layer (#210): project budgets/caps, brand kits, version-bound review comments, reusable workflow apps and editor handoff. Keep external publishing behind explicit human approval.
10. Obtain explicit owner approval for recurring infrastructure and provider costs before any paid service activation or production promotion.

## Competitive product acceptance

Current official market signals support prioritizing the end-to-end production experience over model count:

- Runway's October 2026 updates include reusable App Studio experiences, campaign/ad variants, project credit caps and shared brand context.
- Runway's team offering emphasizes shared projects/assets, frame-accurate feedback and pooled usage.
- Runway Workflows emphasize reusable, multi-step pipelines that connect model outputs directly to downstream inputs.

Primary sources:
- https://runway.com/changelog
- https://runway.com/team-plan
- https://runway.com/workflows

Product response:
- A customer can turn an approved brief and brand kit into a reusable, versioned production workflow/app.
- Each paid action shows an estimate and remaining project budget before dispatch; execution pauses at the hard cap.
- Review comments remain attached to exact asset/timeline versions and timecodes; approvals bind to the reviewed output.
- Deliverables include stable asset IDs, checksums, codec/duration metadata, captions and a reproducible delivery manifest.
- External publishing and paid provider calls require named-user approval.

## Deployment and safety boundaries

- PR #206 remains a draft integration candidate. Do not merge it into `main`; production auto-deploys from `main`.
- Do not resume or modify the suspended Render testing service without explicit approval.
- Do not apply these migrations to either connected NEMA/shared-platform Supabase project.
- Do not enable R2, provision paid infrastructure, or change Render production settings without explicit approval.
- Keep provider/worker remote-execution flags disabled by default. Never expose service-role or provider credentials to browser code.
- Preserve originals; derivatives must have immutable checksums and source lineage.
- Do not claim neural upscaling, model availability, perceptual quality or provider readiness without verified inference and recorded evidence.
- A Cloudflare edge preview, green CI run, source adapter, or healthy process does not by itself authorize public release.

## Approval rule

Public release requires all mandatory gates above to pass on the exact release candidate, dedicated isolated identity/database/storage, tested durable worker execution, normal customer authentication, verified billing and provider controls, backup/restore, hosted user acceptance, rollback readiness and explicit owner approval of recurring costs.
