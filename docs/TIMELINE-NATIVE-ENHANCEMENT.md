# Timeline-native enhancement batch

## Scope

This batch connects clip-level visual finishing to the existing editorial timeline. It does not replace the timeline document format or mutate original media.

## Delivered

- Per-video-clip, non-destructive effect metadata under \`clip.metadata.timelineEffects\`.
- Inspector controls for bounded brightness, contrast, saturation, denoise and sharpen values.
- A shared effect compiler used by both local and cloud FFmpeg master renderers.
- Render summaries report how many video clips had an active effect layer.
- Bounded numeric parsing prevents filter-graph injection through effect values.
- Timeline workspace Undo and Redo controls with a 50-edit in-memory history limit.
- Undo/Redo restore a previous document snapshot and save it as a new server timeline revision.
- The build's timeline verification step runs the effect compiler contract tests.

## Effect semantics

The effect layer is metadata attached to a timeline clip. The original asset ID and stored bytes remain unchanged. At render time the worker compiles the effect settings into FFmpeg filters:

- brightness / contrast / saturation: \`eq\`
- denoise: \`hqdn3d\`
- sharpen: \`unsharp\`

All controls are clamped to documented ranges by both the UI and renderer. No arbitrary filter strings or scripts are accepted from the timeline document.

## Undo and Redo

Undo/Redo history is currently session-scoped and held in the editor client. It is capped at 50 snapshots and cleared when the workspace reloads or switches timelines. Each undo or redo is persisted as a new timeline revision, so it does not rewrite prior saved revisions. This is not yet a durable cross-device history browser.

## Explicitly not included in this batch

- Interactive decoded-frame playback or a synchronized before/after monitor.
- Proxy playback and automatic proxy/original switching.
- Durable revision browser and restore UI.
- FlashVSR job submission directly from a clip; that engine remains separately gated and must first land through its own PR and pass runtime readiness checks.
- Transitions, animated overlays and video-on-video compositing.

These are follow-on milestones, not implied by the current UI controls.

## Validation

- \`server/tests/timeline-clip-effects.test.mjs\` covers default behavior, effect compilation and numeric bounds.
- \`server/tests/cloud-ffmpeg-timeline-renderer.test.mjs\` renders a fixture with a real effect stack when FFmpeg/FFprobe are available and asserts the effect count.
- \`npm run verify:timeline\` includes the effect contract test.
- The complete GitHub Actions build remains the final integration gate.
