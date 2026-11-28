# Application PostgreSQL cutover gap analysis — 2026-11-28

This assessment compares the current application persistence implementation with the connected Supabase staging schema. It is not a migration and changes no data.

## Current application database path

- `server/index.mjs` imports `openDatabase` from `server/db.mjs`.
- `server/db.mjs` imports Node's `DatabaseSync` from `node:sqlite`.
- The default database file is `DATA_DIR/executive-visuals.sqlite`, overridable with `DB_FILE`.
- The health endpoint reports `database: "sqlite"`.
- The existing Render staging service is Free, tracks `main`, and has no persistent disk/health-check configuration verified.

This is not a PostgreSQL application cutover. Having Supabase PostgreSQL tables for cloud features, billing and financial controls does not change the main application's SQLite repository.

## Schema inventory

The SQLite repository declares 26 application tables. A read-only comparison against the approved Supabase staging schema found 15 corresponding tables and 11 missing tables.

### Existing PostgreSQL counterparts (15)

`assets`, `audit_events`, `consents`, `job_events`, `jobs`, `project_members`, `project_workspace_documents`, `projects`, `reviews`, `timelines`, `video_generation_approvals`, `video_pipeline_checkpoints`, `workflow_node_runs`, `workflow_runs`, `workflows`.

These are not drop-in replacements. Important column-name and representation differences include:

| SQLite field | Supabase PostgreSQL field |
|---|---|
| `projects.settings_json` | `projects.settings` (JSONB) |
| `project_workspace_documents.document_json` | `project_workspace_documents.document` (JSONB) |
| `assets.storage_path` | `assets.storage_bucket` + `assets.object_path` |
| `assets.metadata_json` | `assets.metadata` (JSONB) |
| `workflows.graph_json` | `workflows.graph` (JSONB) |
| `jobs.input_json/output_json/error_json` | `jobs.input/output/error` (JSONB) |
| `workflow_runs.snapshot_json/error_json` | `workflow_runs.snapshot/error` (JSONB) |
| `job_events.event_json` | `job_events.event_data` (JSONB) |
| `audit_events.details_json` | `audit_events.details` (JSONB) |

Other tables also have differing columns, constraints, RLS policies and server-managed metadata. A direct table-name match is not enough to switch the runtime.

### Missing SQLite counterparts (11)

- `control_remediation_actions`
- `control_remediation_evidence`
- `control_remediation_history`
- `creative_graph_snapshots`
- `creative_project_artifacts`
- `evidence_record_events`
- `evidence_records`
- `model_usage_events`
- `sessions`
- `transformation_plans`
- `users`

The missing `users` table should map to Supabase Auth's `auth.users`, not be recreated as a second password database. The current encrypted Supabase session store still requires a SQLite-compatible `db.prepare`/ `db.exec` database and references the local `users` table. It therefore also needs a PostgreSQL-backed implementation before SQLite can be removed.

Some missing SQLite records may have newer PostgreSQL equivalents (for example, AI usage-cost events or financial remediation records), but those are not automatically equivalent to the current SQLite APIs. A deliberate mapping and data-retention plan is required.

## Required engineering sequence

1. Define a typed asynchronous repository contract for the app's core entities. Do not attempt to emulate synchronous SQLite `prepare().get/all/run` with a remote database.
2. Implement and test PostgreSQL repositories for users/auth references, encrypted sessions, projects, memberships, assets, workflows, jobs, workflow runs, node runs, job events, audit events, reviews, timelines and consents.
3. Add additive PostgreSQL tables for evidence, creative artifacts/graph snapshots, transformations, model usage and control remediation only where no equivalent exists. Reuse existing tables only after column and lifecycle equivalence is demonstrated.
4. Add transactional outbox/lease/idempotency handling for jobs and credit accounting; preserve existing lease fencing and settlement guarantees.
5. Build a one-way, repeatable SQLite export/import tool with row counts, checksums, foreign-key validation and a rollback plan. Do not delete the SQLite source during migration.
6. Run dual-read/compare or shadow-write verification in isolated staging, then switch one bounded domain at a time.
7. Change the health endpoint to report PostgreSQL only after the primary application repository actually uses it. Keep SQLite available for rollback until the verification window is complete.

## Cutover acceptance criteria

- No application route depends on `DatabaseSync` or the local SQLite file for customer-critical state.
- Session tokens remain encrypted at rest, with rotation, expiry and revocation semantics preserved.
- Tenant ownership, project membership, RLS and signed private storage paths remain equivalent or stronger.
- Job lease fencing, retries, idempotency, credit reservation and settlement remain transactional.
- Import checksums and counts reconcile with no silent loss.
- Backup/restore is rehearsed against the PostgreSQL application database.
- The staging runtime health endpoint reports PostgreSQL and the runtime readiness workflow passes.
- Rollback to the untouched SQLite source is documented until owner approval for cutover.

## Safety boundary

No SQLite data was copied, dropped or rewritten by this assessment. No Render environment variable or service was changed. No production migration or deployment occurred. The PostgreSQL cutover remains a major engineering batch, not a one-variable configuration change.
