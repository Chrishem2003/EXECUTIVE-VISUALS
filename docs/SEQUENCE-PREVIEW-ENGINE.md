# Sequence preview engine

**Branch:** `feat/sequence-preview-engine`  
**Milestone:** E1 — browser preview and frame-accurate transport  
**Status:** local primary-picture playback and synchronized multi-track audio preview implemented; latest CI verification pending. Overlay/caption compositing, browser-level playback tests and hosted private-media playback remain outstanding.

## Implemented foundation

The timeline preview core now provides:

- Rational frame-to-time and time-to-frame conversion.
- Active-clip resolution for an exact timeline frame.
- A local browser transport with play, pause, frame stepping and timeline scrubbing across cuts on the primary picture track.
- Video and still-image playback with clip-speed playback-rate mapping and explicit decode/missing-source feedback.
- Synchronized playback of enabled audio clips across multiple tracks, with per-clip dB gain and speed controls. Preview gain is converted to linear amplitude through a bounded helper.
- Track-order preservation so the UI can composite active layers deterministically.
- Source-time mapping that respects source in points, source duration and clip speed.
- Exclusive clip out-points and disabled track/clip filtering.
- Sequence duration calculation in timeline frames, including fractional final-frame rounding.

The resolver is deliberately independent of browser media elements. This keeps time mapping deterministic and testable while the browser transport remains a thin playback adapter.

## Required next work

1. Add browser-level tests for play, pause, seek, frame stepping, source changes and decode failures.
2. Add track mute/solo controls, audio waveform/level inspection and synchronized clip boundary handling.
3. Composite still images, captions and overlay layers in track order.
4. Connect proxy-first source selection and abortable authenticated cloud media playback.
5. Validate browser preview against FFmpeg fixtures, including speed, source trims and gaps.
6. Add stale-revision protection and cleanup for media resources when sources change or the workspace unmounts.

## Safety and fidelity

- The saved timeline remains the source of truth; playback does not mutate or persist the edit.
- Cloud mode must use authenticated, project-scoped private-media access. Never guess an asset URL or expose storage credentials.
- Preview is not a delivery master. A completed render still requires output probing and delivery validation.
- No production deployment, provider activation, migration or paid execution is part of this milestone.
