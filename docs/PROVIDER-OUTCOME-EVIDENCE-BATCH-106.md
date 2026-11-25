# Batch 106 — authenticated provider outcome evidence

This batch introduces a strict, adapter-side evidence verifier. It is deliberately
not a credit-release or settlement endpoint.

## Trust boundary

- The verifier secret must be loaded by trusted server code from provider-adapter
  configuration. Never accept a secret, `signatureVerified` boolean, or verified
  object from a customer request.
- The server must load the expected provider, provider account, task ID, job ID,
  model and route from its durable task record and pass that record as `expected`.
- HMAC-SHA256 binds the canonical evidence payload. Evidence identity, task identity,
  amount, currency, terminal state, usage dimensions and source reference are covered.
- Stale, future-dated, malformed, mismatched or tampered evidence is rejected.
- `no_charge` is accepted only when the authenticated envelope reports zero actual
  amount and zero billable seconds. It is provider-cost evidence, not a customer-credit
  release instruction; successful output may still consume customer credits.
  `unknown` remains reconciliation-only.
- Evidence IDs generate deterministic idempotency keys scoped to provider and task.

## Deliberate limitations

The current provider APIs do not all expose the same signed webhook format. This
verifier is a trusted internal adapter contract, not proof that a provider has
authenticated a payload merely because a caller can construct JSON. Each provider
adapter must obtain the outcome through an authenticated provider channel or verify
the provider's documented signature before creating the internal envelope.

This batch does not write evidence to PostgreSQL, decide customer-credit settlement or
release, call providers, or change dispatch. The Batch 105 database guard
remains in force until a separate migration adds durable evidence storage, adapter
identity/permissions, atomic idempotent settlement/release RPCs and disposable
PostgreSQL concurrency tests. Do not connect this verifier directly to customer
input or use its result as a standalone database authorization.
