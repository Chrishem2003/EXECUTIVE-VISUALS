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
