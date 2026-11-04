# Runway Model Router dry-run client

Research snapshot: 2026-11-04. This implementation is a **non-billable preflight client**, not a generation adapter.

## Verified provider contract

The Runway Dev API documents routed video generation at:

- `POST https://api.dev.runwayml.com/v1/generate/video`
- Required `Authorization: Bearer ...`
- Required `X-Runway-Version: 2024-11-06`
- Request body: `configId`, model-agnostic `input`, and `dryRun: true`.
- Input supports `promptText` (up to 26,000 characters), `negativePrompt`, duration (2–30 seconds), aspect ratio, resolution, audio preference, seed, content-moderation threshold, up to four reference images, up to two reference videos and one reference-audio asset.
- The dry-run contract performs the routing pipeline and returns the decision and estimated cost without creating a task, billing, or producing an asset.

Official references:
- https://docs.dev.runwayml.com/api/ — Model Router / Routed video generation
- https://docs.dev.runwayml.com/guides/models/
- https://docs.dev.runwayml.com/guides/pricing/

## Implemented

`server/runway-router-dry-run.mjs` exports:

- `buildRunwayRouterDryRunPayload`: validates a saved router config slug and normalized video options; the returned payload always sets `dryRun: true`.
- `createRunwayRouterDryRunClient`: calls only `/generate/video`, requires both `RUNWAY_ROUTER_PREFLIGHT_ENABLED=true` and `RUNWAY_VIDEO_ALLOW_REMOTE=true`, requires a server-side `RUNWAY_API_KEY`, enforces a bounded timeout and response size, sanitizes provider errors, and normalizes the selected provider/model and estimated credits. Reference media is passed as project asset IDs, never as caller-supplied URLs. The client requires `getAuthorizedAssetContext({ projectId })` to derive the owner from the authenticated session and `resolvePrivateAsset({ assetId, ownerId, projectId, mediaType })` to enforce project-scoped access and return a provider-compatible URI.

The client has no option to submit a billable generation. It rejects any response containing a task ID because that contradicts the documented dry-run semantics. It never polls, cancels, or downloads outputs.

## Safety and activation

- Disabled unless explicit server-side environment opt-ins are set.
- No client/browser key exposure.
- No production environment changes.
- No API key or provider request was used during implementation.
- Tests use mocked fetch responses only.
- The preflight result is an estimate, not a reservation, invoice, or settlement record.
- A later execution flow must still use the durable approval, budget, one-shot submission ledger, actual usage reconciliation and private output ingestion gates.

## Next steps

1. Connect the authenticated project-context and private-asset resolver callbacks to the existing Executive Visuals cloud asset service; verify signed URL expiry and provider fetchability.
2. Persist the dry-run decision with the request hash and pricing evidence.
3. Compare the provider router's chosen model against the local deterministic router policy; require an explicit mismatch policy.
4. Add the actual execution adapter only after model-specific payload, billing and output-ingestion tests are complete.


## Reference media security contract

The router accepts up to four reference images (roles `first`, `last`, or `reference`; at most one each of `first` and `last`), two reference videos (roles `source` or `reference`; at most one `source`), and one reference-audio object. The client enforces those counts and role/media-type shapes, and validates provider URI schemes.

The preflight client deliberately does **not** trust owner or project IDs supplied per asset. When references are present, it requires an injected `getAuthorizedAssetContext` callback to derive the authenticated owner and authorize the requested project. It then passes that trusted scope to the injected private asset resolver. Both callbacks are required integration points; no production asset service or authorization policy is silently assumed. Missing callbacks fail closed before any provider request.

Official API contract: https://docs.dev.runwayml.com/api/ — Model Router / Routed video generation.
