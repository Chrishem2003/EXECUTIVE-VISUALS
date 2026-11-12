# Frame-Accurate Cloud Review

**Status:** Draft integration on the cloud-video worker branch. Cloud review writes require the review schema migrations; no production schema is changed by this implementation.

## Workflow

1. Open a cloud project and a saved timeline.
2. Add a private source asset as a timeline clip.
3. Move the playhead to the frame under review.
4. In **Review notes & decisions**, select the source asset, verify the frame number, and write a comment, approval, or change request.
5. Reviewers and editors see project-visible notes. Internal notes are restricted to the project owner, author, editors and reviewers.
6. The author or an editor resolves a note when the requested change is complete.

Each timeline-anchored review stores the project, source asset, timeline ID, exact saved timeline revision, frame number, frame-range duration when supplied, and a timecode calculated from the saved timeline frame rate. A later timeline revision does not silently move the original review anchor.

## API

- `GET /api/cloud/reviews?projectId=...`
- `POST /api/cloud/reviews`
- `GET /api/cloud/reviews/:reviewId`
- `PATCH /api/cloud/reviews/:reviewId`

All routes use the verified session identity. The request body cannot set the project owner, reviewer identity, review status, or audit actor. Create requests support idempotency keys. Updates use an `updated_at` compare-and-set and return a conflict if another editor changed the note.

## Security and audit

- Only owners, editors and reviewers may create comments; viewers are read-only.
- Only the comment author or a project editor may edit or resolve a note.
- Asset and timeline references are reloaded under the owning project's scope.
- Internal visibility is filtered by the server and enforced by row-level security.
- Review events are append-only and record the authenticated API actor.
- Drawing annotations accept only bounded normalized geometry; unrecognized fields, out-of-range coordinates and unsupported shapes are rejected.
- The existing cloud mutation CSRF gate covers review creation and updates.

## Database rollout

Apply these migrations only to a disposable CI database or an explicitly approved staging database, after the base project, asset and timeline schema:

1. `20261106130000_frame_accurate_review_foundation.sql`
2. `20261106150000_review_api_actor.sql`

The CI job runs both migrations and `scripts/cloud-reviews-postgres-integration.sql` against a disposable PostgreSQL service. Production migrations and deployment are intentionally excluded.

## Scope boundary

This milestone provides persistent project-scoped review comments, frame anchors, decisions, resolution and audit history. It does not trigger generation, rendering, publishing or paid provider calls. Real-time cursors, live presence, threaded replies and in-canvas drawing controls remain separate collaboration milestones.
