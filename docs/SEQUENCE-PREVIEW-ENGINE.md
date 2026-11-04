# Sequence preview engine

**Branch:** `feat/sequence-caption-preview`  
**Milestone:** E1 — browser preview and frame-accurate transport  
**Status:** local primary-picture playback, synchronized multi-track audio, still-image overlays and SRT/WebVTT caption cue preview implemented. Browser-level playback tests and hosted private-media playback remain outstanding.

## Implemented foundation

The timeline preview core now provides:

- Rational frame-to-time and time-to-frame conversion.
- Active-clip resolution for an exact timeline frame.
- A local browser transport with play, pause, frame stepping and timeline scrubbing across cuts on the primary picture track.
- Video and still-image playback with clip-speed playback-rate mapping and explicit decode/missing-source feedback.
- Synchronized playback of enabled audio clips across multiple tracks, with per-clip dB gain and speed controls, plus temporary track mute/solo routing. Preview gain is converted to linear amplitude through a bounded helper. Mute/solo state is intentionally not persisted into the timeline.
- Local still-image overlay composition in timeline track order, with clip-timed visibility and bounded canvas-relative position, dimensions and opacity. Only image assets are rendered as overlays in this browser preview; the FFmpeg master renderer remains authoritative.
- SRT/WebVTT caption cue preview uses the caption clip's resolved source time, same-origin authenticated asset route, a bounded 2 MB/5,000-cue parser, safe text nodes and the clip's saved font/color/placement/background settings. The browser preview does not burn captions into an output file.
- Track-order preservation so the UI can composite active layers deterministically.
- Source-time mapping that respects source in points, source duration and clip speed.
- Exclusive clip out-points and disabled track/clip filtering.
- Sequence duration calculation in timeline frames, including fractional final-frame rounding.

The resolver is deliberately independent of browser media elements. This keeps time mapping deterministic and testable while the browser transport remains a thin playback adapter.

## Required next work

1. Add browser-level tests for play, pause, seek, frame stepping, source changes and decode failures.
2. Add audio waveform/level inspection, meters, automation and synchronized clip boundary handling.
3. Add browser-level playback tests and validate overlay/caption appearance against FFmpeg output.
4. Connect proxy-first source selection and abortable authenticated cloud media playback.
5. Validate browser preview against FFmpeg fixtures, including speed, source trims and gaps.
6. Add stale-revision protection and cleanup for media resources when sources change or the workspace unmounts.

## Safety and fidelity

- The saved timeline remains the source of truth; playback does not mutate or persist the edit.
- Cloud mode must use authenticated, project-scoped private-media access. Never guess an asset URL or expose storage credentials.
- Preview is not a delivery master. A completed render still requires output probing and delivery validation.
- No production deployment, provider activation, migration or paid execution is part of this milestone.
