# Private storage staging acceptance

Run `Private storage staging acceptance` manually from GitHub Actions against the staging environment only.

Required GitHub Environment `staging` configuration:
- Secret `SUPABASE_STAGING_URL`: staging project API URL.
- Secret `SUPABASE_STAGING_ANON_KEY`: staging publishable/anon key.
- Secret `STORAGE_TEST_OWNER_JWT`: short-lived authenticated JWT for a disposable staging owner.
- Secret `STORAGE_TEST_OTHER_JWT`: short-lived authenticated JWT for a different disposable staging tenant.
- Variable `STORAGE_TEST_OWNER_ID`: UUID matching the owner JWT subject and first folder segment accepted by the bucket policies.

The test uploads a unique small binary, verifies owner download and SHA-256 equality, confirms a second tenant and the public URL cannot read it, creates and downloads a 60-second signed URL, and deletes the temporary object in a finally block.

Use disposable staging identities only. Never use production JWTs, production project URLs, service-role keys, or customer assets. The script intentionally does not print tokens or response authorization headers. A signed URL is a bearer capability until expiry; do not log or share it.

A successful workflow proves only the tested staging bucket and identities. It does not establish production storage readiness or object-backup coverage.
