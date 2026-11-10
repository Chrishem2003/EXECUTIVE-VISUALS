# Batch 65 — Storyboard generation readiness UI

## Delivered

- The Creative Director storyboard now exposes a **Check generation readiness** action.
- The action reads the server's authenticated provider catalog and uses the configured video provider/model; it does not let the browser select arbitrary credentials or endpoints.
- It submits the planned storyboard shots to the authenticated `POST /api/video-shot-preflight` endpoint.
- It displays the returned compatibility/pricing result inline, including the reason when provider configuration or current pricing is missing.
- The UI labels the operation as a dry run. It does not submit generation requests, reserve credits, or mutate billing.
- The button is disabled while the check is running and restored after success or failure.

## Validation

- Existing `verify:video-shot-preflight` tests cover model/provider mismatches, duration/aspect/resolution/reference compatibility, invalid input, and unverified pricing.
- A failed assertion in the first Batch 64 CI run was corrected to match the exact pricing-unverified message. The earlier failure was an assertion-text mismatch; the other four preflight tests passed.
- Exact-head CI for the follow-up integration commit is pending. No successful full build is claimed until all checks complete.

## Rollout

The UI is a readiness check only. A separate, explicit approval and generation-submit workflow is still required before any paid provider call can occur.
