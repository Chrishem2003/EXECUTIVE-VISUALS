# Batch 141 — disposable database backup and restore rehearsal

The billing self-service CI job now performs a full custom-format PostgreSQL backup and restores it into a second, empty database in the same ephemeral PostgreSQL 16 service container.

## What is verified

- `pg_dump` creates a non-empty custom-format backup of the fully migrated disposable Supabase-compatible test database.
- `pg_restore --exit-on-error` restores the archive into a new database.
- Every table in `executive_visuals` has its source and restored row counts compared.
- The source and restored database are compared for application tables/views, functions, RLS policies, RLS-enabled relations and non-internal triggers.
- The restore database is dropped and the temporary backup file is removed even when the check fails.

## Boundaries

This is a real database restore drill against a disposable CI database, not a restore of the encrypted staging artifact. It does not prove that the staging backup passphrase is available, that the encrypted export decrypts, that Storage objects are all present, or that a production recovery point can be restored. Those require a separate staging artifact restore into an independently controlled target and must remain a paid-launch blocker until completed.

No staging or production database is accessed or changed. No external database credentials or storage credentials are used.
