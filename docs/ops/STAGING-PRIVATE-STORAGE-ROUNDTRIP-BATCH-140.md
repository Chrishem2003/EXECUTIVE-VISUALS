# Batch 140 — staging private-storage round-trip acceptance

This is a manual, staging-only acceptance workflow. It does not run during pull-request validation and does not use production credentials.

## Required GitHub staging environment secrets

- `SUPABASE_STAGING_URL` — must resolve to the approved staging project `bokxljngydmqrmktofwm.supabase.co`.
- `SUPABASE_STAGING_SECRET_KEY` — staging-only server secret key (or the staging service-role key).
- `STORAGE_TEST_OWNER_ID` — UUID of an existing disposable staging account.

The workflow deliberately does not print secret values. If any required value is missing, the script reports `BLOCKED` and exits non-zero.

## Acceptance procedure

1. Upload a small synthetic JSON object through the same private asset repository used by the application.
2. Confirm returned asset metadata and SHA-256 match the upload.
3. Request a 60-second signed URL through owner-scoped metadata authorization.
4. Download the bytes through that URL and verify exact byte equality and SHA-256.
5. Attempt to sign the same asset as a different random owner and require a not-found/access-denied result.
6. Soft-delete the disposable asset and require confirmed deletion. If cleanup fails, inspect the existing storage cleanup ledger.

## Safety boundaries

- No public bucket is created or enabled.
- No R2 resources or paid infrastructure are provisioned.
- No real customer asset is accessed.
- The only storage mutation is one disposable synthetic object in the existing private staging bucket.
- The workflow never accepts a production Supabase URL.
- A passing run proves this specific staging storage path and tenant boundary; it does not prove all project-member, large-file, worker publication or production restore scenarios.
