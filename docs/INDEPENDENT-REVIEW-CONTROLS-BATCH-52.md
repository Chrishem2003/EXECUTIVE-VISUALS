# Independent Review Controls — Batch 52

## Delivered

Batch 52 strengthens the shared-project remediation review lifecycle.

- Only the assigned reviewer or project owner may return a submitted action to the owner for rework.
- Review returns require a substantive note (8–1,000 characters in the UI; non-empty and bounded by the API).
- A review return is recorded as `review_changes_requested` in the append-only remediation history, with the note retained.
- A distinct reviewer must be assigned before an action can enter `pending_review`; this prevents actions becoming stranded in an unreviewable state.
- Status updates use a revision-and-status compare-and-set update inside a SQLite immediate transaction. Stale concurrent decisions return HTTP 409 rather than silently overwriting another decision.
- The Financial Command Centre exposes a reviewer feedback form for project-scoped actions with an assigned reviewer.
- Adds regression tests for viewer/editor denial, reviewer-authorized returns, mandatory review notes and missing-reviewer submission.

## Authorization model

- The assigned action owner can progress their work and submit it for review after evidence metadata exists.
- The assigned reviewer can independently verify or return submitted work with a review note.
- The project owner can return submitted work for rework.
- A project viewer and an ordinary editor cannot issue a review return.
- Review submission is rejected if no distinct reviewer is assigned.
- Personal records remain unable to self-verify.

The API remains authoritative; the UI is not an authorization boundary.

## Evidence and storage boundary

This batch still records metadata only. It does not upload evidence bytes, validate file signatures, compute server-side hashes, scan for malware, or provide private file download. A user-entered SHA-256 value remains an unverified assertion until a future storage-backed workflow calculates it from the received bytes.

OWASP recommends an allowlist of required file types, content/signature validation, server-generated filenames, size limits, authorization, isolated storage and malware scanning where available. See https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html.

## Verification

The focused workflow runs:
- `npm run verify:control-remediation-api`
- `npm run verify:control-remediation`
- `node --check server/control-remediation-api.mjs`
- `npm run typecheck`

No test result is claimed until the new branch workflow completes.

## Release status

Branch: `feat/independent-review-controls-batch-52`, based on Batch 51 commit `90e07e3c64f0ba298e555ab906b83fbdaacf5502`.

Draft review increment only. No merge, deployment, migration, payment, journal, subscription, entitlement or production configuration change is performed.
