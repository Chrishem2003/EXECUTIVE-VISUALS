# Governed video workflow contract

This document describes the current server-side contract and the boundaries between a selectable model, a quoteable request, an approved job, and an executable provider task.

## Supported workflow contracts

- Only `video.generate` workflow nodes enter the governed cloud video-generation contract.
- The normalized request builder recognizes exact provider/model identities. Runway Model Router and Luma Ray 3.2 have governed quote/approval paths; Google Gemini Omni has a separate contract path and must not be treated as interchangeable with either provider.
- The request is normalized, bound to a project and request ID, hashed, and deeply frozen before quote or approval handling.
- Duplicate asset IDs, conflicting media roles, unsupported duration/resolution/ratio combinations, missing rights confirmation, and unsupported operations fail closed.
- Luma Ray 3.2 text-to-video and single start-frame image-to-video are exposed in the current direct Video Studio composer.
- The Luma server contract also supports up to 64 indexed private keyframe images for a 5- or 10-second generation. Each keyframe is an owner/project-scoped application asset; indexes must be unique, strictly increasing output-frame positions and within the selected duration. The exact keyframe list, indexes and rights confirmation are included in the immutable request hash.
- The direct Video Studio composer does not yet expose the multi-keyframe editor. It must not imply that users can select this workflow until the complete visual composer and persistence UI are connected.
- Luma source-video edit, reframe and extend remain disabled in the workflow quote/approval composer until their source metadata, operation-specific quote, approval and UI paths are fully connected.

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

- Current direct Video Studio: text-to-video and one first-frame image-to-video for Luma.
- Server-side workflow contract and quote support: up to 64 indexed private keyframes.
- Not yet exposed in the direct composer: keyframe upload/order/timing UI and saved-project restoration for multi-keyframe sequences.
- Still gated: Luma video edit, reframe and extend workflows in the direct composer.
- Required before calling the complete studio flow production-ready: exact-head CI, PostgreSQL migration integration, staging-only end-to-end verification, private output ingestion acceptance, durable storage/worker readiness, and a successful delivery-gate run.

## Verification

Run:

```bash
npm run verify:video-workflow-cloud-contract
npm run verify:cloud-queue
```

The automated suite must cover normalized request contracts, deterministic hashes, deep immutability, rights gates, keyframe count/index bounds, private asset scope, checksum verification, provider-file upload recovery, quote persistence, owner approval, budget reservation, enqueue idempotency, output ingestion, and actual-cost reconciliation.
