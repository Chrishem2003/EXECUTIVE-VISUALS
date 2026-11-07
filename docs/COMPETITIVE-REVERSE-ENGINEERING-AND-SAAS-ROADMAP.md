# Executive Visuals — Competitive Reverse Engineering & Product Roadmap

**Purpose:** Convert Executive Visuals from a collection of creative workspaces into a cohesive, monetizable AI creative-production SaaS. This is a product requirements and implementation blueprint based on public product documentation and observable workflows, not a copy of proprietary source code or private systems.

## 1. Competitive patterns to adopt

| Product | Publicly documented strengths | Product pattern to implement |
|---|---|---|
| Runway | Workspace roles, paid seats, billing admins, shared assets, project membership, usage/credit spend visibility, video and image generation | First-class workspaces, granular roles, member management, seat entitlements, per-user spend reports |
| Kling AI | Model-specific image/video generation and credit-based access | Model capability cards, generation parameter validation, transparent per-run credit estimates |
| Higgsfield | AI-first creative workflows, cinematic controls and model catalogue | Camera/motion presets, reusable creative recipes, multi-model orchestration |
| Adobe Firefly | Creative suite integration, generative credits and enterprise governance | Brand-safe workflows, policy controls, commercial-use metadata, enterprise administration |
| Canva | Team collaboration, templates, brand kits and simplified editing | Shared brand kits, templates, team assets, accessible editing and delivery |
| Krea | Realtime creative generation and visual iteration | Fast iteration loops, prompt/reference editing, variants and visual comparison |

### Workspace role model

Use these distinct roles at workspace scope:
- **Owner:** ownership, billing, security and workspace deletion.
- **Admin:** users, roles, settings, projects and generation.
- **Billing admin:** plans, payment methods, invoices, seats, credits and spend reports; no generative tools by default.
- **Editor:** create, generate and edit within granted projects; no billing or security changes.
- **Reviewer:** comment, approve or request changes; no generation by default.
- **Viewer:** view and download only.

Project-level permissions remain narrower than workspace permissions. A member must never gain access to private assets merely by being in the same workspace.

## 2. Core creative application

### A. Model and generation control plane
- Provider-neutral model registry with stable internal model IDs and provider model IDs.
- Capability matrix: text-to-image, image edit, inpainting, outpainting, text-to-video, image-to-video, reference-to-video, first/last-frame, video extension, audio generation and speech.
- Model-specific parameter schemas; do not expose controls unsupported by the selected model.
- Model selector with provider, version, availability, latency notes, resolution, duration, aspect ratios, input limits and policy restrictions.
- Prompt composer with prompt history, reusable prompt templates, negative prompts where supported, style references, character references and shot-level prompts.
- Reference assets, first/last frames, multi-reference weighting, seed and reproducibility metadata where supported.
- Batch variants, queue position, cancel/retry, progress, failure reasons and generated asset lineage.
- Preflight cost estimate with currency, credit estimate, price source and last-verified timestamp.
- Explicit approval for high-cost or remote provider actions; no hidden provider calls.

### B. Professional editing studio
- Non-destructive multitrack timeline for video, audio, image, captions and overlays.
- Frame-accurate trim, split, ripple delete, slip/slide, snapping, markers, transitions and track locking.
- Keyframes for transform, opacity, crop, position, scale, rotation, audio volume and supported effects.
- Proxy generation and relinking; original media remains immutable.
- Audio waveforms, voiceover, music, ducking, fades, loudness targets and synchronization.
- Caption transcription, editable subtitle tracks, SRT/VTT import/export and burned-in caption styling.
- Color controls, LUT support, shot matching and scopes as runtime capability permits.
- Export presets for YouTube, TikTok, Instagram, broadcast and custom delivery.
- Render queue, render estimates, resumable jobs, render logs, versioned outputs and failed-render recovery.

