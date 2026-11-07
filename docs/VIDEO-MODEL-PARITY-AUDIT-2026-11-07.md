# Video model parity and hosted execution gap audit — 2026-11-07

**Scope:** read-only reverse engineering of the current `integration/omni-provider-workers-2026` candidate and current provider documentation.  
**Status:** audit complete; implementation gates remain disabled.

## Verified repository state

- Consolidated candidate: PR #206, still draft and unmerged.
- Current reviewed head: `c09127f905f3ce00dc499c6262f6964a76e46fd5`.
- Current-head GitHub Actions: Quality checks #7587 passed; Google Drive integration quality #437 passed.
- These CI results prove the tested code path, not live provider execution, isolated staging acceptance, durable storage, or production readiness.

## Material capability gaps

### 1. Kling 4.0 Flash is described more broadly than it executes

The provider catalogue lists Kling 4.0 Flash with text/image/video and Omni-reference capabilities, but its execution adapter is `not_implemented`. The legacy Runway gateway only implements text-to-video and a single first-frame image input for this profile; its own capability response reports no reference-image collection, reference-video, or video-to-video support.

Kling's 4.0 Flash API update documents 3–20 second 720p generation, text-to-video, image-to-video, and Omni reference-to-video. The Omni path supports up to 10 reference images, 5 reference videos, and 15 combined inputs. The model should remain unavailable until a dedicated adapter maps those inputs to private, owner-scoped assets, validates exact request combinations, records the provider task ID before polling, ingests every output privately, and reconciles actual billing.

Official references:
- https://kling.ai/document-api/updates/api?date=2026-02-11
- https://kling.ai/dev/api

### 2. Gemini Omni 1.2 is catalogued but not connected to the hosted worker

The provider catalogue marks `gemini_omni_flash_1.2` as disabled with `executionAdapter: not_implemented`. The current cloud enqueue gate still recognises the older `gemini-omni-1.1-flash` model identifier. The legacy gateway profile for 1.2 is not equivalent to a production-ready Interactions API adapter.

Google announced Gemini Omni 1.2 Flash generally available on November 5, 2026. It supports native 3–15 second video, multi-turn conversational editing, stronger image/video/audio reference adherence, and 360p/720p drafts with 1080p/4K finishing. Google lists 720p generation at $0.07/second. Implement the 1.2 model as a separately versioned adapter with interaction lineage, explicit retention/deletion, private input planning, private output ingestion, model-specific pricing and actual-cost reconciliation. Do not silently alias 1.2 to the 1.1 adapter.

Official references:
- https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-omni-1-2-flash/
- https://deepmind.google/models/model-cards/gemini-omni-1-2-flash/
- https://ai.google.dev/gemini-api/docs/video

### 3. The interactive Video Studio still bypasses the durable provider worker

The UI workflow executor remains on the legacy synchronous Runway/FAL path and local SQLite media library. The Supabase-backed provider worker, submission ledger, budget reservation and private output ingestion form a separate execution path. The application API does not yet provide the authenticated customer quote/approval/enqueue bridge that joins them.

This is a P0 architecture blocker. Implement a server-side bridge that:
1. Authenticates the current user and checks project write access.
2. Normalizes the complete request and resolves every input asset under owner/project scope.
3. Produces a non-billable provider quote and stores a canonical request hash, expiry, model/config identity, estimated provider ceiling and platform-credit reservation.
4. Binds explicit approval to that exact hash and expiry; any changed prompt, asset, model, output count or setting invalidates approval.
5. Atomically reserves credits and enqueues the durable job with idempotency.
6. Returns a job identity the existing Studio can poll; completion publishes private asset IDs usable by downstream editing nodes.
7. Never falls back silently to local synchronous generation if the hosted path fails.

No live generation should be enabled until this bridge has end-to-end tests for ownership, replay, quote expiry, changed-input rejection, ambiguous provider submission, cancellation, refunds and settlement.

### 4. Multi-output and cost settlement remain separate gates

The current provider-aware video worker is documented as returning one MP4 output. Add provider-specific output cardinality and bounded fan-out only after each provider's response contract is verified. Persist each output independently with checksum, ownership, source lineage and per-output validation.

Keep estimate, reservation and actual settlement distinct:
- A dry-run quote is a reservation ceiling, not a provider charge.
- A submission estimate is not actual usage.
- A completed task's authoritative cost or provider-correlated usage event is required for settlement.
- Ambiguous submissions must be reconciled before retry; do not risk duplicate paid tasks.
- Refunds/cancellations must follow the provider's actual billing outcome.

Runway's Model Router documentation explicitly distinguishes dry-run routing metadata from a live task and returns routing/model/cost evidence. Preserve that evidence with the durable task record:
- https://docs.dev.runwayml.com/model-routers/generating/
- https://docs.dev.runwayml.com/guides/pricing/

## Infrastructure and release boundaries

- Production auto-deploys from `main`; PR #206 must remain draft until all release gates are accepted.
- The separate Render test service is suspended. Do not resume it or change its branch without explicit approval.
- Production currently reports SQLite/local-disk storage and has no persistent disk. Do not accept paid customer balances or payments until durable persistence and backup/restore are verified.
- The connected Supabase projects are shared with other products and are not approved Executive Visuals databases. Do not apply Executive Visuals migrations to them.
- Cloudflare R2 is not enabled. Do not create or enable R2 resources or incur paid infrastructure costs; the user plans to revisit this after payment access is restored.
- Keep all provider remote-execution flags false by default. No provider request, paid generation, production migration, production deployment or credential change is authorized by this audit.

