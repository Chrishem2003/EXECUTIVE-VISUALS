# Batch 116 — connect the owner margin policy to generation preflight

## Delivered
- Add a server-only method to read the active platform video margin policy from the existing private financial database.
- Connect the active policy, source-linked provider estimate and unique server-generated customer-price evidence for every shot to the existing gross-margin evaluator.
- Keep the evaluator at the actual preflight gate; it is not a UI-only calculation.
- Add an explicit integration point for a future verified per-shot fully-loaded cost model.

## Deliberate fail-closed behavior
The current application does not yet provide a trusted per-shot fully-loaded cost model covering compute, storage, egress, payment processing, moderation, retries, tax, refund reserve and support. Batch 116 therefore returns `PLATFORM_MARGIN_VARIABLE_COSTS_UNVERIFIED` when the owner policy is enabled but those costs are absent. Missing costs are never treated as zero and no generation dispatch is unlocked.

## Verification
Tests cover absent policy, enabled policy with missing costs, fully evidenced margin evaluation, shot identity mismatch, stale quotes and incomplete cost categories. No schema migration or live database write is required.
