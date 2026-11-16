# Five-Batch Production Integration

**Status:** Implemented on a feature branch; awaiting CI and review. This document describes the integrated release surface, not a claim that every optional production dependency is enabled.

## Batch 1 — Transcript-first editing
The word-level transcription and WebVTT handoff was merged to main in PR #648. A provider that returns word timings produces word-sized WebVTT cues; segment-only providers retain the segment fallback. The Timeline Paper Edit consumes those cues as individual selectable clip units. Original source media is not modified.

## Batch 2 — Media intelligence
The Timeline Editor now searches the assets already loaded and authorized for the active workspace. It ranks filename, indexed descriptions, tags, keywords and transcript text; transcript matches can include source timecodes. Search is deterministic and local, has no vector index or external model call, and does not claim visual recognition when an asset has no visual-analysis metadata. Results can be placed directly on an appropriate unlocked audio or video track using the normal timeline history and revision-guarded save path.

## Batch 3 — Creative Director and storyboard
The Timeline Editor exposes the existing authenticated Creative Director and storyboard APIs as one workflow. Sending a brief or compiling a storyboard requires an explicit confirmation because a configured remote text gateway may incur usage charges. The validated storyboard can be saved as a new cloud timeline with planned picture, sound and caption tracks, scene markers and shot lineage. No media-generation provider jobs are submitted by this operation. Shot media assignment and human review remain required.

## Batch 4 — Professional finishing
Existing audio ducking, editable gain automation and cloud loudness mastering remain the actual render path. The render history now surfaces measured integrated loudness, loudness range, true peak and the renderer's QC decision when the worker returns those values. Missing measurements remain unknown; they are not displayed as a pass.

## Batch 5 — Production reliability
The existing durable cloud render polling and cancellation controls now summarize queued/processing and failed/blocked/cancelled jobs. Jobs older than ten minutes receive a human-inspection warning, not an automatic retry or a false claim that the worker is stalled. Existing revision-guarded timeline persistence, browser recovery journal, job lease fencing and production-readiness gates remain in force.

## Operational boundaries
- Search is limited to already-authorized asset records supplied to the editor; project filtering is applied again in the browser before results are shown.
- In cloud mode, media search now refuses to run until an authorized cloud project is selected; it never falls back to searching the entire in-memory asset collection when the project context is missing.
- Search is lexical over available metadata/transcripts, not a substitute for a visual embedding index. Transcript indexing is bounded to the first 5,000 timed segments per transcript collection and 5,200 extracted text fields per asset to keep browser work predictable; longer source media should be split or indexed by a future server-side search service.
- Creative Director and storyboard calls require configured server-side gateway settings and user confirmation.
- Storyboard creation saves a plan-only cloud timeline; it does not generate, buy or submit media.
- Loudness values are reported only from the render worker's measurement receipt.
- Queue age warnings do not mutate or resubmit jobs.
- No schema migration, secret, provider credential, paid infrastructure or production resource change is included in this batch.
