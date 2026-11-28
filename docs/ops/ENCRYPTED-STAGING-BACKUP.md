# Encrypted staging backup and full restore rehearsal

Run `Encrypted staging backup export` manually against the protected GitHub `staging` environment. The workflow does not run automatically on pull requests because it exports staging data and retains an encrypted artifact.

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
- The archive uses AES-256-GCM with an scrypt-derived key. Plaintext temporary work files are removed in a `finally` block.

## Full restore rehearsal performed before artifact retention

After export, the manual workflow decrypts and verifies the artifact, then performs a real restore into an ephemeral PostgreSQL 17 service container on the GitHub Actions runner:

1. Verify the AES-GCM authentication tag, manifest, database checksum, every object checksum and object inventory.
2. Ask `pg_restore` to inspect the custom-format dump.
3. Create a minimal local-only Supabase Auth compatibility schema and disposable roles. No real `auth.users` rows or personal identity fields are exported.
4. Restore the Executive Visuals schema's pre-data and data sections into the disposable database.
5. Parse the dump's foreign-key DDL and insert placeholder `auth.users.id` rows for the referenced UUIDs only. These are synthetic restore identities, not usable accounts.
6. Restore post-data indexes, constraints, policies and triggers. Verify that application tables and auth foreign keys exist and that no foreign key remains unvalidated.
7. Restore private object files to a temporary local directory using their original owner/asset paths and verify their checksums again.
8. Remove the restored plaintext object directory even when the job fails.
9. Retain only the encrypted `.evb` artifact for seven days.

The restore script rejects every remote database target. It only accepts a local `restore_test` PostgreSQL database on `localhost`, `127.0.0.1` or `::1`.

Pull-request CI also creates a synthetic encrypted snapshot and restores it into a real PostgreSQL 17 service container. It verifies two application rows, UUID-only auth placeholders, validated foreign keys and a restored object checksum without accessing staging secrets or real customer data.

The workflow's success therefore means the actual exported staging database dump and private object files were decrypted, restored into disposable local targets, and verified. It does not mean a production database has been restored or that a live Supabase project was changed.

## Remaining operational limitation

GitHub Actions artifacts are temporary and are not a separately controlled off-site backup destination. Before paid production launch, establish an approved independent backup destination, encryption-key custody, retention policy, restore ownership and a scheduled restore exercise. Do not run this workflow against production until that separate production backup plan is reviewed and approved.
