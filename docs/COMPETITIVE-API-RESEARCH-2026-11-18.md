# Competitive API research and integration decisions — 18 November 2026

## Purpose

Translate current public developer API capabilities into a safe implementation backlog for Executive Visuals. This is a research/architecture record, not a claim that these providers are enabled or that any paid integration has been activated.

## Current verified provider capabilities

### Runway Dev — Seedance 2.5

The current Runway Dev API documentation describes Seedance 2.5 as a multimodal video model supporting text, image, video and audio inputs; connected multi-shot output; generated audio; durations from 4 to 30 seconds; and 480p, 720p, 1080p and 4K output. Video-to-video supports reference, extend and edit modes with mode-specific constraints. The current docs also describe draft mode: a 480p draft task can be enhanced by submitting its `draftTaskId` for a separate 1080p task. Treat draft and enhancement as two billable operations; never imply the draft is a free preview or silently submit the final enhancement.

Sources:
- https://docs.dev.runwayml.com/api-details/api_changelog/
- https://dev.runwayml.com/learn/seedance-2-5-api

### Kling developer API

Kling's current developer platform lists Kling 4.0 and 4.0 Flash, with dynamic motion, Omni reference, native generation up to 30 seconds and multiple keyframes. Its published platform overview describes up to 15 combined image, video, element and voice references for Omni Reference. Kling 3.0/3.0 Omni are described with synchronized audio-video generation, storyboarding and element reference. These overview claims are not sufficient to implement an adapter: exact endpoint schemas, per-model duration/reference restrictions, task lifecycle, pricing and output URL security must be checked against the specific model API documentation before enabling execution.

Source:
- https://kling.ai/dev/api

### Runway Workflows

Runway Workflows expose published node graphs as endpoints. The graph can combine model nodes, LLM nodes and utility steps such as frame extraction, clip stitching, audio addition and JSON parsing. Executive Visuals should treat external workflow graphs as versioned, typed contracts: validate declared inputs/outputs, bind private media through authenticated asset IDs, and preserve provenance for each exposed output.

Source:
- https://docs.dev.runwayml.com/workflows/

## Product decisions

1. Preserve the provider-neutral adapter boundary and the existing durable submission ledger. Do not build a parallel queue for new models.
2. A draft-to-final flow must persist the provider draft task ID, project/asset ownership, model/version, input fingerprint, quoted maximum cost, explicit user approval and the final task ID. Final enhancement is a new billable submission and requires its own approval if the approved ceiling or task scope changes.
3. Keep estimates distinct from actual provider charges. Reconcile actual task-level usage before settlement and customer credit deduction.
4. Validate output dimensions, duration, frame rate, codec, audio streams, checksum and private ingestion before publishing an asset.
5. Treat model catalogue metadata, planner support, adapter implementation, worker composition, pricing policy and UI availability as separate readiness states. A model must not become selectable merely because it appears in a catalogue.
6. No provider credentials, paid calls, live remote execution or production switches are introduced by this research.

## Ordered engineering backlog

### P0 — End-to-end cloud acceptance

- Complete dedicated cloud-staging identity/database configuration through protected service settings.
- Apply migrations only to an isolated Executive Visuals database after a reviewed baseline.
- Prove auth/session, project isolation, private media lifecycle, timeline persistence, durable queue/worker restart recovery, cancellation, output ingestion and actual-cost reconciliation.
- Verify the full brief → storyboard → timeline → approved generation → finishing → QC → private delivery journey from the deployed staging app.

### P1 — Seedance 2.5 draft-to-final integration

- Confirm exact current request/response schemas and pricing from official docs at implementation time.
- Add an explicit draft task state and a separate final-enhancement task state to the existing durable task model.
- Persist the provider task linkage and immutable request fingerprint; resume by task ID only, never repeat an ambiguous POST.
- Require a fresh quote/approval for the separately billed final enhancement.
- Add mocked contract tests, Postgres integration tests and a gated staging acceptance test. Keep remote execution off by default.

### P1 — Kling model adapters

- Implement only exact model IDs and API contracts verified from model-specific official docs.
- Add duration/reference/keyframe/audio validation, dated pricing, task polling/cancellation and private-output host allowlists.
- Add capability/adapter readiness tests and prove no silent model fallback.

### P1 — Delivery quality gate

- Validate container/codec, dimensions, frame rate, duration, audio loudness/true peak, caption presence/safe areas, rights evidence, checksum and provenance.
- Produce actionable QC findings and require explicit reviewer approval for documented exceptions.

### P2 — Studio workflow ergonomics

- Make creative artifact revision history visible and recoverable in the project workflow.
- Surface generation progress, blocked prerequisites and retry-safe job status without requiring manual refresh.
- Add storyboard-to-timeline attachment verification and preserve shot/source lineage through finishing and delivery.

## Acceptance rule

A feature is complete only when its application path, authorization, persistence, error states, automated tests and deployed staging acceptance are demonstrated. A plan, catalogue entry, request planner or merged unit-test suite alone is not a working production feature.
