# Capability and adapter contract

The frontend is a brief and project workspace. Actual media generation is dispatched by trusted server-side adapters, never directly from browser code.

## Contract
`src/core/contracts.ts` defines:
- portable capability identifiers independent of vendor naming;
- provider readiness states;
- job lifecycle states;
- capability input/output descriptors;
- provider adapter interface with cancellation and usage metadata.

## Adapter acceptance requirements
1. Credentials remain server-side and are redacted from errors/logs.
2. Validate input type, size, media format and user rights before dispatch.
3. Enforce consent for voice cloning, face/likeness generation and translation.
4. Persist provider job ID, state transitions, timestamps and output asset references.
5. Normalize provider errors without discarding actionable provider diagnostics.
6. Support cancellation/timeouts where the provider supports them.
7. Never mark a capability available based only on documentation or a configured key.
8. Record provider/model/version, usage and estimated/actual cost where available.

## Initial integration order
- Local planner (no model dependency).
- Image generation and image editing.
- Video generation and editing.
- Speech, transcription and localization.
- Consent-gated presenter/avatar generation.
- Enhancement operations.
