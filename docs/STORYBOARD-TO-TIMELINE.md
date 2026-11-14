# Storyboard-to-Timeline Conversion

**Milestone:** P1.5  
**Status:** Implemented as a frame-accurate, editable timeline plan. CI verification is required before acceptance.

## Conversion contract

The conversion creates a **new cloud timeline** in the selected project. It never replaces an existing sequence.

- The source storyboard ID, input fingerprint, model identity and scene/shot IDs are retained as lineage.
- Frame rate is taken from the reviewed storyboard and validated against supported rates.
- Aspect ratio determines sequence dimensions.
- Shot durations are converted to integer frames; start frames are accumulated in story order.
- Scene boundaries become timeline markers.
- Picture, sound-design and caption/title tracks are created.
- Shot action, dialogue, narration, visual/motion/negative prompts, sound cues, proof references, character references and continuity notes remain attached to the planned shot records.
- Planned shots have no asset ID and are **not** represented as playable media clips. This avoids bypassing the timeline's source-asset validation.
- The timeline plan is stored in revisioned timeline metadata and exported with the timeline document.

## Editing and history

The timeline workspace displays the planned scene/shot blocks and allows the editor to adjust shot duration in frames and edit prompts, action, sound, dialogue, narration and continuity. Editing a shot reflows every subsequent start frame and scene marker.

Changes use the existing validated timeline-history operation model. Undo/redo, IndexedDB recovery, conflict detection and immutable version history therefore include the storyboard-plan metadata and markers. Saves use the existing revision-guarded cloud timeline API.

## Safety and limitations

- A new timeline is created only after an explicit user action from the storyboard panel.
- Existing cloud timelines remain unchanged.
- No image/video generation, media provider submission, clip insertion, render or publication is performed.
- Planned shots become actual media clips only after an approved asset exists and is attached through a later, validated operation.
- Real-time collaborative editing and provider job-to-shot attachment remain later work.
