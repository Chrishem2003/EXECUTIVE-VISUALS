# Timeline multi-track playback

## Scope

This batch adds a local-media program monitor and shared sequence transport. It is intentionally limited to local assets while cloud preview delivery is not enabled.

## Playback clock

- Timeline time is represented as sequence frames and converted using the sequence's rational frame rate.
- The playback engine selects every enabled video, audio and overlay clip active at the current playhead.
- Source in-points and clip timeline offsets are translated into source media time.
- Disabled tracks and clips are omitted. Caption tracks remain outside this preview implementation.
- Video layers are composited in track order; overlay stills use their authored position, size and opacity.
- Dedicated audio clips are synchronized against the same sequence clock and use clip gain in dB.
- When dedicated audio is active, embedded video audio is muted to avoid accidental double playback. Otherwise only the topmost active video layer is audible.

## Controls

- Load/refresh local media into browser object URLs.
- Play and pause the sequence.
- Seek using the frame-indexed playhead.
- Step the playhead one sequence frame forward or backward.
- Release object URLs and stop media when switching sequences or leaving the page.

## Accuracy and constraints

The transport clock is frame-indexed, but HTML media seeking is best-effort. Browser element volume supports attenuation; positive gain above unity is capped in this preview, so the final renderer remains authoritative for gain staging and the finished mix. The HTMLMediaElement currentTime value has browser-dependent update cadence; requestVideoFrameCallback can observe presented video frames but does not guarantee that callback work is perfectly synchronized with the compositor. This implementation therefore does not claim frame-accurate source seeking or professional-grade real-time compositing.

Cloud preview, caption rendering, transitions, effects, video-on-video finishing and measured dropped-frame telemetry remain separate follow-up work. For video tracks, an available private proxy asset is loaded first; the original source is used only when no proxy derivative is available. Overlay tracks preview still images only.

## Validation

Run `npm run verify:timeline`.

The verification covers rational frame conversion, overlapping tracks, source in-points, track/clip enablement, clip boundaries, and proxy command argument safety.