### C. Production and asset management
- Projects, folders, series, seasons, episodes, briefs, story bibles, shot lists and reusable characters.
- Private, project-shared and workspace-shared assets.
- Asset metadata, thumbnails, proxies, checksum, format/duration, source lineage and rights metadata.
- Version history, side-by-side review, comments pinned to timestamps, approvals and change requests.
- Brand kits: logos, fonts, color palettes, lower thirds, intro/outro, caption styles and reusable templates.
- Team invitations, access expiry, project membership, member removal and ownership transfer.
- Rights and consent records for likeness, voice, music, stock media and user-provided references.

## 3. Commercial model and subscriptions

### Plan structure (features, not yet final prices)

| Tier | Intended user | Suggested entitlement model |
|---|---|---|
| Free | Explore and learn | Local editing/planning, limited private storage, no paid remote generation or a small controlled trial allowance |
| Creator | Individual creator | Personal workspace, monthly credits, core image/video models, standard exports |
| Pro | Professional creator | Higher credits, premium models, more concurrent jobs, larger storage, advanced editing and priority queue |
| Studio | Small production team | Shared workspace, seats, role controls, shared credits, project approvals, team asset library |
| Enterprise | Organisations | Custom quotas, SSO, audit exports, retention controls, private provider credentials, procurement and support |

Do not publish fixed prices until model provider costs, storage, egress, payment fees, taxes and support costs have been verified. Set prices from a documented unit-economics worksheet rather than guessing.

### Credit and usage accounting
- Append-only credit ledger; no direct mutable balance field.
- Reserve credits before dispatch using an idempotency key.
- Settle against actual provider usage after successful completion.
- Refund reservations on failed/cancelled provider jobs according to the provider's billing outcome.
- Track model, provider, version, capability, duration, resolution, input assets, output count, provider transaction ID and actual cost.
- Apply per-user, per-project, per-workspace and global spend limits.
- Support expiring plan credits, non-expiring purchased credits, admin grants, refunds and adjustments as distinct ledger events.
- Prevent negative balances and duplicate webhook grants.
- Display estimated cost before submission and actual cost after completion.

### Billing lifecycle
1. User selects a plan and sees full price, currency, interval, included credits, seat count, renewal date and cancellation terms.
2. Server creates a provider checkout session using an idempotent reference.
3. User completes payment on the payment provider's hosted checkout.
4. Server verifies the transaction with the provider API; browser redirects are not proof of payment.
5. A signed provider webhook is verified and deduplicated.
6. Subscription status and credit grants are updated transactionally.
7. Failed renewals move to past_due with a defined grace period and notifications.
8. Cancellation, refund, chargeback, upgrade, downgrade and proration are recorded in an immutable billing history.

### Payment provider selection
- Flutterwave explicitly documents Uganda UGX card and Mobile Money support. Its payment-plan subscriptions require card payments; Uganda Mobile Money should be offered as a one-time payment/top-up path, not represented as automatic recurring billing.
- Paddle is a potential merchant-of-record option for global software sales, subject to seller onboarding eligibility and commercial approval.
- Do not assume Stripe direct merchant onboarding is available for a Uganda-registered business. Confirm country eligibility and legal entity requirements before selecting it.
- Keep payment provider adapters replaceable; never store card details in Executive Visuals.

## 4. Administrator control plane

### Overview
- Active users, new users, churn, active trials, active/past-due subscriptions.
- Gross receipts, refunds, net receipts and payment failures only when verified provider records exist.
- Credits issued, credits consumed, unused credits, model cost, gross margin and provider failure rate.
- Queue depth, concurrency, latency, failed jobs, storage and egress.
- Alerts for runaway spend, repeated provider failures, abuse and capacity thresholds.

### User and workspace administration
- Search users, view account status, last active, workspace membership, plan, seats and usage.
- Invite, remove, suspend, restore and transfer ownership with confirmation and audit history.
- Role assignment with least privilege.
- Per-user and per-workspace spend caps, model allowlists, generation limits and export limits.
- Support tools that reveal only authorised metadata; do not expose private prompts or media without a justified support permission.

### Plans and pricing
- Versioned plan definitions and entitlement snapshots.
- Currency-specific price records and effective dates.
- Credit allowance, expiry policy, seat count, concurrent jobs, storage, allowed models and feature flags.
- Discounts, trials, coupons, add-ons and top-up bundles.
- Preview plan changes before applying; preserve existing subscription terms unless migrated deliberately.

