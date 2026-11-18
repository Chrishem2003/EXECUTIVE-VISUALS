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
