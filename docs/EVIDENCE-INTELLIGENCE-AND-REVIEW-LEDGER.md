# Evidence intelligence and review ledger

**Status:** durable, project-scoped evidence submission and human-review APIs are implemented on the feature branch. The ledger is append-only at the event-history level. It does not claim that a reviewer can establish objective truth merely by accepting a source.

## Evidence lifecycle

1. An authenticated project editor submits an evidence record against an existing source asset.
2. The API snapshots the source asset SHA-256 and stores the target reference (project, scene, shot, timeline or asset), evidence kind, claim, method, source reference, observation time and notes.
3. Every submission creates a `submitted` event.
4. An authorized project owner, editor or reviewer may mark the record `needs_review`, `verified` or `rejected`, with a review note.
5. Every review creates a separate event recording the reviewer and decision. A terminal `verified` or `rejected` record cannot be silently rewritten; a new record is required to supersede it.

The source asset row is referenced by foreign key, and the evidence record retains the SHA-256 value that was current at submission. If the source is replaced by a derivative, the evidence record continues to identify the original source hash.

## API

All routes require an authenticated session and the same project/asset access boundary as the asset API.

- `GET /api/assets/:assetId/evidence` — list evidence submitted against an asset.
- `POST /api/assets/:assetId/evidence` — submit evidence. Body fields: `targetType`, `targetId`, `kind`, `claim`, and optional `method`, `sourceRef`, `observedAt`, `note`. The server always assigns `submitted`; clients cannot self-verify.
- `POST /api/assets/:assetId/evidence/:evidenceId/review` — review with `status` (`needs_review`, `verified`, `rejected`) and optional `reviewNote`. Owners, editors and reviewers may review project evidence.
- `GET /api/assets/:assetId/evidence/:evidenceId/events` — retrieve the append-only event history.

Project viewers may read evidence but cannot submit or review it. Personal assets are restricted to their owner. Missing or inaccessible assets and records return not-found responses to avoid leaking cross-project identifiers.

## Interpretation and limitations

- `submitted` means a user supplied a source and claim; it is not verification.
- `needs_review` means a human review is still required.
- `verified` means an authorized reviewer accepted the submitted evidence for the stated target and scope. It is not a legal finding, identity proof, rights clearance or guarantee that every statement is true.
- C2PA cryptographic validation, application provenance integrity, rights attestations and human evidence review remain separate signals. None should be silently promoted into another.
- The ledger captures an explicit target reference. Downstream graph linking must still resolve that target inside the same project before displaying a relationship.

## Validation

Run `npm run verify:evidence-ledger` for database-backed tests covering source hash snapshots, submission events, reviewer attribution, terminal review behavior and input validation. The command is included in `npm run build`.
