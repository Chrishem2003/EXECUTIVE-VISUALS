# Batch 64 — Provider-aware video shot preflight

## Scope

Adds an authenticated, non-billable dry-run endpoint at `POST /api/video-shot-preflight`.

## Checks performed

For each planned shot, preflight validates:

- Non-empty bounded prompt.
- Configured video provider is ready (including server-side remote opt-in).
- Requested provider matches the configured provider.
- Exact model is present in the provider's supported model catalog.
- Duration is within the selected model's supported range and the platform's 1–30 second shot bound.
- Aspect ratio and resolution are explicitly supported by the model.
- Reference image count is bounded and supported by the model.

## Price and approval behavior

- The complete production quote is calculated only from a current, source-attributed pricing record for the exact provider/model.
- Missing, expired or mismatched pricing produces `pricing_unverified`; no rate is guessed or substituted.
- Technical success plus verified pricing produces `ready_for_approval`, not automatic submission.
- The response always includes `requestsSubmitted: false`. A separate explicit budget approval and generation submission are still required.
- The endpoint is authenticated and rate limited.

## Validation

`npm run verify:video-shot-preflight` covers valid readiness, model and capability mismatches, disabled providers, unavailable pricing, malformed prompts and shot-count boundaries. The verification is included in the main build gate.
