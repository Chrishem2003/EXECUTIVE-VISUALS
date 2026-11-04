# Sequence preview engine

**Branch:** `feat/private-cloud-media-streaming`  
**Milestone:** E1 — browser preview and frame-accurate transport  
**Status:** local and authenticated cloud primary-picture playback, synchronized multi-track audio, mute/solo monitoring, still-image overlays and SRT/VTT caption preview implemented; CI verification in progress. Browser-level playback tests and FFmpeg parity remain outstanding. See [Private cloud media streaming](PRIVATE-CLOUD-MEDIA-STREAMING.md).

## Implemented foundation

The timeline preview core now provides:

- Rational frame-to-time and time-to-frame conversion.
- Active-clip resolution for an exact timeline frame.
- A local browser transport with play, pause, frame stepping and timeline scrubbing across cuts on the primary picture track.
- Video and still-image playback with clip-speed playback-rate mapping and explicit decode/missing-source feedback.
- Authenticated same-origin private cloud media streaming with byte-range forwarding, upstream timeout and disconnect cleanup; signed storage URLs stay server-side.
- Synchronized local audio playback for overlapping enabled audio clips, with per-clip gain and speed mapping.
- Preview-only audio track mute and solo controls.
- Still-image overlay layers positioned and opacity-adjusted from the clip metadata.
- SRT/VTT caption cue preview with source-range clipping, cue caching and text-only DOM insertion.
- Track-order preservation so the UI can composite active layers deterministically.
- Source-time mapping that respects source in points, source duration and clip speed.
- Exclusive clip out-points and disabled track/clip filtering.
- Sequence duration calculation in timeline frames, including fractional final-frame rounding.

The resolver is deliberately independent of browser media elements. This keeps time mapping deterministic and testable while the browser transport remains a thin playback adapter.

## Required next work

1. Add browser-level tests for play, pause, seek, frame stepping, source changes and decode failures.
2. Add mute/solo controls and an audio bus limiter so browser mix headroom matches the master renderer.
3. Add browser-level tests for source switching, gaps, overlapping audio, overlays, captions and media decode errors.
4. Add proxy-first source selection and browser-level hosted tests for authenticated cloud playback.
5. Validate browser preview against FFmpeg fixtures, including speed, source trims and gaps.
6. Add stale-revision protection and cleanup for media resources when sources change or the workspace unmounts.

## Safety and fidelity

- The saved timeline remains the source of truth; playback does not mutate or persist the edit.
- Cloud mode must use authenticated, project-scoped private-media access. Never guess an asset URL or expose storage credentials.
- Preview is not a delivery master. A completed render still requires output probing and delivery validation.
- No production deployment, provider activation, migration or paid execution is part of this milestone.
