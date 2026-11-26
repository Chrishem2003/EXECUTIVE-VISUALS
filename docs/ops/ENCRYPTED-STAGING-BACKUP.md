# Encrypted staging backup export

Run `Encrypted staging backup export` manually against the GitHub `staging` environment.

Required secrets:
- `SUPABASE_STAGING_URL`
- `SUPABASE_STAGING_SECRET_KEY` (staging-only Storage API inventory/download access)
- `SUPABASE_STAGING_DB_URL` (staging-only PostgreSQL connection string)
- `STAGING_BACKUP_ENCRYPTION_PASSPHRASE` (at least 24 characters; keep separately from the artifact)

The job runs `pg_dump` in custom format, inventories and downloads every object from the configured private bucket, creates a manifest with byte counts and SHA-256 hashes, packages the files, and encrypts the archive using AES-256-GCM with a key derived by scrypt. Plaintext work files are removed in a finally block. Before upload, a second step decrypts the archive in a temporary directory, checks the AES-GCM authentication tag, verifies the manifest and all SHA-256 object/database hashes, and confirms `pg_restore --list` can parse the PostgreSQL dump. Temporary plaintext is deleted after verification. The encrypted artifact is retained for seven days.

Important limitations:
- This is an encrypted staging export and integrity manifest, not an independent disaster-recovery system.
- GitHub Actions artifacts are temporary (seven-day retention) and are not a substitute for a separately controlled off-site backup destination.
- This job does not perform a restore. A restore drill into an isolated Supabase-compatible environment remains mandatory before production launch.
- Database dump and Storage object data are separate; both are included because Supabase database backups do not contain Storage object bytes.
- Never run against production until a separately approved production backup destination, encryption-key custody, retention, and restore procedure exist.


The exporter traverses nested Storage folders (not just bucket-root objects), paginates each prefix, enforces a 100,000-object/folder safety ceiling, and stores each object under a generated numeric archive filename while preserving its original Storage key in the manifest. The verifier checks archive paths before extraction and validates manifest file names before reading objects. This export is not a transactionally consistent point-in-time snapshot while uploads are changing; quiesce writes or schedule a maintenance window for a restore-grade backup.

## Workflow availability and deployment safety
These workflows currently live on a review branch. GitHub manual `workflow_dispatch` and scheduled `schedule` runs require the workflow file to be present on the repository's default branch. Do not merge this PR to `main` solely to unlock testing: the Executive Visuals Render web service automatically deploys commits to `main`. First establish a safe staging execution path or explicitly approve a controlled deployment/configuration change. Until then, the PR-triggered static checks are the only GitHub Actions evidence; the manual runtime acceptance is pending.
