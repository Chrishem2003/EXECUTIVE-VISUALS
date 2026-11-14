# Editable Storyboard Compiler

**Milestone:** P1.4  
**Status:** Model-backed compiler, authenticated API, editable project artifact and workspace persistence integration implemented. CI verification is required before acceptance.  
**Execution boundary:** Text planning only. No image or video generation, provider task, timeline write, export or publication occurs.

## Planning model

The compiler expands a reviewed P1.3 Creative Director plan into a structured production document:

- A project logline and global continuity rules.
- Ordered scenes with slugline, purpose, story beat, location and time of day.
- Ordered shots with shot type, framing, angle, movement, lens, action, dialogue, narration, lighting and sound cue.
- Separate still-image and motion prompts, plus negative prompt and proof reference.
- Continuity in/out notes and a controlled transition vocabulary.
- Character references linked only to supplied project character IDs, plus clearly marked fictional character suggestions.
- Per-shot duration, scene duration, target runtime, aspect ratio and frame rate.
- Model identity, generated timestamp and SHA-256 input fingerprint.

The storyboard is stored inside the active creative project. The scene, shot, prompt and character suggestion fields can be edited independently. Adding a fictional character creates a reusable project character and links matching shot references. Saving the project uses the existing revision-guarded creative workspace persistence path.

## Validation and safeguards

- Authenticated API: `POST /api/creative/storyboard`.
- Optional project ID is checked for owner/editor write access before the model request.
- Rate limit: five requests per minute per remote address.
- Request body cap: 48 KiB.
- Runtime range: 15–1800 seconds; supported aspect ratios and frame rates are explicit.
- Scene count: 2–12; shots per scene: 1–8; maximum 60 shots; each shot is 1–60 seconds.
- Shot durations must match the requested runtime within five percent.
- Character IDs must match supplied project characters; a model cannot invent an ID or attach a shot to another project's character.
- New character suggestions must be explicitly fictional.
- Prompt and brief content are treated as untrusted input. The model is instructed not to invent facts, evidence, permissions or consent.
- Workspace persistence preserves bounded Creative Director and storyboard JSON artifacts with depth, node, field and byte limits.
- A user confirmation precedes each model request because remote text-model use may incur charges.

## Research-derived functionality

The feature set follows standard production needs: scenes and shots as separate units; explicit shot framing and camera movement; dialogue and action notes; sequential scene/shot numbering; per-shot annotations; continuity and transitions; timed panels; and a plan that can later become an animatic or editing sequence. These are functional patterns, not copied branding, icons, labels or proprietary UI.

References reviewed:
- Vancouver Public Library storyboard conventions: scene/shot units, camera and subject movement, framing and numbering.
- Toon Boom Storyboard Pro help: scene/panel structure, timed animatic, sound, camera moves and export paths.
- Fabric storyboard workflow: linking visual frames with scripts, references and production notes.
- Celtx storyboard help: sequences, panels, presentation, comments, aspect ratios and undo/redo.
- Capturable storyboard documentation: scene duration, prompts, character/place assignments, continuity and readiness.

## Current limits

This stage creates textual storyboard prompts and structured production metadata. It does not create storyboard images, animatic video, audio, timeline tracks or provider jobs. It does not yet provide real-time multi-user co-editing or approval signatures. P1.5 will convert the reviewed storyboard into editable timeline tracks/clips using stable scene/shot lineage and validated frame-rate/timebase conversion.
