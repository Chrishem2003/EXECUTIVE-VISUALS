# Versioned timeline edit descriptors

**Milestone:** E2 foundation — non-destructive effects, animation and transitions  
**Branch:** `feat/timeline-descriptor-schema`  
**Status:** schema, validation, OTIO metadata preservation and variant comparison are implemented and CI-verified. Editing controls and render/preview execution are not yet shipped.

## Version 1 descriptors

Descriptors are attached to the existing `TimelineClip`; they do not create a parallel effect graph.

### Color effect

`effects[]` currently accepts a version-1 `color` descriptor with bounded parameters:

- Brightness: -1 to +1
- Contrast: 0 to 2
- Saturation: 0 to 3

### Keyframes

`keyframes[]` supports version-1 keyframes with `hold` or `linear` interpolation for:

- opacity
- x / y position
- scale and rotation
- audio gain in dB
- brightness, contrast and saturation

Frames are integer positions relative to the clip and must remain within its duration. A property cannot have two keyframes at the same frame.

### Transitions

`transitionIn` and `transitionOut` currently accept version-1 linear `fade-to-black` descriptors from 1 to 240 frames, bounded by the clip duration.

## Integrity and safety

- Client and server validators enforce descriptor versions, unique IDs, exact parameter shapes, value ranges and frame boundaries.
- Local and cloud timeline repositories validate descriptors before saving.
- OTIO export preserves descriptors in the clip's `executiveVisuals` metadata.
- Timeline variant comparisons report effect, keyframe and transition changes.
- Local and cloud master renderers fail closed when descriptors are present. They do not silently discard edits that they cannot reproduce.

## Not yet implemented

This milestone is a typed, durable editing foundation, not a claim that these effects are already rendered. The current renderers reject non-empty effect/keyframe/transition descriptors until the corresponding preview and FFmpeg implementations pass parity tests.

Next E2 work:
1. Implement color effect rendering and browser preview.
2. Implement fade-to-black preview/master parity.
3. Add a non-destructive inspector with undo/redo and descriptor history.
4. Implement keyframe interpolation and supported animated properties.
5. Add overlap-aware crossfades and transition handles only after the sequence model supports their timing correctly.

No production deployment, database migration or paid provider activation is part of this work.
