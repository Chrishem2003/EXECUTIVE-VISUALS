# Governed video workflow contract

This document describes the current server-side contract and the boundaries between a selectable model, a quoteable request, an approved job, and an executable provider task.

## Supported workflow contracts

- Only `video.generate` workflow nodes enter the governed cloud video-generation contract.
- The normalized request builder recognizes exact provider/model identities. Runway Model Router and Luma Ray 3.2 have governed quote/approval paths; Google Gemini Omni has a separate contract path and must not be treated as interchangeable with either provider.
- The request is normalized, bound to a project and request ID, hashed, and deeply frozen before quote or approval handling.
- Duplicate asset IDs, conflicting media roles, unsupported duration/resolution/ratio combinations, missing rights confirmation, and unsupported operations fail closed.
- Luma Ray 3.2 text-to-video, single start-frame image-to-video, private source-video edit and private source-video reframe are exposed in the direct Video Studio composer. Source operations require a project-scoped private video, explicit rights confirmation, and operation-specific quote/approval.
- The Luma server contract supports paired private first/last image anchors for 5-second generation, or up to 64 indexed private keyframe images for 5- or 10-second generation. These modes are mutually exclusive; 10-second clips require multi-keyframe mode. Each anchor is an owner/project-scoped application asset; indexes must be unique, strictly increasing output-frame positions and within the selected duration. The exact frame list, indexes and rights confirmation are included in the immutable request hash.
- The Workflow Canvas supports Luma source-video edit (API source limit 18 seconds, but governed paid quotes are restricted to the published 5/10-second pricing tiers with a selectable edit-strength preset) and source-video reframe (2–10-second sources, 360p–720p output). Luma source-video uploads are capped at 200 MB. Both require a private project video asset, server-probed source metadata, rights confirmation, operation-specific quotes and durable owner approval. 1080p reframe remains disabled until the provider account capability is verified.
- The Workflow Canvas node inspector exposes a project-scoped private source-video asset picker plus private first/last frame asset IDs, indexed keyframe asset IDs, edit strength and normalized reframe crop controls; the workflow bridge transfers each private source into the linked cloud project before quote creation. Direct Video Studio now exposes source edit/reframe, edit strength, target aspect ratio and project-scoped source selection; the visual multi-keyframe editor remains in Workflow Canvas.
- Luma source-video edit and reframe are now connected in the Workflow Canvas through private source metadata, operation-specific quotes, explicit owner approval and durable worker file resolution. Video extension remains disabled until ownership of the original Luma generation can be proven.

## Private source resolution

- The authenticated cloud API revalidates every Luma start/end/keyframe asset at quote and approval time.
- Each image must exist in the exact project scope, have an accepted image media type, a bounded non-zero size, and a stored SHA-256 checksum.
- The durable Luma Files service rechecks owner/project scope, downloads from the configured private storage origin, streams with a hard byte ceiling, verifies exact size and SHA-256, then uploads using a presigned provider upload URL.
- Provider file IDs are persisted with owner/project/asset identity and upload attempt state. Unknown outcomes are quarantined rather than blindly re-uploaded.
- The worker validates keyframe count, index count, ordering, range and conflicting roles before uploading any private keyframe to Luma. It then resolves application asset IDs to provider file IDs; caller-supplied provider file IDs are rejected.

## Security and billing boundary

- Quote preparation is non-billable and makes no provider generation request.
- Luma estimates use the configured account/contract USD-per-credit rate; published list prices are not treated as a user's actual rate or as settlement evidence.
- Paid generation requires an unexpired durable quote, explicit project-owner approval with an approved USD ceiling, a budget reservation, an idempotent durable enqueue, and the gated provider worker.
- Provider task settlement uses task-correlated provider usage. A quote or estimated credit amount is never treated as actual spend.
- Provider execution remains disabled unless all global and provider-specific gates, private storage, schema readiness, server credentials, output host allowlists, and account pricing configuration are present.
- Source-controlled migrations are not applied to shared environments by this contract. Production activation and migrations require separate reviewed approval.

## Current UI and remaining work

- Current direct Video Studio: Luma text-to-video, first-frame image-to-video, source-video edit and reframe. The operation selector switches source-asset, edit-strength, duration and resolution constraints; source edits/reframes require a private project video and rights confirmation. Workflow Canvas additionally supports multi-keyframe generation and generated-video-to-timeline handoff. The cloud timeline clip inspector links eligible source assets into the same project's Workflow Canvas with rights confirmation left unchecked.
- Server-side workflow contract and quote support: up to 64 indexed private keyframes (per the Luma Agents API schema).
- Workflow-to-timeline handoff is already implemented: completed private cloud video assets can be added to the selected project's cloud timeline. Remaining UI polish: direct Video Studio Reframe action, visual keyframe drag-to-order/timing controls; Workflow Canvas now has project-scoped private source-video and multi-select project image pickers with explicit output-frame indexes.
- Still gated: visual keyframe drag-to-order/timing controls, source edits outside the published 5/10-second quote tiers, and video extension in all workflow surfaces.
- Required before calling the complete studio flow production-ready: exact-head CI, PostgreSQL migration integration, staging-only end-to-end verification, private output ingestion acceptance, durable storage/worker readiness, and a successful delivery-gate run.

## Verification

Run:

```bash
npm run verify:video-workflow-cloud-contract
npm run verify:cloud-queue
```

The automated suite must cover normalized request contracts, deterministic hashes, deep immutability, rights gates, keyframe count/index bounds, private asset scope, checksum verification, provider-file upload recovery, quote persistence, owner approval, budget reservation, enqueue idempotency, output ingestion, and actual-cost reconciliation.
