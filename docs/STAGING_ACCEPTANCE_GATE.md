# Executive Visuals — Staging Acceptance Gate

This checklist is the release gate for the current feature branch. Passing unit tests and a production build are necessary, but they do not prove that the end-to-end workflow works against a deployed staging environment.

## 1. Build and automated verification

- [ ] Latest feature-branch commit has a successful full CI run (dependency install, typecheck, build, and configured tests).
- [ ] Timeline editing, preview transport, undo/redo, and revision-conflict tests pass.
- [ ] Cloud render executor tests prove the queued timeline revision is used and a verified render manifest is required before publication.
- [ ] Delivery-profile tests prove invalid profile IDs and hard output mismatches fail closed.
- [ ] Upscale benchmark tests cover source checksum lineage, pinned model/build fingerprints, required fixture categories, pagination, review immutability, independent reviewer enforcement, and evidence-cap behavior.
- [ ] Delivery-package tests cover canonical fingerprint stability, tampering, output asset checksum/size/media-type binding, and safe signed-link handling.
- [ ] Migration verifier rejects destructive schema/data operations and verifies expected constraints/indexes.

## 2. Staging end-to-end workflow

Use a dedicated staging project and non-production media only.

1. Upload a source image/video and confirm its stored checksum and probe metadata.
2. Create a timeline, add the source as a clip, preview it, scrub/step frames where supported, and save an edit.
3. Attempt a stale-revision save and confirm the server rejects it without overwriting the latest timeline.
4. Render using each supported delivery profile that the staging environment can support.
5. Confirm the succeeded job returns the published output asset, revision-pinned render manifest, delivery receipt, profile report, and media-quality report.
6. Verify the output file with an independent probe/playback check; treat automated metadata checks as necessary but not a substitute for human visual and audio review.
7. Download the JSON delivery package and verify its fingerprint. Open the private master link deliberately and confirm it is HTTPS, bound to the expected asset, and expires as documented.
8. Submit delivery review as a different authorized reviewer. Confirm self-approval, approval with blocking errors, and approval with unacknowledged warnings are rejected.
9. For upscaling, register a fixture, execute a pinned build, register output evidence, and verify that a candidate is not recommended until all required fixture categories and independent passing reviews exist.
10. Export the quality report with both a partially loaded review list and a fully loaded list. Confirm completeness flags, review counts, aggregate truncation status, and limitations are accurate.

## 3. Access control and failure handling

- [ ] Test owner, editor, reviewer, and viewer permissions separately.
- [ ] Confirm unauthorized project readers cannot obtain private asset URLs, delivery evidence, or benchmark review actions.
- [ ] Confirm expired, malformed, cross-project, wrong-asset, stale-revision, and checksum-mismatched tickets/packages fail closed.
- [ ] Confirm cancellation during render/upscale/analysis prevents incomplete output publication and cleans only job-owned temporary files.
- [ ] Confirm optional media analysis failures are visible as review/unavailable warnings, never as a clean pass.
- [ ] Confirm audit events identify the authenticated reviewer and exact receipt fingerprint, and racing duplicate decisions produce a conflict.

## 4. Database and release controls

- [ ] Inspect migration SQL and run the repository migration verifier.
- [ ] Apply migrations only to a dedicated staging database after explicit environment confirmation and backup/rollback planning.
- [ ] Exercise staging against the actual configured storage/authentication services; mocked API tests are not a substitute.
- [ ] Confirm no production secret, provider credential, or production data is used in staging fixtures.
- [ ] Record the staging deployment ID, commit SHA, test results, known limitations, and rollback steps.

## 5. Merge/release decision

Do not merge or deploy while any required gate above is unchecked, the pull request reports conflicts/non-mergeability, or the current head lacks successful CI. Reconcile branch divergence by reviewing each base-only commit and preserving the more complete feature implementation; do not force-sync or overwrite the feature branch. No production migration, paid provider activation, merge, or production deployment is authorized by this checklist alone.

## Known limits to verify explicitly

- A delivery JSON package plus short-lived private master URL is not a ZIP archive.
- Automated media analysis and profile conformance do not establish subjective quality or recipient certification.
- Benchmark aggregates can be complete while the UI's visible review records are only partially loaded; the export must label those scopes separately.
