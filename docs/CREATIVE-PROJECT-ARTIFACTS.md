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
