# Private storage staging acceptance

Run `Private storage staging acceptance` manually from GitHub Actions against the staging environment only.

Required GitHub Environment `staging` configuration:
- Secret `SUPABASE_STAGING_URL`: staging project API URL.
- Secret `SUPABASE_STAGING_ANON_KEY`: staging publishable/anon key.
- Secrets `STORAGE_TEST_OWNER_EMAIL` and `STORAGE_TEST_OWNER_PASSWORD`: credentials for a disposable staging owner account.
- Secrets `STORAGE_TEST_OTHER_EMAIL` and `STORAGE_TEST_OTHER_PASSWORD`: credentials for a second, different disposable staging account.
- Variable `STORAGE_TEST_OWNER_ID`: UUID matching the owner's Supabase Auth user ID and first folder segment accepted by the bucket policies.

The test obtains short-lived access tokens at runtime using the Supabase password grant; no static JWT is stored in GitHub and no token is printed.

The test uploads a unique small binary, verifies owner download and SHA-256 equality, confirms a second tenant and the public URL cannot read it, creates and downloads a 60-second signed URL, and deletes the temporary object in a finally block.

Use disposable staging identities only. Never use production JWTs, production project URLs, service-role keys, or customer assets. The script intentionally does not print tokens or response authorization headers. A signed URL is a bearer capability until expiry; do not log or share it.

A successful workflow proves only the tested staging bucket and identities. It does not establish production storage readiness or object-backup coverage.
