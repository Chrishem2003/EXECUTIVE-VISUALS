# Executive Visuals — platform capability and integration matrix

**Research and repository review:** 8 November 2026  
**Scope:** Publicly documented capabilities, the repository default branch, existing implementation branches and open pull requests.  
**Status rule:** A capability is not complete merely because a UI control, typed registry entry, branch or provider adapter exists. Completion requires an authorized user path, durable state where needed, verified adapter behavior, regression tests and end-to-end evidence.

## Product target

Build one Creative Production Operating System that takes a user from brief to publish-ready deliverable:

**Brief → research/evidence → creative direction → script/storyboard → shot plan → asset creation/ingest → editing → audio/localization → review/approval → finishing → delivery/publishing → analytics.**

The differentiators are a Creative Intent Graph, proof-to-publish trust, adaptive production routing, one-to-many campaign compilation and creative-business intelligence. Competitor products inform capability discovery only; implementation remains original and provider-neutral.

## 1. Capability map

| Domain | Target capabilities | Repository evidence/status | Integration or completion gap |
|---|---|---|---|
| Creative intelligence | Brief intake, Creative DNA, audience promise, hooks, visual grammar, story beats, shot intent, creative critique | Creative DNA compiler and project workspace exist on main; additional director/storyboard work exists in stacked PRs | Connect brief → script → storyboard → shot list → editable timeline with change-impact tracking |
| Pre-production | Research, claims/evidence, scripts, characters, schedules, shot breakdowns, storyboards, animatics | Project knowledge, briefs, scripts, shot lists and character records exist; storyboard compiler/Creative Director branches are open | Complete one governed end-to-end pre-production path and evidence/rights review |
| Image generation/editing | Text/image/reference generation, inpaint/outpaint, remove/replace, restoration, upscale, SVG/vector, batch variants | Typed capabilities and selected gateway adapters exist; some image operations remain blocked or local-only | Capability-specific provider contracts, private asset handoff, cost/rights checks, batch and comparison UI |
| Video generation | Text/image/video-to-video, references, first/last frames, keyframes, native audio, multi-shot, continuation, performance transfer | Local gateways, Runway/FAL, Aleph 2 and Model Router components exist; cloud queue path is being connected | Exact capability registry per model; cloud workflow bridge; route pinning; durable job/node progress; output handoff |
| Editing/timeline | Multitrack, frame-accurate edits, transitions, compositing, speed curves, overlays, keyframes, proxy relink, OTIO | Timeline/render, multi-track, transitions, speed and interchange branches exist; several are stacked/open | Consolidate proven branches, test preview/export parity, finish missing effects/preview/animation, verify cloud collaboration |
| Audio | Voice, transcription, diarization, music/SFX, ducking, automation, mastering, loudness, mix | Voice/transcription and extensive audio automation/mastering work exist across branches | Integrate one end-to-end timeline audio path; provider adapters and licensing/consent; localization timing |
| Enhancement/restoration | Upscale, denoise, deblur, stabilize, interpolate, HDR, repair, color match | Local FFmpeg operations and Runway enhancement/HDR adapter contracts exist | Validate each operation input limits, pricing, provenance, output quality and fallback; unsupported capability must remain unavailable |
| Localization/accessibility | Translation, dubbing, speaker mapping, captions, audio description, glossary, WCAG checks | Captions, VTT/SRT validation, transcription and localization foundations exist | Complete glossary, speaker/timing parity, multilingual review, accessible player and export checks |
| Workflow automation | Typed graph, templates, branches, approvals, batch runs, workflow diff, retries, human review | Workflow graph, snapshots, local execution, approval nodes and job engine exist | Connect cloud generation nodes; workflow version diff, batch execution, per-node cloud progress and safe retries |
| Asset/provenance | Private library, hashes, derivatives, C2PA, license/consent, lineage, manifests | Asset ledger, private publication and C2PA verification work is in open PRs/branches | Complete manifest preservation through transformations, rights expiry/revocation, trusted signing and delivery handoff |
| Review/collaboration | Frame/timecode comments, annotations, threads, review inbox, version stacks, client shares, presence | Review API/UI, annotations, threads, reactions, history and revision branches are open | Integrate permissions, notification delivery, presence/locks, client-safe sharing and review-to-revision workflow |
| Delivery/publishing | Export profiles, validation, packages, destination adapters, scheduled publish, receipts | Delivery profiles, AV sync, captions and export certification are in stacked PRs | Finish destination APIs, idempotent publish, consent/quotas, retries, receipts and analytics |
| Business operations | Scope, estimates, budgets, time, revisions, invoices, profitability | Billing foundation, usage intelligence and budget reservations exist across branches | Connect customer subscription/credits to actual provider settlement, proposals, change orders and profitability |
| Observability/governance | Audit, job telemetry, model evaluation, quality frontier, policy, privacy and recovery | Job queue, lease lifecycle, recovery and audit foundations exist | Consolidate dashboard, provider/model drift, quality benchmarks and cost/recovery alerts |

