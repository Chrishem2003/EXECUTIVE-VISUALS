# Timeline version history

P1.2 introduces immutable, named revision snapshots for local and cloud timelines.

## Version model

Each saved revision stores:

- The complete timeline document and optional OpenTimelineIO interchange document.
- A SHA-256 content hash for integrity checks.
- The actor who created the revision and a short editorial summary.
- A parent version pointing to the previous head.
- An optional restored-from version pointing to the historical snapshot selected for restoration.

A restore never rewrites an earlier snapshot. It creates a new timeline revision whose parent is the previous head and whose restored-from link identifies the chosen historical version. The timeline's current revision is advanced with optimistic revision fencing.

## Local API

- `GET /api/timelines/:timelineId/versions` — list up to 100 revisions.
- `GET /api/timelines/:timelineId/versions/:versionId` — fetch and integrity-check a full snapshot.
- `POST /api/timelines/:timelineId/restore` — body: `{ expectedRevision, sourceVersionId, summary? }`.

Local creation and update write the timeline row, version row and audit event in one SQLite transaction. Restore validates the selected snapshot against current asset access and timeline rules before updating the head and appending a new version in one transaction. Existing local timelines receive a baseline when first updated after this feature is installed.

## Cloud API

- `GET /api/cloud/timelines/:timelineId/versions`
- `GET /api/cloud/timelines/:timelineId/versions/:versionId`
- `POST /api/cloud/timelines/:timelineId/restore`

Cloud create, update and restore use the version RPC functions in `20261105170000_timeline_versions.sql`. Each RPC locks the timeline row, checks its expected revision, updates the current head and appends its immutable snapshot in one PostgreSQL transaction. The version table is RLS-forced, inaccessible to public/anon/authenticated roles, and the service role has select/insert but no update/delete privileges. Existing cloud timelines are backfilled with a baseline snapshot by the migration.

## Comparison and integrity

The editor loads version metadata first, fetches the selected snapshot on demand, and compares it with the current timeline using the deterministic structural comparison engine. Comparison is read-only. Snapshots with a mismatched SHA-256 hash are rejected rather than shown as trustworthy history.

## Boundaries

- Versions are per timeline; they do not merge two independent timelines.
- Restore requires current editor permission and the current expected revision.
- Historical snapshots that reference assets no longer accessible or valid are not restored.
- Version retention/archival policy, collaborative selective undo and branch/merge workflows are future work.
- The migration is source-controlled and covered by a disposable PostgreSQL integration harness. It has not been applied to shared staging or production.
