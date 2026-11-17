# Directional timeline transitions

## Available transitions

The primary video track supports frame-counted transitions:

- Hard cut (no transition metadata)
- Dip to black (adjacent clips)
- Crossfade (overlapping clips)
- Wipe left, right, up and down
- Slide left, right, up and down

Wipes and slides use FFmpeg's `xfade` filter. The crossfade model value maps to FFmpeg's `fade` transition; directional values map to their exact FFmpeg transition names.

## Timeline contract

A directional transition is authored on the outgoing clip. The next enabled clip on the same primary video track must overlap the outgoing clip by exactly `fadeFrames` at the sequence frame rate. The transition length must be a positive integer and fit inside both clips. The renderer rejects mismatched overlap, unsupported transition names and missing incoming clips.

The editor validates the same frame-based contract before saving. The transition is preserved in timeline history and serialized timeline documents.

## Preview and master rendering

The browser program monitor currently approximates directional wipes and slides with a dissolve because its HTML compositor does not implement the full FFmpeg transition shader. The clip inspector states this limitation. Final local/cloud FFmpeg master renders use the exact selected wipe or slide transition.

Before rendering, the worker verifies that its FFmpeg build exposes the `xfade` filter. If unavailable, the job fails with `VIDEO_TRANSITION_FILTER_UNAVAILABLE` rather than silently producing a cut or a different effect.

## Verification

Run `npm run verify:timeline-transitions` and `npm run verify:timeline`. Tests cover all eight directional types, frame overlap validation, cumulative sequence duration, and real FFmpeg rendering for representative wipe and slide transitions when FFmpeg/FFprobe are installed.
