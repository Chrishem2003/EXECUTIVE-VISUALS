# Timeline revision history

## Overview

Cloud timeline revision history stores immutable snapshots of each timeline revision. The database captures the initial timeline and each successful revision update in the same transaction as the current timeline write.

## Data and access model

- \`executive_visuals.timeline_revisions\` is keyed by \`(timeline_id, revision)\`.
- Snapshots include the timeline JSON, optional OTIO interchange document, name, project/owner scope, revision number and capture timestamp.
- A database trigger captures new revisions and a backfill stores the current revision for existing active timelines.
- Row-level security permits reads only to the owner and authorized project members.
- Authenticated clients receive SELECT only. Client INSERT, UPDATE and DELETE are revoked; snapshot writes occur through a server-owned trigger.
- The API first resolves the current timeline through the existing owner/project authorization boundary before returning its revision list or a specific snapshot.

## User workflow

1. Open a cloud timeline and choose **Revision history**.
2. The list endpoint returns metadata only, capped at 50 revisions by default. This avoids sending every historical timeline document to the browser.
3. Choose **Compare** to fetch one snapshot and compare it with the current timeline using the existing variant comparison engine.
4. Choose **Restore** to load that snapshot into the current timeline and save it using the existing expected-revision check.
5. A restore is a new revision with \`restoredFromRevision\` metadata. Earlier snapshots remain unchanged.

## Rollout and limits

- This is cloud-only. Local SQLite timeline history is not changed.
- The migration is additive and must be reviewed and applied in staging before enabling this feature in a deployed environment.
- No migration is applied automatically by this code change.
- The UI only exposes history in cloud mode.
- The revision list is limited to the newest 50 by default; the API supports bounded pagination.
- Revision history is not a substitute for backups or disaster recovery.

## Validation

Run `npm run verify:timeline`, `npm run verify:cloud-queue`, and `npm run typecheck` before review. The migration itself remains unapplied until separately approved for staging.


## Migration operations

The additive migration is named `20261120100000_timeline_revision_history.sql` so it follows the currently committed migration sequence. It is not applied automatically; apply it only after reviewing the isolated Supabase project, RLS policies and backup/restore posture.