### Provider and model administration
- Enable/disable individual models and capabilities.
- Store provider secrets server-side only.
- Configure per-model provider price, markup, supported parameters, maximum duration/resolution, queue priority and maintenance state.
- Require price source and verification timestamp.
- Kill switch for each provider/model.
- Admin self-test that never triggers a paid generation without explicit confirmation.

## 5. Architecture and release gates

### Required services
- Identity: dedicated Supabase Auth project and verified account lifecycle.
- Application data: dedicated Postgres database with tenant-aware schema and Row Level Security.
- Media: private object storage with short-lived signed URLs; do not use an ephemeral container filesystem.
- Queue: durable job queue with leases, idempotency, retries, cancellation and dead-letter handling.
- Workers: separate media-render and AI-provider workers with bounded concurrency.
- Billing: provider adapter, webhook verifier, subscription state machine and immutable ledger.
- Observability: structured logs, metrics, trace IDs, alerts, retention and incident history.

### Security requirements
- Tenant isolation enforced in database policies and server authorization, not only UI filters.
- Admin access from a server-side allowlist or a managed role table with protected provisioning.
- Server-only provider and payment credentials; never return secrets in API payloads.
- Signed webhook verification, provider-side transaction verification, replay protection and idempotency.
- Rate limits, file-signature validation, upload size/duration limits, malware scanning where appropriate.
- Audit every privilege, billing, plan, credit and security change.
- Tested backup/restore, deletion, retention and incident response.

### Release gates
Do not activate public paid subscriptions until:
1. Dedicated application database is provisioned and isolated from NEMA/shared platform projects.
2. Durable private object storage is connected to the active asset API.
3. Database migrations, RLS, storage policies and tenant-isolation tests pass.
4. Admin identity is explicitly provisioned and tested.
5. Provider sandbox checkout, webhook verification, recurring renewal, cancellation, refund and replay tests pass.
6. Credit reserve/settle/refund is connected to actual generation jobs.
7. Model prices and margin rules are approved.
8. Separate owner/admin/billing-admin/editor/reviewer/viewer accounts pass hosted end-to-end tests.
9. Backup/restore, capacity, monitoring and rollback are rehearsed.

## 6. Implementation sequence

- **Phase 1 — Product foundation:** user/admin console, plan catalogue, entitlements, credit ledger, audit and usage visibility.
- **Phase 2 — Billing:** Flutterwave sandbox checkout, signed webhooks, transaction verification, recurring card plans, Uganda Mobile Money top-ups, customer billing history and cancellation.
- **Phase 3 — Generation control plane:** model registry, model-specific forms, price-aware credit reservation, provider adapters and real output asset ingestion.
- **Phase 4 — Studio:** connect generated media to the multitrack editor, audio/captions, timeline rendering, export presets and versioning.
- **Phase 5 — Team and enterprise:** invitations, workspace roles, seats, shared credits, brand kits, SSO and audit exports.
- **Phase 6 — Scale and reliability:** dedicated Postgres, private object storage, durable workers, autoscaling, observability and recovery.

## References

- Runway workspace roles and seat permissions: https://help.runwayml.com/hc/en-us/articles/10312703076371-Workspace-members-roles
- Runway enterprise workspace member management: https://help.runwayml.com/hc/en-us/articles/43198398846611-Managing-Workspace-Members
- Flutterwave payment plans and card-only recurring subscription behaviour: https://developer.flutterwave.com/docs/payment-plans-1
- Flutterwave standard checkout: https://developer.flutterwave.com/reference/checkout
- Flutterwave Uganda payment methods: https://developer.flutterwave.com/docs/payment-methods
- Flutterwave webhook signature verification: https://developer.flutterwave.com/v3.0.0/docs/webhooks
- Paddle supported countries: https://developer.paddle.com/concepts/sell/supported-countries-locales/


## 7. Provider and payment contract updates — verified 2026-11-07

### Runway execution and spend contract

