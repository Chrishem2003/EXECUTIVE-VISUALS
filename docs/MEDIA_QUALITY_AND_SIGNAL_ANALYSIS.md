# Media Quality and Temporal Signal Analysis

## Temporal luminance review

The signal-analysis module can parse FFmpeg `signalstats` frame metadata (`lavfi.signalstats.YAVG`) into timestamped mean-luminance samples. Samples outside the valid 0–255 luma range, without a finite non-negative timestamp, or without a frame index are discarded.

`buildTemporalLumaFindings` checks two conservative patterns:

- **Abrupt luminance change:** a large adjacent-sample delta away from a supplied scene-cut timestamp.
- **Alternating luminance:** repeated high-amplitude sign changes over a short sample window, which may indicate temporal flicker.

Known scene-cut-adjacent transitions are excluded within a configurable guard interval. Thresholds are configurable, and findings are warnings for human review rather than automatic failures or perceptual-quality scores.

## Report integration

`buildMediaQualityReport` consumes optional `signalAnalysis.lumaSamples` and `signalAnalysis.sceneChanges` evidence and includes the derived findings and sample count. Existing black-frame, silence, freeze, scene-change and audio-metric checks remain separate.

The cloud timeline executor now runs a bounded FFmpeg analysis pass after output probing and before publication. It samples at 12 frames per second after downscaling frames to 320 pixels wide, combines `signalstats` and `scdet`, and parses per-frame mean-luma values and scene-cut scores. The pass is capped at 120 seconds and captured metadata is bounded; cancellation is propagated. The report records sample count, coverage seconds and whether the analysis was truncated. A failed or incomplete pass is represented as an unavailable warning, not a clean flicker pass. The analyzer is injectable in tests so success, failure and cancellation behavior can be verified without relying on a particular FFmpeg binary.

## Limitations and release checks

- Mean luma alone cannot distinguish intentional strobing, rapid lighting changes, cuts, camera flashes, exposure changes or defective flicker with certainty.
- Scene-cut timestamps must come from a dedicated scene-change detector, not every decoded frame timestamp.
- Sparse sampling can miss very short flashes; dense sampling costs more CPU and metadata storage.
- This check does not assess chroma flicker, rolling-shutter artifacts, motion judder, stabilization, sharpness or perceptual fidelity.
- Before release, benchmark representative short and long renders, validate filter availability across supported FFmpeg builds, and verify the 600-second cap and 2-fps sampling cost on production-like workers. The current cap intentionally leaves media beyond the first two minutes unanalysed; that limitation is visible in the report. The 12-fps sampling rate can expose short luminance changes better than sparse scene-level sampling, but it cannot certify high-frequency flicker above its sampling bandwidth.


## Asset derivative lineage

The authenticated cloud asset API exposes `GET /api/cloud/assets/:assetId/lineage`. It returns the selected asset, its known parent chain and its known descendants within the same authorized project or personal-asset scope. The endpoint uses the authenticated asset repository for both the selected asset and collection reads; it does not accept an owner ID from the request body.

Lineage traversal is bounded to 1,000 descendant nodes and 32 levels in each direction. Missing parents are reported explicitly, cycles are surfaced rather than followed indefinitely, and the response indicates when the graph or source collection was truncated. Asset metadata remains the existing private asset metadata; this endpoint does not issue public storage URLs.

The pure graph builder is covered for ordered ancestry/descendants, missing parents, cycles, absent assets and traversal limits. The cloud API route is covered for authenticated access and project-scoped repository reads. A staging acceptance test should additionally verify owner/editor/reviewer/viewer permission behavior against the deployed Supabase policies and confirm that cross-project parent IDs are never returned.


## Asset version comparison

The Cloud Projects asset register exposes an on-demand lineage panel. For a known ancestor or descendant, a reviewer can request a side-by-side preview of the selected asset and the related version. The UI obtains both URLs from the existing authenticated `GET /api/cloud/assets/:assetId` route, which issues private signed URLs with a 300-second expiry; URLs are not persisted in project state or written to audit metadata. Images and videos render inline, audio uses native playback controls, and other file types open as private links. Comparison is read-only and does not mutate either asset. Changing projects clears the in-memory comparison state.

