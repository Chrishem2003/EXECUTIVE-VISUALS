# Encrypted staging backup and integrity rehearsal

Run `Encrypted staging backup export` manually against the protected GitHub `staging` environment.

## Required secrets
- `SUPABASE_STAGING_URL`
- `SUPABASE_STAGING_SECRET_KEY`
- `SUPABASE_STAGING_DB_URL`
- `STAGING_BACKUP_ENCRYPTION_PASSPHRASE` (at least 24 characters; keep separately from the artifact)

## Export safety and coverage
- The exporter refuses every Supabase project except `bokxljngydmqrmktofwm`.
- The database URL must identify that exact project via its direct database host or Supabase pooler username/host combination; SSL mode is forced to require.
- The Storage bucket must exist and report `public=false` before export begins.
- Supabase modern secret keys are sent only in the `apikey` header; legacy service-role JWTs retain Bearer compatibility.
- The object inventory walks nested folder prefixes recursively and validates every object path against the owner/asset namespace.
- Database and object files are hashed as streams. Object bytes and database dump bytes are not loaded wholesale into memory.
- The archive uses AES-256-GCM with an scrypt-derived key. Plaintext temporary work files are removed in a finally block.

## Automatic artifact integrity rehearsal
Before artifact retention, the workflow decrypts the new archive into a disposable temporary directory, verifies the GCM authentication tag, checks every database/object byte count and SHA-256 hash against the manifest, and runs `pg_restore --list` against the custom-format database dump. The temporary plaintext extraction is removed after verification.

The encrypted artifact is retained for seven days only.

## Important limitation
This is **not yet a full database restore drill**. It proves authenticated decryption, archive extraction, manifest integrity, object-file recovery and that PostgreSQL recognizes the custom dump format. It does not restore the dump into a disposable Supabase-compatible database or prove application-level recovery. A full restore into an isolated Supabase-compatible environment remains mandatory before paid production launch.

GitHub Actions artifacts are temporary and are not a separately controlled off-site backup destination. Do not run this workflow against production until a separately approved production backup destination, encryption-key custody, retention policy and full restore procedure exist.
