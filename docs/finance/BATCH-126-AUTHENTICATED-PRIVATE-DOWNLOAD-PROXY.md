# Batch 126 — Authenticated private-download proxy integration

## What changed

- The authenticated Cloud Timeline API now exposes `getPrivateAssetDownload`, which resolves a private asset through the existing owner/project authorization path and returns its verified asset metadata plus a short-lived signed storage URL.
- When `PRIVATE_ASSET_EGRESS_PROXY_ENABLED=true`, `GET /api/cloud/assets/:assetId` is handled by the application as a server-side streaming proxy instead of returning a signed URL to the browser.
- The proxy validates the signed URL against the configured private storage origin, disables redirects, forwards one syntactically valid byte range, supports upstream 200/206 responses, and streams through Batch 125's byte counter.
- Downloads are rate limited per authenticated account. Response headers are private/no-store and include nosniff protection.
- The measurement recorder uses the existing immutable asset-event RPC and a configured platform finance actor. Startup verifies that the actor is currently an owner/platform_admin/billing_admin before enabling the proxy.
- Health output reports whether the proxy and recorder are enabled/configured without disclosing the actor ID.
- The old signed-URL behavior remains unchanged when the feature flag is off.

## Required configuration

Enable only after the Batch 123/124 database migrations are applied and tested in the target environment:

- `PRIVATE_ASSET_EGRESS_PROXY_ENABLED=true`
- `ASSET_RESOURCE_FINANCE_ACTOR_ID=<UUID of an active platform owner/platform_admin/billing_admin>`
- Existing verified Supabase cloud media configuration and private bucket readiness.

If the feature flag is on but authentication, the finance actor, or required server credentials are missing, the process fails at startup rather than silently issuing unmetered proxy downloads.

## Evidence semantics

The ledger records bytes accepted by the outgoing Node response write callbacks. This is stronger than signed URL issuance, upstream Content-Length, or requested range size. It is not proof that a browser saved the file or that the user application persisted every byte. A separate retry is a new transfer and gets a new transfer identity.

## Known limitation / next hardening

The final immutable egress event is written after the response stream completes or is interrupted, because actual transferred bytes are not known before streaming. A database outage during that final write can leave a delivered transfer without a persisted event. The route does not charge customer credits, and the event recorder never invents bytes, but production-grade financial reconciliation still needs a durable transfer-attempt journal/outbox with retry and an explicit unreconciled-transfer alert. This must be added and verified before enabling the feature in production.

The RPC currently requires the configured finance actor and service-role execution; customer-supplied actor IDs are never accepted.

## Safety

No customer wallet mutation, subscription charge, provider dispatch, production migration/deployment, paid infrastructure or merge is performed by this batch.
