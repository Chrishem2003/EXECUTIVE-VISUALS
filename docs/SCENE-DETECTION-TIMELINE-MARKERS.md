# Scene detection to timeline markers

## Workflow

1. Select a video clip already placed on the current timeline.
2. Queue the existing authenticated `media.probe` operation.
3. FFprobe reads stream metadata; FFmpeg runs a bounded scene-change and freeze-detection pass.
4. The editor maps source-relative cut timestamps through the selected clip's source range into timeline frame positions.
5. New cut points are added as review markers. Existing markers within one frame are deduplicated.
6. The editor persists the markers through normal timeline revision checks and undo history.

## Safety and limits

- Detection is advisory and heuristic; it does not infer semantic shots or editorial intent.
- No automatic split, trim, delete, derivative publication or AI-provider call occurs.
- Original source assets are read-only during analysis.
- Only cuts within the selected clip's source range and timeline duration are mapped.
- If FFmpeg is unavailable, the probe reports scene analysis as unavailable rather than returning a false clean result.
- Cloud mode requires the existing cloud media worker to be enabled; no worker or storage configuration is changed by this feature.

## Verification

Regression coverage includes source-to-timeline frame mapping, clip-range boundaries, duplicate marker suppression, malformed detector results and cloud-worker FFmpeg diagnostics.