Staging acceptance should cover: a source image and enhanced image; a source video and derivative video; audio playback; unsupported file-type links; expired signed URLs and retry; cross-project or deleted related assets; and confirming no source bytes, derivative bytes, metadata, or timeline references change during comparison. The UI should never treat an unavailable preview as a successful quality review.


## Asset register processing provenance panel

For assets carrying `metadata.processing`, the Cloud Projects asset register displays the recorded model, build fingerprint, engine, method, scale, input/output dimensions, processing duration and quality-review state. It separately checks whether dimensions and decoder verification flags are true, whether the processing output hash matches the persisted asset SHA-256, and whether a source hash is present. A derivative without processing evidence is explicitly marked as incomplete. These indicators are evidence visibility, not an automatic quality pass: human quality review remains separate, and a build fingerprint is not presented as a semantic model release name.

Staging acceptance: inspect a fully verified derivative, a derivative missing one verification flag, a mismatched output hash, missing source hash, a derivative with no processing metadata, and an original source asset. Ensure the UI does not infer a passing review from missing data or from `dimensionsVerified` / `decoderVerified` alone.


## Timeline derivative provenance gate

When a timeline clip references an asset with `derivativeOf`, the sequence quality analyzer now inspects the derivative's structured processing record. It warns when the record is missing, the source checksum is absent or malformed, or the recorded output checksum cannot be reconciled with the asset-library checksum. For AI super-resolution derivatives it additionally checks the dimension and decoder verification flags and the independent quality-review decision. A rejected AI derivative is an error; a pending or absent independent pass remains a warning. These findings are attached to the affected clip and appear in the existing sequence findings / production-readiness panel.

Original assets are not penalized for lacking derivative metadata. Existing non-AI/classical derivatives are not incorrectly required to carry AI model or human AI-review fields, but still need usable source/output provenance. The gate is advisory for incomplete evidence and does not silently rewrite, replace or block legacy media; a recorded AI quality rejection is elevated to an error. Staging acceptance must cover a fully approved AI derivative, pending review, rejected review, mismatched output checksum, missing source checksum, missing verification flags, and a legacy derivative with no processing record.


## Using an approved derivative on the timeline

The clip inspector lists derivative assets whose `derivativeOf` matches the clip's current asset. A derivative is selectable only when its processing record identifies the same source asset, the source checksum and input checksum agree, the output checksum matches the persisted asset checksum, dimensions and decoder verification are both true, and independent quality review is `reviewed_pass`. Pending, rejected, incomplete or mismatched derivatives remain visible with a reason but cannot be selected.

Replacing a clip changes only its `assetId`. The original asset remains in the library, and the clip ID, name, track, timeline start, source range, duration, gain, speed and creative-intent metadata are preserved. The operation uses the existing timeline revision save path and history stack, so it can be undone. This is a non-destructive editorial media-reference change; it does not alter or regenerate the derivative file. Real-media staging acceptance and independent visual review are still required before release.


## Side-by-side source and derivative review in the timeline

The selected clip inspector can request a read-only side-by-side comparison for any derivative whose `derivativeOf` points to the clip's current source. It obtains short-lived private links for both assets through the existing authenticated cloud asset-link endpoint, validates HTTPS, and discards the result if the editor changes selection or leaves cloud mode while the requests are in flight. Image, video and audio previews are shown in parallel; other media types use deliberate private-link opening. The comparison itself does not modify asset bytes, timeline references, or approval state. The existing replacement control remains separately gated by complete provenance and `reviewed_pass`. Links are short-lived (approximately five minutes); users should refresh the comparison if a link expires. This remains subject to browser-level staging checks for private-link expiry, access denial, project switching and mixed media types.


## Portable enhancement evidence report

The Cloud Projects asset lineage panel can export a URL-free JSON evidence snapshot for the selected asset. The versioned report includes the asset identity and persisted checksum, a bounded allowlist of processing/build fields, source/output checksum and decoder/dimension checks, independent review state, and the authorized lineage graph already loaded by the panel. It deliberately excludes signed preview URLs and storage paths.

