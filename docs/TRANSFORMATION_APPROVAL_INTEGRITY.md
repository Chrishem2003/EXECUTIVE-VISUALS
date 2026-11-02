# Transformation approval integrity

Cloud video-transformation plans are drafts until a project editor records a known cost estimate, a budget that covers it, a currency, and a declared adapter/capability selection.

## Immutable approval binding

When approval is recorded, the API canonicalizes the persisted job input with recursively sorted object keys and computes a SHA-256 fingerprint. The approval receipt stores this value as `estimated_cost.planHash` with schema version 1. The `transformation.approved` audit event carries the same fingerprint.

Before a plan can be submitted, the API recomputes the fingerprint from the persisted input and compares it with the approval receipt. Missing, malformed, legacy, or mismatched fingerprints fail closed with `TRANSFORMATION_PLAN_CHANGED`. The user must create and approve a new plan; an approval cannot silently carry over to changed prompt, source, references, duration, or preservation constraints.

The API exposes the fingerprint in the returned approval summary so the UI and audit tooling can correlate the decision with the exact plan.

## Security and execution boundary

- The hash binds approval to the exact stored request; it is not a signature, provider attestation, rights proof, or substitute for authorization.
- Project write authorization and the existing cost/budget checks still apply.
- A matching fingerprint does not make an adapter production-ready.
- Submission remains blocked with `TRANSFORMATION_ADAPTER_UNAVAILABLE` until a verified adapter and the other transformation-readiness gates are configured.
- No provider request, charge, migration, or deployment is triggered by creating or approving a plan.

## Verification

The cloud timeline API regression test approves a plan, checks that the returned and persisted fingerprints match, confirms that a matching plan remains blocked only by the unavailable-adapter gate, then mutates the stored request and verifies submission is rejected before dispatch.

## Local plan-store parity

The local SQLite transformation-plan store now applies the same approval-binding principle. Its schema initializer adds the nullable `approval_plan_hash` column to existing databases without rebuilding or deleting plan records. New approvals fingerprint the canonical persisted request and expose the digest in the approval summary.

`verifyTransformationApproval(db, ownerId, planId)` re-reads the owner-accessible plan and returns a positive result only when the plan is still approved and its stored SHA-256 digest matches the current canonical request. Legacy approvals without a digest and modified plans fail verification. The local `/api/transformations/:id/submit` route now invokes this check after project-write authorization and approval-state validation, immediately before the adapter availability gate. A mismatch returns `TRANSFORMATION_PLAN_CHANGED`; it cannot proceed to queueing or dispatch. The helper does not itself authorize or execute a provider request.


## AI upscale asset lineage

Successful local AI upscale jobs now attach a versioned processing-provenance record to the derived asset. It binds the source asset ID and SHA-256, output SHA-256, exact executable and model-weight fingerprints, model/build identity, scale, dimensions, and measured execution duration. The output hash stored in the asset record is the same hash recorded in its processing provenance.

The record starts with `qualityReview: "not_reviewed"`. A successful engine invocation, valid image header, matching dimensions, and successful decoder check are execution-integrity evidence only; they do not establish perceptual quality. Benchmark promotion still requires representative fixtures and explicit quality review. Invalid or incomplete lineage fails closed before the derived asset is registered.


## Benchmark evidence from real derivatives

The benchmark module now exposes `buildUpscaleBenchmarkRecordFromAsset`. It accepts a completed image derivative plus a fixture ID/category from the controlled fixture registry, then derives hashes, model/build identity, dimensions, scale, execution duration, review state, and timestamp from the persisted asset provenance. It rejects mismatched output hashes, source-parent lineage, non-image outputs, and incomplete provenance. Benchmark registration therefore cannot silently substitute caller-provided hashes or claim visual approval from a successful worker run.


## Governed upscale benchmark workflow

Benchmark evidence is now project-scoped and persisted in SQLite. A project editor registers a fixture against an accessible still-image asset and one of the required categories: portrait, fine texture, text, animation, or low-light/noisy. The registry pins the source asset ID and SHA-256; a run can be registered only when its derived asset's parent ID and input hash match that exact fixture.

The API exposes:

- `GET /api/upscale-benchmarks/fixtures?projectId=...` and `POST /api/upscale-benchmarks/fixtures?projectId=...`
- `GET /api/upscale-benchmarks/runs?projectId=...` and `POST /api/upscale-benchmarks/runs?projectId=...`
- `POST /api/upscale-benchmarks/runs/:runId/review?projectId=...`

Only project owners/editors can register fixtures and runs. Quality decisions are restricted to project owners and assigned reviewers. The registering user cannot review their own run; a decision is immutable once recorded. Review decisions and fixture/run registration are written to the audit log. Benchmark summaries continue to recommend only pinned model builds with successful execution, all five fixture categories, and independent passing quality reviews. A run with missing evidence, a rejected review, or pending review cannot be promoted.

The `verify:upscale-benchmark` script now runs both the pure benchmark tests and the SQLite-backed governance tests. The workflow is additive: it creates new benchmark tables and does not rewrite existing assets or media jobs.


## Cloud Upscale Benchmark Lab

The cloud API now exposes the same governed benchmark workflow under `/api/cloud/upscale-benchmarks`. Its dedicated migration, `20261102150000_upscale_benchmark_governance.sql`, adds project-scoped fixture and run tables in the isolated `executive_visuals` schema. It is additive and is not applied automatically; the existing core migration is explicitly isolated from the shared staging database.

Cloud fixture registration reads the source through the private asset repository and pins its asset ID and SHA-256. Run registration re-reads the private derivative and verifies its processing provenance, output checksum, source parent, and source fingerprint against the fixture. The server API is the only writer: authenticated clients receive no direct table grants, so they cannot forge source hashes, model identities, or reviewer decisions.

Cloud review requires a project owner or assigned reviewer, rejects self-review, stores a single immutable decision, and writes a project audit event. The Enhancement Lab now includes fixture registration, derivative registration, pinned-build candidate summaries, and a review queue. The UI never invokes an upscaling provider from benchmark actions.

To enable the cloud workflow, review and explicitly apply the new migration to the intended dedicated development/staging Supabase project, then deploy the API version containing the matching routes. Neither action has been performed here.
