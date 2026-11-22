# Subscription entitlement contract

This module is the fail-closed application policy layer for subscription access. It consumes a **server-read** subscription row and its immutable `entitlements_snapshot`; it never accepts plan identity, limits, model access, credit amounts or prices from a browser request.

## Current implementation slice

- Requires subscription status `active`, a valid plan code/version, a verifiable future billing-period end and a bounded JSON entitlement snapshot.
- Preserves access through the paid period when cancellation is scheduled at period end; access ends when the period expires.
- Evaluates boolean capabilities, allowlisted providers/models/options, numeric limits and usage counters.
- Rejects missing/unknown entitlements and prototype-path traversal.
- Exposes assertion helpers with stable authorization error codes.

## Financial and commercial boundaries

- This module does not create balances, grants, reservations, checkout sessions or ledger entries. Reuse the existing subscription ledger, Paddle/Pesapal adapters and Neon financial ledger.
- Provider cost estimates remain quote inputs only. Only authoritative provider usage evidence can settle actual cost.
- Do not publish monthly credit quantities until representative model/resolution mixes, retries, failed-but-billable tasks, storage, egress, rendering, payment fees and FX have been costed.
- Plan prices ($9, $29, $79 and $199) are experiments, not fixed entitlements or a guarantee of included generation volume.
- Paddle remains the primary international subscription provider. Pesapal remains the Uganda/East Africa secondary provider; manual renewal stays in place unless automatic recurring acceptance is completed.
- This policy module is not yet a public-release approval. The route/worker composition must call the same server-side entitlement service before quote approval, reservation and enqueue, and isolated staging acceptance is still required.

## Next integration steps

1. Load active plan/subscription snapshots through the existing trusted billing repository.
2. Inject this policy into API quote/approval and durable worker admission paths; never duplicate checks only in the UI.
3. Add the versioned plan catalogue and provider-price mapping with audited effective dates.
4. Add idempotent monthly credit grants from verified renewal events, then run margin and FX scenario tests.
5. Complete isolated Paddle/Pesapal sandbox and Neon/PostgreSQL staging acceptance before enabling checkout or paid generation.
