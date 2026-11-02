# Cloud asset deletion cleanup

Cloud asset deletion is a two-stage operation:

1. The authorized user operation writes `deleted_at` to the asset metadata row. Normal listing, lookup and signed-URL operations then stop exposing the asset.
2. The repository attempts to remove the private storage object. If storage is temporarily unavailable, the tombstone remains so a later cleanup pass can retry.

## Retry contract

`createCloudAssetRepository().cleanupDeleted({ olderThan, limit })` is an internal maintenance operation. It is deliberately not exposed as an end-user HTTP route.

- `olderThan` is a required, explicit ISO-8601 UTC cutoff. Only rows with `deleted_at` older than this cutoff are candidates.
- `limit` is required by the API contract to be an integer from 1 to 100 (default 25).
- Active rows are never selected by the database filter.
- Every candidate must have valid UUID ownership fields, the expected private bucket, and an object path beneath its owner/project and asset ID prefix.
- Invalid metadata is counted as skipped and is never passed to storage.
- Storage failures remain tombstoned and are counted as pending for a later retry.
- The operation does not delete metadata rows, alter active assets, or remove project records.

## Scheduling and rollout

Run this only from a trusted server-side maintenance worker with the service-role credential. Choose a conservative age cutoff (for example, at least 24 hours after deletion), use small batches, record aggregate counts, and alert on persistent pending cleanup. Do not expose the service-role credential or this maintenance method to browsers or ordinary users.

This repository change supplies the bounded, retryable operation and tests. It does not schedule it, run it against a live storage bucket, or change production data. Production scheduling should wait until the cloud storage lifecycle and hosted worker deployment are separately verified.
