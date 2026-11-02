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
