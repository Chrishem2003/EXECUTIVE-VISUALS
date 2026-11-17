# Cloud media storage quotas

## Why this exists

The private media bucket must not silently grow beyond a free-tier allowance. Quotas are enforced in PostgreSQL at the `executive_visuals.assets` metadata boundary, not only in the API, so concurrent uploads cannot race past the cap.

## Initial staging defaults

- Global active asset bytes: **750 MiB**
- Per-owner active asset bytes: **512 MiB**
- Deleted assets (`deleted_at IS NOT NULL`) no longer consume the logical quota.
- A transaction-scoped advisory lock serializes quota-affecting inserts/restores.
- Missing quota configuration fails closed.
- The upload API returns HTTP 507 with a typed quota error and removes the just-uploaded object through the existing compensation path.

These defaults leave headroom below the Supabase Free storage allowance while the Executive Visuals project remains in staging.

## Usage endpoint

Authenticated application users can request `GET /api/cloud/assets/usage`. The server derives the owner from the verified session and returns global and owner usage, limits and remaining capacity. The underlying `get_asset_storage_usage` RPC is executable only by `service_role`; the limits table is not exposed to client roles. Cloud media readiness now verifies this RPC and fails closed if quota configuration is missing. The public API response contains only the requesting owner's counters; global usage and global quota details remain server-side.

## Future R2 configuration

Cloudflare R2's free tier includes 10 GB-month storage, 1 million Class A operations and 10 million Class B operations; egress is free. Before activating R2, an operator must explicitly enable the R2 subscription and create scoped credentials. Once a dedicated production bucket is approved, update the quota row to a conservative cap (for example 8 GiB global and 1 GiB per owner) so usage remains below the free allowance. Do not change the staging defaults or use the shared staging bucket as production.

## Limits of this guard

The quota measures non-deleted asset metadata. Orphaned objects are handled by the existing cleanup outbox and storage reconciliation worker. Before production enablement, verify object count/bytes against the provider's own metrics and alert on drift.


## Staging verification

Migration `20261117093508_add_cloud_asset_storage_quotas` is applied to the Executive Visuals staging project. The staging asset table was empty before application. A rolled-back SQL acceptance transaction verified 5/5 cases: initial upload within limits, per-owner cap rejection, global cap rejection, accurate usage counters and quota release after soft deletion. The test transaction left no records or modified quota values behind.