## 2. Reverse-engineered market capabilities to cover

Current public developer documentation reviewed on 8 November 2026 shows that modern media APIs expose more than text-to-video: video editing, extension, keyframe/reference control, multi-shot recipes, native audio, upscaling, HDR, interpolation, image/vector output, voice, dubbing and asset tools. Provider capability changes frequently, so support must be read from versioned adapter contracts rather than hard-coded marketing claims.

Sources:
- Runway Dev 2026 API comparison and capability overview: https://dev.runwayml.com/learn/best-ai-video-generation-apis
- Runway Dev model catalogue: https://dev.runway.com/models
- Runway Dev API reference: https://docs.dev.runwayml.com/api/
- Runway Model Router generation contract: https://docs.dev.runwayml.com/model-routers/generating/
- Google Gemini video generation guide: https://ai.google.dev/gemini-api/docs/video

The platform should normalize these capabilities into typed operations, while preserving model-specific limits and evidence. Do not imply every provider supports every operation.

## 3. Critical integration order

### P0 — make existing infrastructure one product
1. Complete quote → explicit approval → atomic reservation/enqueue; verify exact-head PostgreSQL CI.
2. Connect workflow editor video.generate nodes to authenticated cloud job creation.
3. Map cloud job stages, cancellation, retry and reconciliation into workflow run/node state.
4. Publish verified private asset IDs and provenance into workflow outputs and timeline nodes.
5. Complete provider-authoritative actual-cost settlement, ambiguous submission recovery and cancellation/partial-output accounting.
6. Run isolated staging end-to-end acceptance without production changes or paid generation.

### P1 — complete the professional production loop
1. Consolidate storyboard/shot compiler, character continuity and reference manifests.
2. Complete timeline preview/export parity, transitions, compositing, motion graphics and proxy relinking.
3. Complete audio workflow: speech, diarization, translation/dubbing, ducking, mastering and timing parity.
4. Complete review-to-revision loop with annotations, version comparison, reviewer inbox and client-safe permissions.
5. Complete delivery profiles, quality certification, one-click handoff package and export lineage.

### P2 — advanced differentiation
1. Blind model evaluation harness and quality-per-cost frontier.
2. Explainable capability-aware router with policy-first eligibility, route snapshots and drift detection.
3. Semantic asset search over authorized projects only.
4. Workflow version diff, reusable templates and safe batch execution.
5. Brand glossary, template autofill and multi-channel campaign compiler.
6. Creative Intent Graph change-impact analysis and proof-to-publish checks.
7. Publishing adapters, performance analytics and controlled creative experiments.
8. Agency operations: scope, time, change orders, delivery receipts and profitability.

## 4. Non-negotiable engineering and safety gates

- Preserve production resources; do not overwrite, delete or migrate shared production systems.
- Free/low-cost and isolated testing first; no paid upgrades or provider generation during implementation.
- Use feature branches and draft PRs; do not merge unfinished work or enable remote execution without explicit release approval.
- Inspect branch ancestry and exact commit state before integrating stacked PRs; do not merge unrelated or stale branches by title alone.
- Keep credentials server-side; do not copy secrets into commits, logs, tests or documentation.
- Enforce actor, tenant, project, asset, rights and consent scope before model routing or media access.
- Require explicit human approval for billable generation, destructive edits and publishing.
- Bind every approval to an immutable request hash, provider/model/operation, quote, amount, policy and expiry.
- Make reservation, enqueue and ledger updates transactional and idempotent.
- Settle only from authoritative provider usage; quarantine ambiguous outcomes rather than releasing budget or double-charging.
- Keep unsupported capabilities visibly unavailable; no mock/fake success.
- Every delivered feature needs docs, migration order, tests, CI evidence and an honest implementation status.

## 5. Immediate engineering checkpoint

The current implementation branch feat/p0-workflow-quote-ledger extends PR #248 with:
- Service-role-only quote persistence and project-owner binding.
- Explicit confirmed: true approval API.
- Router config pinning between quote and approval.
- Atomic approval-row creation, budget reservation, durable enqueue and quote consumption.
- Idempotent replay returning the original job/reservation.
- Disposable PostgreSQL and API regression coverage.
- Both cloud-video and Google Drive integration CI workflows applying the new migrations in order.

This does not yet connect cloud jobs to workflow-node progress/output, and it does not submit provider tasks. The next integration slice is the workflow executor/job bridge, followed by settlement/recovery and isolated staging acceptance.