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

The browser program monitor composites directional wipes with CSS clip masks and slides with synchronized incoming/outgoing transforms. The outgoing and incoming media layers remain independently clocked from the same sequence playhead; directional transitions do not also receive a dissolve opacity ramp. Final local/cloud FFmpeg master renders use the exact selected wipe or slide transition. Browser and FFmpeg implementations are visually aligned, while FFmpeg remains authoritative for final frame output.

Before rendering, the worker verifies that its FFmpeg build exposes the `xfade` filter. If unavailable, the job fails with `VIDEO_TRANSITION_FILTER_UNAVAILABLE` rather than silently producing a cut or a different effect.

## Verification

Run `npm run verify:timeline-transitions` and `npm run verify:timeline`. Tests cover all eight directional types, frame overlap validation, cumulative sequence duration, and real FFmpeg rendering for representative wipe and slide transitions when FFmpeg/FFprobe are installed.


## Browser preview compositor

The program monitor uses the same frame-counted transition window as the sequence model. For a wipe, the incoming layer is revealed through a directional clip mask while the outgoing layer remains underneath. For a slide, both layers translate in opposite directions over the exact overlap window. Directional transitions retain full opacity; only crossfades and dip-to-black use opacity envelopes. The editor resets compositor styles when a clip leaves its transition window so seeking backward or jumping between clips cannot retain stale masks or transforms.

The playback unit suite covers all eight directions, incoming/outgoing slide motion, wipe masks, progress clamping, unsupported transition fallback, and the absence of accidental dissolve envelopes.