## Recommended implementation order

1. **P0 — Hosted Studio bridge:** quote → exact-input approval → reservation → enqueue → job status → private output asset.
2. **P0 — Durable storage and isolated staging:** dedicated database/private object storage, migrations/RLS, backup/restore, health checks, and explicit approval to activate a staging target.
3. **P0 — Financial integrity:** task-correlated settlement, refund/cancellation reconciliation, ambiguous-submission operations, margin and abuse limits.
4. **P1 — Provider parity:** dedicated Kling 4.0 Flash Omni adapter; Gemini Omni 1.2 Interactions adapter and retention lifecycle.
5. **P1 — Video fan-out:** multi-output task contract, per-output private ingestion, batch workflow fan-out and partial-failure recovery.
6. **P1 — Commercial polish:** clear model capability/availability labels, quote transparency, job progress, failure recovery, credit history, project asset lineage and accessible mobile layouts.

**Release decision:** the code candidate has green automated checks on its reviewed head, but hosted generation is not yet a sellable end-to-end feature. Keep PR #206 draft and production untouched until the gates above are implemented and accepted.


### 5. Application enqueue validation and SQL enqueue policy are not aligned

A source-level contract comparison found a separate runtime blocker:

- `server/cloud-video-enqueue.mjs` accepts the gated Runway Model Router path and recognizes Runway Aleph2, Magnific video upscaling, and Ruby HDR operations.
- The source-controlled `20261104143000_cloud_video_budget_enqueue.sql` function currently permits only `runway/gen4.5` and `google/gemini-omni-1.1-flash`.
- The same SQL function applies fixed duration/reservation rules only for those two models.

Therefore, enabling an application-level adapter flag does not make the corresponding model enqueueable: Postgres rejects the job with `VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED` (or the fixed pricing guard). Do not loosen the SQL allowlist generically. Align each model's exact operation, input limits, quote source, currency, approved reservation ceiling, and settlement evidence in one reviewed migration plus contract tests. Until then, surface these model profiles as unavailable for hosted execution.


## Official API research refresh — 2026-11-07

The following details were rechecked against vendor-owned sources and should drive adapter contracts rather than third-party model roundups.

### Kling

- **Kling 4.0 Flash:** 3–20 seconds, 720p; text-to-video, single-first-frame image-to-video, and Omni reference-to-video endpoints. Its Omni endpoint accepts up to 10 reference images and 5 reference videos, with up to 15 combined inputs. Billing depends on total duration, including supplied reference/source video duration.
- **Kling 4.0 (non-Flash):** up to 30 seconds, 720p/1080p, up to 10 keyframes, plus Omni reference-to-video. Do not mix its duration/resolution/price contract with Flash.
- The adapter must distinguish the three endpoint modes, reject invalid mixed input sets before provider submission, and calculate a quote using provider-defined billable input plus output duration.

Official sources:
- https://kling.ai/document-api/updates/api?date=2026-02-11
- https://kling.ai/dev/api

### Gemini Omni

- Google officially announced **Gemini Omni 1.2 Flash** on November 5, 2026. It is generally available through the Gemini API and Google business offerings.
- Native output is 3–15 seconds in one-second increments. Google announced $0.07/second at 720p, 30% below Omni 1.1's 720p rate.
- The release emphasizes multi-turn editing, stronger image/reference adherence, short motion clips and audio cues. The Interactions API remains the correct integration surface for stateful conversational edits.
- The existing database enqueue contract is still explicitly written for `gemini-omni-1.1-flash`; do not change the model ID in the application alone. Add 1.2 only with a dedicated provider adapter, exact price table and migration that binds quote, approval, request hash and settlement to the 1.2 model identity.

Official sources:
- https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-omni-1-2-flash/
- https://ai.google.dev/gemini-api/docs/omni
- https://ai.google.dev/gemini-api/docs/interactions-overview

### Product implication

Prioritize repeatable business workflows over a raw model catalogue: reusable brand kits, product/character reference packs, vertical and landscape ad variants, multi-turn revisions, captioned/social-ready exports, and clear per-output credit quotes. These are the customer-facing outcomes that make the underlying model capabilities commercially useful.


### Kling 4.0 Flash billing formula — exact quote requirement

The official Kling pricing table currently expresses Kling 4.0 Flash pricing in resource units per second, not a universal fixed USD rate:

- No input video: `output_seconds × 0.6 units/second`.
- Input video duration less than or equal to output duration: `output_seconds × 2 × 0.4 units/second`.
- Input video duration greater than output duration: `(input_seconds + output_seconds) × 0.4 units/second`.

The published prepaid packages have different discounted unit prices and validity terms. Consequently, do not hardcode a USD-per-second constant from a reseller or package example. The quote adapter must resolve the user's actual Kling account/package unit price, include all billable reference/source video durations, record the pricing evidence and expiry, and refuse enqueue if the account price cannot be verified. Flash is 720p only and supports 3–20 seconds.

Official pricing source: https://kling.ai/dev/model/image
