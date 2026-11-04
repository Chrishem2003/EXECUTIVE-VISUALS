# Sequence preview engine

**Branch:** `feat/sequence-preview-engine`  
**Milestone:** E1 — browser preview and frame-accurate transport  
**Status:** sequence-time resolver implemented; browser playback UI and hosted private-media playback remain in progress.

## Implemented foundation

The timeline preview core now provides:

- Rational frame-to-time and time-to-frame conversion.
- Active-clip resolution for an exact timeline frame.
- Track-order preservation so the UI can composite active layers deterministically.
- Source-time mapping that respects source in points, source duration and clip speed.
- Exclusive clip out-points and disabled track/clip filtering.
- Sequence duration calculation in timeline frames, including fractional final-frame rounding.

The resolver is deliberately independent of browser media elements. This keeps time mapping deterministic and testable before the browser transport is connected.

## Required next work

1. Connect a playhead and transport to `resolveTimelineFrame`.
2. Switch source media only when the active clip changes; seek using the returned source time.
3. Render still images, captions and overlay layers in track order.
4. Synchronize enabled audio tracks and expose mute/solo.
5. Add proxy-first source selection and abortable authenticated cloud media playback.
6. Add browser-level tests for play, pause, seeking, clip boundaries, source changes, decode errors and stale revisions.
7. Compare preview behavior with the FFmpeg master renderer. Any unsupported effect or composition behavior must be visibly marked as a preview limitation.

## Safety and fidelity

- The saved timeline remains the source of truth; playback does not mutate or persist the edit.
- Cloud mode must use authenticated, project-scoped private-media access. Never guess an asset URL or expose storage credentials.
- Preview is not a delivery master. A completed render still requires output probing and delivery validation.
- No production deployment, provider activation, migration or paid execution is part of this milestone.
