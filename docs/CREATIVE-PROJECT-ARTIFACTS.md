# Versioned Creative Project Artifacts

## Purpose

Creative Director and Storyboard Compiler outputs are production inputs, not transient chat responses. When a generation request includes an authorized project ID, the API stores the validated result as an immutable, versioned project artifact before returning success.

## Supported artifact types

- `creative_direction`: validated Creative Director plan, original brief input, model identity, usage metadata and input/content SHA-256 hashes.
- `storyboard`: validated scenes, timed shots, continuity rules and character suggestions, plus original compiler input and model/usage metadata.

Each project has an independent monotonically increasing revision sequence for each artifact type. Revisions are append-only and cannot be updated or deleted through the application database.

## API

- `POST /api/creative/director` with `projectId` and `input` generates and persists a creative-direction revision.
- `POST /api/creative/storyboard` with `projectId` and `input` generates and persists a storyboard revision.
- `GET /api/projects/:projectId/creative-artifacts` lists the latest 20 artifacts. Optional `type=creative_direction|storyboard` and `limit=1..100` filters are supported.
- `GET /api/projects/:projectId/creative-artifacts/:artifactId` retrieves one artifact, scoped to its project.

The existing project-access check applies to reads. Generation requires owner/editor write access before any model request is sent. A request without a project ID can still return a validated transient result, but it explicitly reports `persistence.saved=false`.

## Integrity and safety

- Structured input and output are bounded to 512 KiB each.
- Input hashes are validated as SHA-256; content hashes are computed over canonical JSON.
- Revision allocation and insertion run inside one `BEGIN IMMEDIATE` transaction.
- Artifact rows are immutable; revisions preserve prior generated results.
- Provider credentials and raw prompts are not copied into audit metadata. The original structured brief/compiler input is retained as project data.
- No model call, provider job, media generation, billing reservation or storage configuration is triggered by artifact retrieval.

## Durability boundary

The current implementation writes to the application's SQLite database. API responses expose the configured runtime storage classification and deliberately report `durableAcrossDeploys=false`. This is versioned persistence within the active application database, not proof of a durable hosted primary database or verified backup/restore. The production SQLite/local-disk and cloud-primary persistence blockers remain open until isolated database configuration and restore acceptance are completed.

## Saving reviewed storyboard edits

Model-generated storyboards are immutable source revisions. After editing scene or shot fields in the Creative Director workspace, an owner or editor can explicitly save the current reviewed storyboard as a new revision using:

`POST /api/projects/:projectId/creative-artifacts/:artifactId/revisions`

The server checks project write access, confirms that the source artifact is a storyboard, preserves the original input hash and model/usage lineage, validates the edited storyboard structure and timing, and appends a new immutable revision in the existing transaction-safe artifact store. It never updates or deletes the source revision. A no-op save returns the existing revision without creating a duplicate. Invalid timing, duplicate IDs, changed input lineage, oversized content, or cross-project artifact IDs are rejected.

The UI exposes **Save edited revision** next to storyboard export and timeline creation. After a successful save it updates the active revision pointer and refreshes version history. Restoring an older revision still retrieves the immutable historical content; saving edits after restore creates another new revision rather than rewriting history.

This feature improves version recovery within the current SQLite runtime. It does not change the storage durability boundary: the API continues to report `durableAcrossDeploys=false` until the hosted primary database and backup/restore path are independently configured and verified.

## Durable Supabase Postgres storage (staging-gated)

The optional Postgres repository is selected only when `CREATIVE_ARTIFACTS_POSTGRES_ENABLED=true`, `AUTH_MODE=supabase`, and server-side Supabase credentials are present. The default remains SQLite. No production environment variable is changed by this code.

The repository uses the existing `executive_visuals` schema and the same UUID as the local project. Before the first cloud read or write for a project in each server process, it performs an idempotent legacy backfill from the local SQLite artifact history. It preserves original artifact UUIDs, revision numbers, input/content hashes, model/usage lineage and creator IDs; it rejects ID/hash conflicts or non-contiguous cloud history rather than overwriting data. Before writing an artifact it verifies or creates the matching cloud project row using the local project's owner ID, name and description. An existing cloud project owned by another user or an archived project is rejected. Owners may provision their matching cloud project record; editors must already be members with the `editor` role in the cloud project before generation or writes are allowed. The API preflights that authorization before starting Creative Director/storyboard model work. The Postgres append RPC serializes revision allocation by locking the project row, independently checks owner/editor membership, and writes the immutable artifact in one transaction. The table has RLS enabled, is not granted to `public`, `anon`, or `authenticated`, and only the server-side `service_role` may read or append. An immutable trigger rejects updates and deletes.

The API reports `backend: "supabase-postgres"` and `durableAcrossDeploys: true` only when this repository is enabled. The feature flag remains off by default. Local SQLite remains the fallback and continues to report `durableAcrossDeploys: false`.

### Staging bootstrap

`scripts/creative-project-artifacts-postgres-bootstrap.sql` is a bootstrap/integration fixture for a dedicated Executive Visuals development database. It is not permission to apply schema changes to either shared Supabase project. Generate the canonical migration with the locally installed Supabase CLI (`supabase migration new creative_project_artifacts`), transfer the reviewed SQL into that generated migration, run it against a disposable/local database first, and verify the migration list and security/performance advisors. Supabase CLI v3 now targets the local stack by default; hosted database changes require explicit `--remote` and confirmation. Do not run a hosted migration until a separately isolated Executive Visuals staging project has been approved and verified.

The repository's PostgREST requests use the `executive_visuals` profile and a server-only secret/service-role key. The key is never returned to the browser. The Data API must expose the existing `executive_visuals` schema; table privileges remain limited to `service_role`, with RLS enabled as defense in depth.

The CI pipeline validates the SQL against a disposable PostgreSQL 16 service, not a hosted Supabase project. It exercises the actual append RPC, owner/editor acceptance, reviewer/viewer rejection, service-role-only grants, immutable update/delete triggers, revision lineage and ten concurrent appends. This provides a no-hosted-cost database integration gate; it does not replace the final isolated Supabase staging acceptance or backup/restore test.

The same disposable CI database is also exposed through a local PostgREST 12.2 HTTP service using a temporary HS256 service-role JWT. The repository adapter is exercised over real HTTP for schema-profile routing, service-role authentication, anon/authenticated denial, owner/editor preflight, create/read/list, storyboard revision append and no-op detection. The local adapter accepts a configurable REST path for this harness; hosted Supabase continues to use the default `/rest/v1` path.

### Remaining acceptance gate

This implementation is not yet enabled in Render. Before enabling it in staging, run the SQL bootstrap/migration on an isolated database and verify: project bootstrap and owner mismatch rejection; owner/editor writes; reviewer/viewer denial; cross-project reads return no records; concurrent append calls receive unique ordered revisions; no UPDATE/DELETE succeeds; restart and deployment recovery; and backup/restore. The app's ordinary audit log remains in the existing SQLite store; this milestone makes creative artifact records durable, not every local audit or project record.