The report labels itself technical evidence only. It does not calculate or claim perceptual quality, infer missing provenance, convert a successful decoder check into a quality pass, or replace independent human review. Missing or conflicting evidence remains explicit. Export is client-side and read-only; it does not create a server record, change the asset, or update approval state.

Staging acceptance: export a fully evidenced derivative, a legacy derivative with missing processing data, a mismatched output checksum, and a lineage graph with missing/cyclic/truncated nodes. Confirm the JSON contains no signed URLs, storage paths, credentials, or cross-project records, and that the export does not mutate asset metadata or review history.


The export also cross-checks a derivative's recorded source checksum against the checksum of its immediate parent in the authorized lineage graph. A missing parent, cycle, unavailable parent checksum, or mismatch is reported explicitly rather than treated as verified. Ancestor and descendant arrays are capped at 500 entries in the portable report, with truncation and reported counts preserved.


## Unified cloud asset provenance and review-readiness panel

The Cloud Projects asset card now derives its displayed processing checks from the same versioned enhancement-evidence report used for JSON export. It shows processing-record presence, source checksum validity, output checksum agreement, dimensions, decoder verification, and independent review status. Once the authorized lineage graph is loaded, it also shows parent existence and source-to-parent checksum agreement. Until lineage is loaded, parent checks are omitted rather than incorrectly reported as missing. Status labels distinguish evidence that is verified, pending, unavailable, mismatched or not applicable. The panel is informational: technical evidence does not establish perceptual quality and cannot substitute for independent visual review.

## Private asset comparison link lifecycle

The Cloud Projects source/derivative comparison now validates that both asset-link responses are HTTPS before rendering either preview. A comparison request is bound to the active cloud project and its request token; if the user switches projects, a newer comparison supersedes it, or either asset is no longer present in the loaded project asset list, the stale response is discarded. Project switching clears the request tokens and in-memory comparison state. Comparison links are treated as short-lived (five minutes); after that window the UI hides the expired previews and offers an explicit refresh action. This is a client-side safety boundary in addition to the authenticated asset-link endpoint, not a replacement for server-side authorization.

Staging acceptance: compare two authorized assets, switch projects while both link requests are in flight, start a second comparison before the first completes, return a non-HTTPS link from a test stub, and wait past the five-minute client expiry. Confirm stale requests cannot repopulate another project's UI, unsafe links are never rendered, expired previews are hidden, and refreshing obtains new links without modifying either asset or its lineage.

## Unified enhancement derivative review queue

The Cloud Projects workspace now includes a project-scoped derivative review queue above the asset register. It summarizes derivatives with recorded processing metadata or a derivative relationship, separates the recorded human-review decision (approved, rejected, pending) from technical evidence checks, and exposes a filter for those review states. Each card reports the number of satisfied technical checks and outstanding technical gaps using the same enhancement evidence report as the asset provenance panel and JSON export. Parent checksum checks remain deferred until authorized lineage has been loaded; an approved human review does not erase technical gaps, and technical checks do not create an approval decision. The queue is read-only: review decisions continue to be recorded through the existing authorized benchmark review workflow and its audit event path.

Staging acceptance: populate one pending, one approved and one rejected derivative in a single project; verify queue counts and filters; load lineage and confirm parent-check counts update consistently with the asset panel/export; confirm a reviewed asset with a failed technical check remains visibly flagged; switch projects and verify the queue contains only the newly selected project's assets. Confirm no review decision or asset metadata is mutated by opening/filtering the queue.

The derivative review queue also supports text search across asset name, model, model version and engine, plus a technical-gaps filter independent of the human-review state. This allows reviewers to isolate assets that still have provenance/verification issues even when their human review is approved. Search and filtering are client-side over the already authorized project asset list and do not issue additional storage or review writes.

When authorized lineage has been loaded for a derivative, its review card exposes a direct **Compare with source** action. It reuses the existing project-scoped comparison flow, which verifies that both assets belong to the active project, obtains authenticated HTTPS preview links, discards stale responses and expires links after five minutes. The action is intentionally unavailable until lineage confirms the immediate parent; it does not change either asset or timeline.
