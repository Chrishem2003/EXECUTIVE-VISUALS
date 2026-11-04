# Versioned timeline edit descriptors

**Milestone:** E2 foundation — non-destructive effects, animation and transitions  
**Branch:** `feat/timeline-descriptor-schema`  
**Status:** schema, validation, OTIO metadata preservation and variant comparison are implemented and CI-verified. Editing controls and render/preview execution are not yet shipped.

## Version 1 descriptors

Descriptors are attached to the existing `TimelineClip`; they do not create a parallel effect graph.

### Color effect

`effects[]` currently accepts a version-1 `color` descriptor with bounded parameters:

- Brightness multiplier: 0 to 2
- Contrast: 0 to 2
- Saturation: 0 to 3

Color effects are available on the primary video track. The clip inspector exposes enablement and bounded values. Browser preview uses CSS color filters; local and cloud master renders compile the same descriptor to FFmpeg LUT/EQ filters. Visual parity still requires fixture-based review across codecs and browser engines.

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

## Current execution boundary

Color adjustment and linear fade-to-black transitions now have clip-inspector controls, browser preview evaluation and local/cloud FFmpeg filter compilation. The cloud FFmpeg integration test exercises color plus fade-in/out in an actual generated master. Browser CSS preview is an approximation; the FFmpeg master remains authoritative.

Keyframe descriptors are validated and preserved but are still rejected by both master renderers until animation evaluation and preview/master parity are implemented. Crossfades, wipes, motion paths and animated properties are not yet shipped.

Next E2 work:
1. Verify color and fade output parity across local/cloud FFmpeg, browser preview and supported codecs.
2. Add undo/redo and descriptor history to the non-destructive inspector.
3. Implement keyframe interpolation and supported animated properties.
4. Add overlap-aware crossfades and transition handles only after the sequence model supports their timing correctly.

No production deployment, database migration or paid provider activation is part of this work.
