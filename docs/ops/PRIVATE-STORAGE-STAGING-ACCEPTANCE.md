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


## Workflow availability and deployment safety
The manual `workflow_dispatch` trigger requires the workflow file on the default branch. The protected runtime acceptance job also runs on same-repository PRs authored by `Chrishem2003`, using only the GitHub `staging` environment and its secrets; fork PRs cannot access those secrets. This permits staging acceptance without merging to `main`. If required staging secrets or test identities are absent, the runtime job fails with a clear configuration error. Do not merge solely to unlock manual dispatch because Render automatically deploys commits to `main`.