The current Runway Dev API exposes distinct text-to-video, image-to-video and video-to-video task creation endpoints. Video-to-video accepts Aleph 2 and other supported models, requires a source video URI, and documents a maximum 30-second input. Tasks return an estimated maximum cost before execution; the platform must use that estimate as a budget reservation, then reconcile the final task result before settling customer credits.

Current Runway Dev pricing examples (USD, subject to provider changes):
- Seedance 2.5: $0.20/sec at 480p, $0.30/sec at 720p and $0.68/sec at 1080p.
- Aleph 2.0: $0.28/sec, with a minimum request cost.
- Non-MP4 outputs and advanced finishing operations can add separate per-second or per-frame charges.

Do not hard-code these public rates as customer prices. Refresh provider cost data, record its source and verification time, and apply a margin plus a bounded safety reserve. Provider-returned task estimates are the authoritative preflight input when available.

### Flutterwave payment contract

The implemented one-time credit checkout uses Flutterwave Standard API v3:
- Checkout creation uses a server-generated transaction reference and a server-stored plan price.
- UGX one-time top-ups may offer card and Uganda mobile money.
- Webhooks use the configured secret hash in the `verif-hash` header for v3.
- Every successful payment is verified server-to-server for reference, amount, currency and status before credits are granted.
- Event intake is idempotent and asynchronous processing must not block the webhook acknowledgement.

Flutterwave recurring payment plans are a separate card-only product. When a payment plan is supplied to checkout, Flutterwave fixes the payment method to card. Therefore, Uganda mobile money is suitable for one-time credit top-ups in this implementation, not recurring mobile-money subscriptions. Do not enable recurring plans until renewal, cancellation, failed-charge, credit renewal, and provider reconciliation events have been verified in the merchant sandbox.

### Verified references
- Runway API endpoints and task contracts: https://docs.dev.runwayml.com/api/
- Runway Dev model pricing and estimated task costs: https://dev.runway.com/pricing
- Flutterwave v3 webhook signature and retry guidance: https://developer.flutterwave.com/docs/webhooks
- Flutterwave transaction verification: https://developer.flutterwave.com/docs/transaction-verification
- Flutterwave recurring payment-plan and card-only limitation: https://developer.flutterwave.com/docs/payment-plans-1
- Flutterwave Uganda mobile-money flow: https://developer.flutterwave.com/docs/uganda

## 8. Runway model-catalogue drift audit — 2026-11-07

The official Runway Dev model directory now lists 64 models across video, image, audio, real-time and professional-output categories. The model directory is a changing catalogue, not a promise that every model has a stable direct endpoint or that this application can execute it.

Newly documented video releases on 2026-11-05 include:

- **Kling 4.0 Flash** (`kling_4_flash`): 720p, 3–20 seconds, text/first-frame/image/video references and source-video editing; published starting price from $0.094/second.
- **Gemini Omni 1.2 Flash** (`gemini_omni_flash_1.2`): text, keyframe and reference-driven video generation, plus editing and extension, with listed output tiers from 360p through 4K; published starting price from $0.02/second.

The provider registry now records both video models as disabled, non-executable catalogue entries. Their starting rates are evidence only; they are not complete tiered pricing formulas and must not be used for customer quotes. The public model catalogue and pricing page must be rechecked before any quote or provider activation.

The same directory also lists new image models GPT Image 2.6 Flare and GPT Image 2.6 Sunburst. They are deliberately not inserted into the video provider registry: image generation needs its own capability contract, input/reference schema, output ingestion and pricing estimator. Add them only through that separate image-generation control plane.

### Catalogue governance requirements

1. Store provider model IDs separately from internal product IDs and provider adapter names.
2. Track source URL, verified-at date, pricing evidence type, capability evidence and model lifecycle state.
3. Distinguish exact tier pricing from a published "from" price; only exact tier formulas can power an automatic customer quote.
4. Keep new and changed models disabled until adapter contract tests, cost reservation, output ingestion, safety policy and owner/project isolation pass.
5. Add a scheduled catalogue-drift review, but never auto-enable a newly discovered model or silently change customer-facing prices.

