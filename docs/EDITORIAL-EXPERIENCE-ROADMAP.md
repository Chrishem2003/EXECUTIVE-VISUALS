# Editorial Experience Roadmap

## Product direction

Build an original, professional creative workspace that combines a fast social-video workflow with the precision, provenance and review controls expected in a production editor. Learn from established editing patterns without copying proprietary code, assets, templates or branding.

The editor should make common work fast for a solo creator while preserving an inspectable, reversible path for professional and team production.

## Verified foundations already in the repository

- Multi-track, frame-aware timeline editing with revision checks and interchange support.
- Independent timeline variants, structural comparison, creative-intent traceability and a bounded decision history.
- Creative brief compilation and production-readiness reporting.
- Media ingest, probing, thumbnails, proxy/transcode, denoise, color adjustment, resize, interpolation, upscale and audio cleanup operations.
- Approval-gated speech transcription, translation and subtitle asset generation.
- SRT and WebVTT timeline assets, cue validation, caption readability findings and caption burn-in.
- Caption styling controls for font, size, text color, placement, bottom safe-area margin, background panel, panel color/opacity, outline and shadow.
- Source-media, rights/consent, audio, caption and current-master delivery evidence.
- Cloud render output probing before master publication.

These foundations do not imply that every advanced effect or AI feature below is implemented.

## Prioritized capability plan

### P0 — Make the everyday editor feel finished

1. **Caption style presets**
   - Original presets for clean, social-bold, cinematic and minimal looks.
   - Apply a preset to one caption clip or an entire caption track.
   - Preserve per-project brand styles and allow custom overrides.
   - Add a safe-area preview for common vertical, square and landscape compositions.
2. **Caption timing and accessibility**
   - Word-level highlighting only when reliable word timestamps exist.
   - Speaker labels, language-track switching and sidecar subtitle export.
   - Show reading-speed, overlap, line-length and out-of-range findings beside the relevant cue.
3. **Timeline ergonomics**
   - Keyboard shortcuts, snapping, ripple delete/insert, track grouping and clearer selection states.
   - Frame-accurate playhead navigation and a responsive preview monitor.
   - Waveforms, clip thumbnails and marker navigation.
4. **Audio finishing**
   - Track gain automation, fades, ducking and voice/music balance.
   - Keep loudness targets explicit per delivery profile; never silently normalize a user's master.

### P1 — Creator-speed automation

1. **Text-based editing**
   - Edit a transcript and create reversible timeline edit decisions from selected words/segments.
   - Detect filler words, long pauses and retakes as suggestions, not silent destructive cuts.
   - Require review before applying a batch of edits.
2. **Smart reframing**
   - Portrait, square and landscape sequence variants.
   - Preserve subject framing using measured tracking where available; expose confidence and manual correction.
   - Compare reframed variants before rendering.
3. **Long-form to short-form**
   - Suggest highlight moments using transcript, scene and audio evidence.
   - Generate editable short-form timeline variants with source lineage intact.
   - Draft titles, descriptions and chapter markers from verified project content.
4. **Beat and scene assistance**
   - Detect scene changes and music beats as timeline markers.
   - Offer cut suggestions; do not auto-cut without approval.

### P2 — Motion and visual effects

1. Keyframes for position, scale, rotation, opacity and audio gain.
2. Curve editor and speed ramps with explicit interpolation modes.
3. Transition library with duration, handles and render-time validation.
4. Masks, blend modes, chroma key and background removal.
5. Motion tracking for titles, stickers and overlays.
6. Color tools with scopes and non-destructive adjustment stacks.

Each effect must have a real renderer implementation, preview behavior, serialization and tests before it is presented as available.

### P3 — Review and collaboration

1. Timecode-anchored comments and annotations.
2. Reviewer/editor/owner roles with server-side authorization.
3. Approval checkpoints for creative decisions and final delivery.
4. Shareable review sessions with expiring, scoped access.
5. Conflict-aware collaboration and revision history; no last-write-wins overwrite of concurrent edits.

### P4 — Delivery and distribution

1. Named delivery profiles for common aspect ratios, codecs, frame rates and audio requirements.
2. Sidecar captions and burned-in caption choices.
3. Batch exports for multiple aspect ratios and languages.
4. Platform-specific title/description/thumbnail preparation.
5. Direct publishing only after destination permissions, rights and user approval are in place.

## Architecture and safety rules

- Keep the timeline as the editable source of truth; rendered files are derived artifacts.
- Preserve original media and source references. Every generated clip, subtitle and master should retain provenance.
- Keep AI and remote providers behind explicit server-side configuration, project permissions, approval gates and usage controls.
- Prefer local and open media tooling when quality is sufficient; never claim a premium AI result when a deterministic filter was used.
- Never mark an evidence check as passed when it was not run or when the required measurement is missing.
- Keep rights, likeness, voice and music permissions separate and auditable.
- All bulk edits must be previewable, reversible and revision-checked.
- Do not apply database migrations, change production services, or enable paid providers as part of feature development without explicit authorization.

## Definition of done

A capability is complete only when:
- the UI exposes a coherent workflow and explains its limits;
- the timeline/project representation persists the settings;
- the renderer or workflow actually performs the operation;
- validation rejects unsafe or unsupported inputs;
- tests cover success, failure, permissions and regression paths;
- production-readiness evidence reflects the actual result; and
- no existing project, source asset or production resource is overwritten silently.
