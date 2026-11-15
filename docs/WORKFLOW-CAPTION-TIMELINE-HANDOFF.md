# Workflow caption-to-timeline handoff

## Delivered

The Timeline Editor provides a **Workflow Caption Handoff** action for generated WebVTT sidecar assets that carry verified duration metadata.

- The editor lists only accessible `text/vtt` assets with a `.vtt` filename and positive duration metadata.
- The editor inserts the selected caption asset at the current playhead (editable start time).
- It reuses an enabled, unlocked caption track only when the requested range does not overlap an existing enabled clip.
- If no safe lane is available, it creates a new caption track rather than moving, overwriting or disabling existing clips.
- The inserted clip retains the original VTT asset ID and records workflow-caption provenance.
- Timeline history, validation, revision-guarded save, undo and redo remain the normal persistence path.
- The existing FFmpeg local and cloud master renderers consume caption tracks and burn the selected VTT/SRT sidecar into the output using the existing caption styling controls.

## Safety

- No source video or caption asset bytes are modified.
- The feature creates no new upload, provider request, cloud job or paid operation.
- Server-side timeline validation remains authoritative for asset ownership, project access and caption media type.
- Locked caption tracks and overlapping caption clips are never modified.

## Verification

Focused tests cover playhead placement, frame rounding, reuse of a safe caption lane, fallback to a new lane, metadata provenance and rejection of invalid inputs. The complete build, timeline suite and release checks must pass on the exact PR head before merge.
