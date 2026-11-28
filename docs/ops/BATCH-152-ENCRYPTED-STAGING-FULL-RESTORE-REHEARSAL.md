# Batch 152 — Encrypted staging full restore rehearsal

## Problem

The prior backup acceptance decrypted the archive, verified the manifest and object hashes, and ran `pg_restore --list`. It did not restore the database into a disposable PostgreSQL instance or copy objects back to a filesystem destination. That was archive-integrity evidence, not a full restore drill.

## Implementation

The backup verifier now optionally performs a full restore when both `RESTORE_DATABASE_URL` and `RESTORE_OBJECTS_DIR` are supplied.

- The database target is restricted to local `restore_test` PostgreSQL on localhost/loopback. Remote hosts, other database names and non-PostgreSQL URLs are rejected before any command runs.
- A minimal disposable `auth.users` compatibility table is created. The script parses the database dump's foreign-key DDL and inserts placeholder UUID-only auth identities for the referenced `auth.users(id)` keys. It does not export or restore email addresses, passwords, tokens, profile metadata or production identities.
- The custom-format dump is restored in pre-data, data and post-data phases so placeholder identity rows exist before foreign-key constraints are created and validated.
- A post-restore SQL assertion checks that application tables exist, auth-user foreign keys were restored, and no foreign key remains unvalidated.
- Private object files are copied to a temporary local restore directory under their original owner/asset paths and checksummed again.
- The workflow removes restored plaintext objects in an `always()` cleanup step.
- The manual backup workflow now starts an ephemeral PostgreSQL 17 service and completes the restore rehearsal before retaining the encrypted artifact.

## Tests

Unit tests cover:
- Parsing single-column foreign keys to `auth.users(id)`.
- Missing foreign-key metadata rejection.
- Correct restore order: pre-data → data → placeholder identities → post-data.
- Restored private object path and checksum.
- Rejection of remote restore targets and incomplete restore configuration.
- Existing wrong-passphrase, tamper, path traversal, duplicate entry, checksum and private-bucket checks.

Pull-request CI additionally runs a synthetic encrypted snapshot through a real PostgreSQL 17 service container. It verifies restored application rows, UUID-only placeholder identities, validated auth foreign keys and private object bytes without staging secrets or customer data.

The full staging restore runs only when an owner manually starts the encrypted staging backup workflow after configuring the protected staging environment.

## Safety

- The source must be the approved Supabase staging project and private bucket.
- The target is an ephemeral local PostgreSQL 17 container, never Supabase, Neon, Render or production.
- Only UUID placeholders needed to satisfy application foreign keys are inserted into the disposable restore target.
- No real auth user records, customer passwords, payment credentials or tokens are exported.
- No live billing, provider calls, credit changes, production migration or deployment occurs.
- Only the encrypted backup artifact is retained for seven days; decrypted database and object restore data are removed from the runner.
