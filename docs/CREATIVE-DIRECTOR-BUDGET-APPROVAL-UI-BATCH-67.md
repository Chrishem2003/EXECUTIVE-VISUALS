# Batch 67 — Creative Director budget approval integration

## Delivered

The Creative Director storyboard now connects its successful server-side shot preflight to the durable video-generation approval ledger.

### User flow

1. Compile a storyboard.
2. Run **Check generation readiness**.
3. If the server confirms `ready_for_approval`, the UI reveals the quote currency and budget-ceiling input.
4. Enter a non-negative ceiling at or above the verified quote.
5. Select **Record budget approval**.
6. The UI reports the stored approval state and explicitly confirms that no provider request was submitted.

### Safety and integrity

- The UI submits the exact shot snapshot used by the successful preflight; the API independently reruns provider/model/capability checks and obtains its own current server-side quote.
- An optional cloud project ID is attached only when the local production is linked to an authorized cloud project.
- The server requires explicit confirmation, matching quote currency, a sufficient ceiling, and a unique idempotency key.
- The UI retains the same idempotency key when retrying the same budget after a network error, and rotates it when the budget changes.
- The server now rejects an idempotent replay if the current verified quote amount differs from the amount stored by the original approval.
- Approval creation still does not enqueue generation, reserve provider credits, call a provider, or mutate billing.
- No browser-provided quote or provider credential is trusted.

## Verification

The new interaction is included in the existing TypeScript application build and full release integration gate. The API's existing approval tests continue to cover confirmation, pricing readiness, currency, budget ceiling, stable request hashing, and amount precision.

## Deliberately not included

No paid generation submission, provider task polling, automatic retries, production deploy, production schema migration, or payment mutation. Those require a separately designed worker lifecycle and explicit execution authorization.