Official references:
- Runway model directory: https://docs.dev.runwayml.com/guides/models/
- Runway API pricing and costs: https://docs.dev.runwayml.com/guides/pricing/
- Runway API changelog: https://docs.dev.runwayml.com/api-details/api_changelog/

## 9. Runway Dev model contracts — verified pricing update (2026-11-07)

The November 5 Runway Dev releases were rechecked against both the API changelog and the live pricing table. The catalogue and estimate engine now use the published credit formulas rather than the earlier USD "from" rates.

### Kling 4.0 Flash (`kling_4_flash`)

- 720p only; 3–20 seconds; 5-second default.
- Text-to-video, first-frame image-to-video and source-video editing; generated audio is included.
- Up to 10 images including the first frame; up to 5 input/reference videos with a combined 20-second input-video budget.
- No separate image-reference charge.
- No input video: 9.4 credits per output second.
- With input video: 6.3 credits per output second plus 6.3 credits per second of the greater of combined input-video duration and output duration; round the total up once.
- 29-credit minimum. The published examples are 47 credits for 5 seconds without input video, 63 credits with 3 seconds of input, and 95 credits with 10 seconds of input.

### Gemini Omni 1.2 Flash (`gemini_omni_flash_1.2`)

- 3–15 seconds; 360p, 720p, 1080p and 4K; 4,000-character prompt limit.
- Text, first/last keyframes and up to 5 image references / 3 video references; video-to-video editing and extension.
- Output rate: 2 / 7 / 10 / 21 credits per second by resolution.
- Add 1 credit per reference image/keyframe and 1 credit per second of input video. Round the combined total up; minimum 6 credits.
- Auto duration reserves 15 seconds, then settles to generated duration rounded up to a whole second.
- Extension bills newly added output footage plus input video; editing bills input duration at the output rate plus input-video and reference charges. The general estimator currently covers the ordinary duration-based preflight; edit/extend-specific settlement remains a separate adapter acceptance requirement.

### Implementation status

- [x] Registry metadata updated with documented capability, resolution, duration, reference and pricing constraints.
- [x] Deterministic price estimators added for Kling 4.0 Flash and Gemini Omni 1.2 Flash.
- [x] Regression tests added for official examples, minimums, resolution tiers, duration limits and reference limits.
- [ ] Provider-specific request adapters and task lifecycle for these two model IDs.
- [ ] Actual task-cost reconciliation and private output ingestion for both models.
- [ ] Staging acceptance with provider account entitlements; no live paid generation is performed by CI.

### Separate image-generation control plane

The same November 5 release adds GPT Image 2.6 Flare and Sunburst. These are image endpoints, not video models. They support PNG output, up to 16 reference images, 1–10 outputs, 1K/2K/4K aspect-ratio tiers, low/medium/high quality and reasoning effort, with transparent backgrounds. Pricing depends on quality, resolution and aspect ratio (1–19 credits per image) plus one credit per reference image per output.

Do not route these through the video registry or assume the current generic image adapter supports their request schema. Implement a separate Runway image adapter with strict allowlisted model IDs, per-image pricing, reference ownership, output-count bounds, asynchronous task polling, private ingestion and model-specific response validation. Keep it disabled until those gates pass.

Official evidence:
- https://docs.dev.runwayml.com/api-details/api_changelog/
- https://docs.dev.runwayml.com/guides/pricing/
- https://docs.dev.runwayml.com/guides/models/

### GPT Image 2.6 pricing preflight implementation

A standalone non-billable estimate module, `server/runway-image-pricing.mjs`, and deterministic tests now encode the published Flare/Sunburst pricing table for 1K/2K/4K, six aspect-ratio families, low/medium/high quality, 1–10 outputs and up to 16 reference images. The `auto` ratio path explicitly reserves the 4K square price. It returns `published_price_estimate`, `billable: false`, and `settlementEligible: false`.

This is deliberately not wired into `generateImage`, checkout, billing settlement or provider selection. The Runway Dev image adapter, request/response validation, task polling, model-specific prompt/reference ownership, output ingestion, and actual-cost reconciliation are still required. Do not advertise GPT Image 2.6 as an executable model in the customer UI yet.

