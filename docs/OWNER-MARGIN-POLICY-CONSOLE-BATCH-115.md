# Batch 115 — platform-owner margin policy console

## Scope
Adds a platform-owner-only control panel to the existing Finance workspace for the versioned video-generation gross-margin policy.

## Capabilities
- Loads the existing owner-only policy endpoint and gracefully omits the panel for users without access.
- Displays whether a policy is configured/enabled, its version, dispatch-readiness status and immutable change history.
- Allows the platform owner to enable/disable the policy and set the minimum gross-margin floor, quote freshness window and provider rate-card freshness window.
- Sends policy changes through the existing owner-authorized API with a fresh idempotency key.
- Uses no default margin or freshness values for a new installation; the owner must explicitly supply them.

## Financial safety
Saving a policy does not enable billable generation. The API response continues to report that dispatch is blocked until trusted provider pricing, customer sale-price evidence and a fully-loaded variable-cost model are wired and verified. This UI does not call a provider, change customer credits, activate subscriptions, post ledger entries, or deploy anything.

## Verification
A source-contract test checks owner API loading, required input bounds, absence of invented defaults, immutable history display, idempotency-key use and the explicit dispatch block.
