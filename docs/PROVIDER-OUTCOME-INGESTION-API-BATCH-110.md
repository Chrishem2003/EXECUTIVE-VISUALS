# Batch 110 — authenticated provider outcome ingestion bridge

## Delivered

Adds a server-to-server endpoint for recording provider billing outcomes against
the durable task identity introduced in Batch 71 and the append-only evidence
register introduced in Batch 107.

POST /api/internal/provider-outcomes

The endpoint is rate-limited and does not require a customer session. It is
protected by a dedicated server-to-server bearer token. Separately, every evidence
envelope must pass the provider-adapter HMAC-SHA256 verifier from Batch 106.

## Trust boundaries

1. The internal bearer token authorizes the worker-to-platform channel. It is not
   accepted as provider billing evidence.
2. The server loads the task row from the private executive_visuals schema using
   its service-role credentials.
3. Provider, provider task ID, job ID and model are taken from that durable row.
   The expected provider account and route are loaded from server-only configuration.
   Caller-supplied identity cannot choose the expected task/account/route.
4. The HMAC verifier checks the signed envelope, freshness, amount/state combination,
   task identity and provider account/route.
5. USD provider amounts are converted from integer cents to integer micro-units.
   Other currencies are rejected until an explicit ISO currency exponent conversion
   policy is configured; no conversion is guessed.
6. The verified envelope is passed to the service-role-only Batch 107 database RPC.
   The database binds it again to the durable task state and stores the append-only
   evidence record.
7. The response explicitly reports that customer credits were not changed and no
   provider request was submitted by the ingestion endpoint.

## Required server-only configuration

- PROVIDER_OUTCOME_INGEST_TOKEN: random worker-channel bearer secret, at least
  32 bytes.
- PROVIDER_OUTCOME_EVIDENCE_HMAC_SECRET: independent provider-adapter HMAC
  secret, at least 32 bytes.
- PROVIDER_OUTCOME_PROVIDER_ACCOUNT_IDS_JSON: provider-to-account mapping, e.g.
  {"runway":"<configured-account-id>","fal":"<configured-account-id>"}.
- PROVIDER_OUTCOME_PROVIDER_ROUTES_JSON: provider-to-route mapping, e.g.
  {"runway":"runway-dev","fal":"fal"}.
- PROVIDER_OUTCOME_ADAPTER_ID and PROVIDER_OUTCOME_ADAPTER_VERSION: server
  adapter provenance.
- Existing SUPABASE_URL and server-role credential.

If any required setting is missing, the endpoint returns a fail-closed 503 and
is not enabled. Never expose these values to browser code, customers, source control,
logs or chat. Rotate both secrets independently.

## Envelope

The signed JSON envelope must include taskId, evidenceId, provider and account
identity, provider task ID, job ID, model, route, outcome, terminal state, currency,
integer amountMinor, billable seconds, reference count, audio mode, source
reference, canonical UTC observation timestamp and HMAC signature.

The HMAC canonicalization excludes only the signature field. The complete
envelope, including taskId, is signed. The provider adapter must sign only after
it has obtained provider-verifiable usage/receipt evidence.

## Tests

Unit tests cover:
- Worker bearer authentication before any task lookup.
- Server-loaded task identity and configured account/route matching.
- HMAC tamper rejection.
- Charged USD conversion to micro-units.
- Authenticated no-charge outcome with zero amount and zero billable seconds.
- Unknown outcome with no fabricated actual amount.
- Currency mismatch/unsupported currency rejection.
- Missing task, incomplete task identity and exact replay.
- Explicit invariant that ingestion does not modify customer credits.

## Deliberate limitation

This batch creates the secure ingestion boundary; it does not yet wire every provider
poller/webhook/invoice adapter to call it automatically. Provider-specific adapters
must still obtain trustworthy receipts and sign the envelope. It also does not settle
or release customer credits. Batch 105 and Batch 109 safeguards remain in force:
provider no-charge evidence alone cannot refund customer credits, because other
variable costs may still have been incurred.

No provider request, customer charge, production migration, production deployment,
merge or new paid infrastructure is included.
