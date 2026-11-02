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
