# Batch 63 — Creative Director storyboard compiler

## Delivered

- The Creative DNA brief now compiles into a deterministic six-scene storyboard.
- The storyboard has exact runtime allocation, bounded shot durations, individual shot prompts, camera/framing/movement direction and sound notes.
- The proof scene carries the supplied proof candidate or an explicit warning when no proof was supplied. The compiler does not invent evidence, dialogue, endorsements or outcomes.
- Storyboard metadata records `planningOnly: true`, `generationState: not_submitted` and `providerSubmitted: false`.
- The AI Director workspace displays scene and shot cards and exports the storyboard as JSON.
- The storyboard is persisted with the cloud creative production and restored when the cloud project is reopened.
- A one-click handoff creates an editable one-episode Series Producer plan. Existing story-bible, shot-direction, shot-package and timeline-marker workflows remain the downstream editing path.

## Duration and safety

- Supported Creative Director presets: 15, 30, 60, 90, 180, 300 and 600 seconds.
- The 5–10 minute selection resolves conservatively to 300 seconds; 10–30 minutes resolves to 600 seconds.
- Storyboard runtime is limited to 15–1800 seconds and each generated clip is at most 30 seconds.
- The handoff is a planning conversion only. It does not submit image/video/audio provider jobs, reserve credits, or publish media.

## Validation

- Creative-intent tests cover exact timing, shot duration bounds, proof-not-supplied warnings, preset resolution and invalid input rejection.
- Series-production tests cover conversion into an editable episode and engine-neutral shot package, including a strict no-provider-submission guard.
- `npm run verify:creative-intent` and `npm run verify:shot-readiness` are part of the repository's existing build verification sequence.
