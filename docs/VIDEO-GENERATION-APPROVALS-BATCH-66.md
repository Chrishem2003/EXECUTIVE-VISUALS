# Batch 66 — Durable video-generation budget approvals

## Purpose

Persist a user-approved production budget and immutable shot/quote snapshot before any generation worker is allowed to submit provider requests.

## API

### Create approval

`POST /api/video-production-approvals`

- Requires authenticated owner/editor access for an optional project.
- Requires a unique `Idempotency-Key` (or body `idempotencyKey`) of 8–180 characters.
- Requires `confirm: true`, a 1–12 shot plan, and a `budget` with currency and non-negative amount.
- Re-runs provider/model/capability preflight and the server-side current rate-card quote; client-supplied quotes are never trusted.
- Rejects unavailable/expired pricing, provider incompatibility, currency mismatch, or a quote above the budget ceiling.
- Stores a SHA-256 request hash, canonical shot/quote snapshot, quote amount, budget ceiling and approval state.
- Same idempotency key + identical request replays the existing approval; a different request conflicts.

### List approvals

`GET /api/video-production-approvals` supports optional `projectId` filtering.

### Withdraw approval

`POST /api/video-production-approvals/:id/withdraw` transitions a pending approval to `withdrawn`. Withdrawn or consumed approvals cannot be withdrawn again.

## Safety boundary

Creation returns `approved_pending_submission` and `requestsSubmitted: false`. It does not enqueue a job, reserve credits, call a provider, or change billing. A future worker must consume the exact stored snapshot, check that the approval is still pending, enforce the approved ceiling, and persist provider task identity before polling. Unknown POST outcomes must be reconciled rather than blindly resubmitted.

## Persistence

The `video_generation_approvals` table is created by the normal database bootstrap. It is owner-scoped, optionally project-scoped, idempotent per owner, and retains a durable audit event for creation/withdrawal.

## Verification

`npm run verify:video-generation-approval` tests explicit confirmation, passing preflight, current quote, currency, budget ceiling, deterministic request hashing, and shot-count boundaries. The check is part of the main build gate.
