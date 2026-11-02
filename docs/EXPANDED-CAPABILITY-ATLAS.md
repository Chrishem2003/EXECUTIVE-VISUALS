# Executive Visuals — expanded capability atlas

**Revision:** 2026-10-31  
**Purpose:** Convert public, observable creative-software workflows into a provider-neutral product specification.  
**Naming policy:** This document describes capabilities and workflows without competitor branding.

## Evidence and implementation discipline

Every entry must be tagged in the implementation backlog as one of:
- **Publicly documented:** an official public source describes the capability.
- **Publicly visible:** a public product surface exposes the control or workflow.
- **Inferred:** a useful product design derived from observed behavior; not a claim about another system's internals.
- **Unverified:** needs authorized account access, a reproducible test, or a provider contract.

This atlas is intentionally broader than the currently implemented application. Inclusion means "design and track this capability", not "it is already working". No provider adapter may claim support until its live contract, constraints, error behavior and test evidence are recorded.

## 1. Product definition

Executive Visuals is a unified visual-production operating system. A user should be able to start with a goal, a rough idea, a script, a reference, a product, a document or existing footage; develop a production plan; create or source assets; assemble and refine media; review it; localize it; approve it; and deliver it to the intended channels.

The system must combine:
1. Creative direction and production planning.
2. Image, video, audio, presenter and motion creation.
3. Non-destructive editing and post-production.
4. Reusable workflows and agentic orchestration.
5. Brand, campaign and high-volume content operations.
6. Collaboration, review, permissions and governance.
7. Provider-neutral integrations and local processing.
8. Asset lineage, cost control, observability and durable storage.

## 2. Capability domains

### A. Creative intelligence and direction
- Natural-language brief intake and clarification.
- Audience, objective, message, platform and distribution analysis.
- Creative strategy, concept territories and moodboards.
- Genre, era, tone, visual language and art-direction profiles.
- Reference-image/video/audio analysis.
- Prompt drafting, prompt enhancement and structured prompt variables.
- Model recommendation based on quality, latency, cost, modality and constraints.
- Story, episode, series and campaign planning.
- Creative critique, consistency checks and revision suggestions.
- Reusable skills, recipes and production playbooks.
- Plan preview with editable steps, inputs, outputs, risk and estimated spend.

### B. Script, story and pre-production
- Topic research and source-backed claims.
- Hooks, titles, loglines, outlines, scripts and alternate takes.
- Dialogue, narration, scene descriptions and stage directions.
- Duration and word-count budgeting with speaking-rate estimates.
- Character bible, relationship map and continuity notes.
- Scene breakdown and shot-list generation.
- Storyboards, multi-frame sequences and animatics.
- Shot numbering, shot duration, transition intent and continuity constraints.
- Camera position, framing, lens, focal length, aperture and movement.
- Lighting design, color palette, atmosphere and production design.
- Wardrobe, props, locations, blocking, gestures and facial-expression direction.
- Casting and presenter selection.
- Production schedule, dependency planning and shot coverage checklist.
- Script-to-storyboard and storyboard-to-shot-plan traceability.

### C. Identity, characters and presenters
- Reusable character profiles with approved visual references.
- Character identity and look separation.
- Wardrobe, hair, makeup, accessories and age/style variants.
- Character groups, casts, scenes and project-specific sharing.
- Presenter catalogue and presenter matching.
- Photo-based and footage-based presenter creation where provider-supported.
- Identity training lifecycle and readiness state.
- Voice pairing and pronunciation profile.
- Gesture, motion and performance references.
- Character continuity scoring and reference manifests.
- Consent, ownership, permitted purposes, expiry and revocation.
- Provenance and source deletion policy.
- Explicit protection against unauthorized impersonation.

### D. Image creation and image editing
- Text-to-image and reference-guided image generation.
- Image variation, remix, style transfer and composition control.
- Inpainting, outpainting, generative fill and regional edits.
- Object insertion, removal, replacement and background reconstruction.
- Background removal and transparent cutouts.
- Product placement and scene compositing.
- Subject/style reference profiles and reusable visual models where permitted.
- Moodboard creation, curation and palette extraction.
- Image restoration, scratch/damage repair and colorization.
- Face/portrait retouching with per-subject controls.
- Upscaling and detail recovery.
- Crop, resize, extend, aspect-ratio conversion and format conversion.
- Text rendering, typography, layout and vector-oriented output.
- Batch generation, contact sheets, seed tracking and side-by-side comparison.
- Image metadata, embedded provenance and edit history.

### E. Video creation and generative motion
- Text-to-video, image-to-video, video-to-video and reference-to-video.
- First-frame, last-frame, keyframe and multi-reference conditioning.
- Motion prompting and motion-reference transfer.
- Camera movement, subject movement and scene dynamics.
- Multi-shot generation with global project direction and per-shot overrides.
- Native dialogue, speech, ambience, music and sound effects where supported.
- Video extension, continuation and reverse/forward extension where supported.
- Regional edits, object replacement and localized scene changes.
- Scene, shot and take management.
- Clip duration, frame rate, resolution, aspect ratio, seed and quality controls.
- Model-specific reference roles and supported input limits.
- Generation preview, selected-take approval and alternate-take management.
- Shot continuity checks for identity, wardrobe, location, lighting and screen direction.

### F. Cinema and camera direction
- Camera body/emulation profile.
- Lens family, focal length, aperture and depth-of-field intent.
- Camera height, angle, distance, framing and movement path.
- Pan, tilt, dolly, truck, orbit, crane, handheld, POV and tracking moves.
- Focus pull, rack focus and motion cadence.
- Lighting presets and custom color/intensity/diffusion/direction.
- Film stock, sensor/look, grain, halation and color science profiles.
- Global project look with shot-level overrides.
- Speed ramps, slow motion and tempo maps.
- Director assistant that proposes a shot plan but never commits paid generation without approval.

### G. Editing, timeline and finishing
- Multitrack video, audio, image, title, subtitle and overlay timeline.
- Clip trim, split, ripple delete, slip, slide, reorder and duplicate.
- Track grouping, nesting, locking, muting and solo.
- Transitions, compositing, blend modes, masks and keyframes.
- Motion graphics, animated typography, lower thirds and logo animation.
- Scene layouts, split screens, picture-in-picture and responsive reframing.
- Proxy editing and relinkable high-resolution originals.
- Frame-accurate markers, comments and review ranges.
- Audio waveform and transcript-synchronized editing.
- Captions, subtitle styling and safe-area checks.
- Color correction, grading, LUTs, shot matching and reference matching.
- Stabilization, deblur, denoise, deinterlace and frame interpolation.
- Render queue, render presets, codec/container, bitrate, audio mix and delivery profiles.
- Project archive, relink, consolidate and package.
- Non-destructive revisions and reversible edit decisions.

### H. Audio, voice and speech
- Text-to-speech and streaming speech synthesis.
- Voice catalogue, search, audition and saved voice profiles.
- Voice design from text and authorized voice cloning.
- Voice sample ingestion, cleanup, trimming and quality checks.
- Voice settings for speed, stability, expressiveness and style where supported.
- Script-to-speech, scene-level voice assignment and multi-speaker dialogue.
- Speech-to-text, word-level timestamps and confidence.
- Speaker diarization, speaker labels and separate speaker tracks.
- Audio isolation, denoising, enhancement and source separation.
- Music generation, sound-effect generation and ambience beds.
- Audio-to-video and audio-driven lip synchronization.
- Loudness normalization, ducking, fades, EQ, compression and mixing.
- Filler-word and silence detection/removal with editable cuts.
- Pronunciation dictionaries and brand glossaries.
- Audio asset versioning and voice-rights records.

### I. Translation and localization
- Transcript translation and script localization.
- Video/audio dubbing with speaker mapping.
- Voice preservation or approved replacement voice.
- Lip synchronization and timing adjustment.
- Subtitle translation, SRT/VTT import/export and caption burn-in.
- Glossary rules: preserve, do-not-translate, forced translation and pronunciation.
- Locale-specific typography, date/number conventions and safe areas.
- Multi-language batch jobs and per-locale review.
- Source-to-target lineage and synchronized revision updates.
- Quality checks for timing, truncation, speaker identity and terminology.

### J. Enhancement and restoration
- Scene-aware enhancement profiles.
- Resolution upscaling with model-specific output limits.
- Denoising, deblocking, deblurring and sharpening.
- Face and detail restoration with strength controls.
- Low-light recovery, exposure and color restoration.
- Stabilization and rolling-shutter correction where supported.
- Frame interpolation and slow-motion conversion.
- SDR/HDR conversion and tone mapping where supported.
- Object removal with spatial masks and temporal tracking.
- Watermark/text removal only for authorized rights-holders with explicit attestation; disabled by default.
- Batch/folder processing, preview comparison and output quality checks.
- Hardware-aware model selection, model installation and disk-space estimates for local engines.

### K. Workflow canvas and reusable automation
- Infinite pan/zoom canvas with node selection and keyboard shortcuts.
- Input nodes for text, prompt, image, video, audio, documents and structured data.
- Model nodes, utility nodes, LLM/planning nodes, approval nodes and export nodes.
- Typed ports with semantic roles: identity reference, style reference, start frame, end frame, mask, soundtrack, transcript and more.
- Compatible-edge validation, required-input validation and cycle detection.
- Sequential and parallel execution, branching and merge nodes.
- Run-all, run-selected-node and run-selected-subgraph.
- Lock/freeze successful outputs to prevent unwanted regeneration.
- Node swap only when input/output contracts are compatible.
- Batch edit shared node settings.
- Reusable templates, published workflow apps and copy-to-workspace.
- Workflow version history, restore and immutable run snapshots.
- Run queue, active-run panel, progress, cancellation and error inspection.
- Per-node retries, caching, idempotency and downstream invalidation.
- Partial failure isolation; successful sibling outputs must remain intact.
- Cost/time preflight and budget ceilings before execution.
- Project/workspace/link sharing with explicit visibility and input/output asset rules.

### L. Agent and orchestration layer
- Conversational intake and structured goal extraction.
- Plan generation, critique and editable step graph.
- Tool/model selection and capability negotiation.
- Dynamic provider routing with explicit reason and fallback policy.
- Missing-input detection and clarifying questions.
- Policy, consent, rights and budget checks before execution.
- Human approval gates for paid work, external actions, publishing and destructive operations.
- Safe dry-run and deterministic validation.
- Long-running task state machine and checkpoint recovery.
- Pause, resume, cancel and stop-at-next-checkpoint.
- Scheduled and recurring work with explicit budget and permission scope.
- Memory separated into project facts, user preferences and temporary task context.
- Skills with version, inputs, outputs, permissions, tests and provenance.
- Agent-created mini-apps isolated from production until tested.
- Execution trace, tool-call log, artifact lineage and reproducible run manifest.

### M. Campaign, commerce and content operations
- Product URL and catalog ingestion.
- Product fact extraction with source references and confidence.
- Brand kit ingestion: logos, colors, fonts, imagery, tone and rules.
- Campaign brief, audience, offer, channel, placement and CTA.
- Creative angles, hooks, proof points and objection handling.
- Template-first, prompt-first and authorized-reference-first workflows.
- Static ads, product photography, UGC-style creative, video ads and posters.
- Presenter, setting, product, hook and CTA variation matrix.
- Bulk SKU/campaign generation and asset naming rules.
- Brand-template autofill from CSV/JSON/data tables.
- Variant approval, performance tags and campaign-level asset lineage.
- Platform-specific dimensions, duration, captions and safe zones.
- Publishing handoff and channel-specific export bundles.
- Content calendar and scheduled delivery.

### N. Design, documents and presentations
- Document-to-video and presentation-to-video.
- Slide generation, slide editing and speaker notes.
- Data-driven template population.
- Brand templates and locked brand elements.
- Layout composition, typography and design-system tokens.
- Comments, replies, mentions and design review.
- Design page analytics and share/view metrics where supported.
- Export to image, video, PDF, presentation and web formats.
- Import/export to external design environments through authorized APIs.

### O. Asset and project management
- Organization, workspace, project, folder and collection hierarchy.
- Asset upload by file, URL and resumable/presigned upload.
- Asset metadata, checksum, MIME, duration, dimensions, frame rate and codec.
- Tags, search, filters, saved views and smart collections.
- Source, generated, derived, proxy and delivery asset types.
- Parent/child lineage, revision chain and content-addressed deduplication.
- Thumbnails, contact sheets, waveforms and previews.
- Retention, archive, legal hold and user-controlled deletion.
- Provider output URL expiry detection and automatic durable copy.
- Asset permissions, share links, expiry and download controls.
- Import/export manifests and project portability.

### P. Collaboration, review and governance
- Multi-user workspaces and project roles.
- Fine-grained permissions for view, edit, generate, approve, publish, export and delete.
- Comments, replies, mentions, annotations and timecoded review.
- Review states: draft, internal review, changes requested, approved, rejected and delivered.
- Approval policies per action, project and spending threshold.
- Audit log for settings, assets, jobs, permissions and exports.
- Consent records for face, voice, likeness, trademarks, products and reference media.
- Rights and license declarations for uploaded references.
- Data retention, deletion and revocation workflows.
- Tenant isolation, secrets vault and scoped provider credentials.
- SSO/SCIM and enterprise policy hooks when supported.
- Abuse prevention, rate limits, quotas and spend controls.

### Q. Integrations and developer platform
- Provider adapters with capability, model, version and plan metadata.
- REST API, SDKs, webhooks, MCP-compatible tool surface and CLI.
- OAuth and API-key connections with least privilege.
- Webhook HMAC verification, event deduplication and fast acknowledgment.
- Polling fallback, retry policy and Retry-After support.
- Idempotency keys and request correlation IDs.
- Upload sessions, presigned URL handling and output ingestion.
- Provider status, quota and pricing discovery.
- Integration health checks and credential expiry warnings.
- Plugin/extension SDK with sandboxed permissions.
- OpenAPI schema import and contract-drift detection.
- Provider adapter conformance test suite.

### R. Operations, cost and reliability
- Unified job state machine with needs-input, blocked, awaiting-approval, queued, submitted, processing, reviewing, completed, partial, failed, cancelled and expired.
- Per-step progress and provider job ID.
- Estimated versus actual cost and usage units.
- Budget ceilings, spend alerts and approval thresholds.
- Concurrency/rate-limit awareness and queue fairness.
- Timeout, cancellation, retryability and backoff metadata.
- Provider error normalization without losing raw diagnostic evidence.
- Cache keys, cache invalidation and deterministic reuse.
- Model availability and regional constraints.
- Hardware/VRAM/disk preflight for local execution.
- Durable logs, metrics, traces and audit events.
- Recovery after process restart and webhook loss.
- Backup, restore, export and disaster recovery.

### S. Quality, accessibility and delivery
- Resolution, aspect ratio, frame rate, duration and codec validation.
- Black-frame, freeze-frame, clipping, silence and audio-peak detection.
- Subtitle overflow, reading speed and safe-area checks.
- Brand color/logo/font compliance.
- Identity/wardrobe/location continuity review.
- Speech transcript alignment and pronunciation checks.
- Product factual-claim/source checks.
- Accessibility captions, transcripts, contrast and descriptive metadata.
- Watermark/rights review and AI disclosure metadata.
- Delivery profiles for social, broadcast, web, archive and client handoff.
- Export checksum, manifest and version receipt.

## 3. Cross-cutting data model

Minimum durable entities:
- Organization, Workspace, Membership, Role, Permission
- Project, CreativeBrief, CampaignBrief, ProductProfile, BrandKit, BrandGlossary
- Story, ScriptVersion, CharacterBible, CharacterIdentity, ConsentGrant, PresenterLook, VoiceProfile
- Scene, Shot, StoryboardFrame, CameraSetup, LightingSetup, ProductionSchedule
- Asset, AssetVersion, AssetReference, AssetLineage, UploadSession, ExportPackage
- WorkflowDefinition, WorkflowRevision, WorkflowNode, WorkflowEdge, WorkflowRun, NodeRun
- CapabilityDefinition, Provider, ProviderModel, ProviderPlan, ProviderCredentialReference
- Job, JobEvent, UsageRecord, CostEstimate, ApprovalRequest, AuditEvent
- Timeline, Track, Clip, Effect, Keyframe, Marker, ReviewComment, ReviewDecision
- LocalizationProject, LanguageTrack, Transcript, Speaker, SubtitleTrack, GlossaryEntry
- Delivery, ChannelProfile, PublishSchedule, AnalyticsSnapshot
- SkillDefinition, SkillVersion, AgentPlan, AgentCheckpoint, ScheduledTask

Every provider-specific field belongs in a versioned adapter payload, not in the shared domain model.

## 4. Canonical lifecycle and invariants

### Workflow/job lifecycle
`draft → validated → awaiting_approval → queued → submitted → processing → reviewing → completed`

Exception states: `needs_input`, `blocked`, `partial`, `failed`, `cancelled`, `expired`.

### Required invariants
1. Planning and validation never spend provider credits.
2. Paid execution requires a user-approved immutable run snapshot.
3. Provider/model/version/plan constraints are captured at execution time.
4. A successful output is immutable; edits create a new version.
5. A failed node does not destroy successful sibling outputs.
6. A retry must be safe, idempotent or explicitly approved.
7. Every output records its input lineage and rights context.
8. Consent is purpose-scoped, time-bounded where appropriate and revocable.
9. Provider output URLs are copied to durable storage before expiry.
10. No adapter advertises a capability without contract and conformance evidence.
11. No unknown limit is silently guessed.
12. Destructive actions, publishing and external side effects require explicit approval.
13. Secrets never enter client bundles, prompts, logs or repository files.
14. A local model's hardware, storage and license requirements are preflighted.
15. The UI distinguishes planned, simulated, provider-submitted and completed work.

## 5. Workflow templates that should ship

1. **Idea → Episode:** research → brief → hook → script → storyboard → shot plan → presenter/voice → generation → timeline → captions → review → export.
2. **Script → Multi-shot Film:** script analysis → scene split → shot breakdown → global look → per-shot overrides → parallel generation → take selection → continuity review.
3. **Product → Campaign:** product ingestion → fact validation → brand kit → audience/angle matrix → static/video variants → compliance review → channel exports.
4. **Long Recording → Clips:** ingest → transcription → speaker separation → topic/scene detection → highlight selection → clip generation → reframing → captions → review.
5. **Footage → Restoration:** ingest → technical analysis → repair plan → preview sample → enhancement chain → quality comparison → batch render.
6. **One Master → Localized Series:** transcript → glossary → translation → speaker map → voice/dub → lip sync → subtitles → locale review → delivery.
7. **Reference → Original Look:** rights declaration → reference analysis → palette/style profile → approved reusable brand direction → original assets.
8. **Presentation → Video:** slide ingestion → structure extraction → narration → presenter/voice → motion design → timeline → captions → export.
9. **Podcast → Branded Show:** episode plan → script → presenters → set/wardrobe bible → multi-camera shots → voice/music → edit → shorts → thumbnails.
10. **Reusable Workflow → Mini App:** define inputs → graph → validate → simulate → approve → publish isolated app → monitor versions and runs.

## 6. Capability registry contract

Each capability entry must declare:
- Stable capability ID and version.
- Input and output schemas with semantic media roles.
- Supported provider/model/plan combinations.
- Constraints: file types, sizes, durations, dimensions, reference counts, languages, frame rates and region.
- Execution mode: synchronous, asynchronous, streaming or interactive.
- Cost model and estimate availability.
- Consent/rights requirements.
- Retry, idempotency, cancellation and webhook behavior.
- Data residency, retention and output URL lifetime.
- Readiness: documented, tested, credentials-required, unsupported or disabled.
- Evidence references and last-verified timestamp.

A generic "supports video" flag is insufficient. Capabilities must be specific enough to validate a real job before it is submitted.

## 7. Research coverage and remaining unknowns

Public research across additional ecosystems has revealed:
- Node workflows with LLM nodes, media utility nodes, templates, node locking, batch settings, version history, sharing and active-run tracking.
- Custom subject/style models, composite product-scene operations, image upscaling and instructive editing.
- Design APIs for assets, folders, templates, autofill, comments, replies, exports, page analytics and video element manipulation.
- Audio APIs covering streaming, speech recognition, diarization, voice creation, dubbing, music, sound effects and voice agents.
- Local enhancement workflows with model installation/removal, disk-space and hardware checks, batch/folder import and dedicated restoration operations.
- Local graph engines with typed node metadata, validation, queue/history APIs, WebSocket progress, cancellation, uploads, masks and model inventory.

Still unknown without authorized testing:
- Private signed-in feature flags and account-specific entitlements.
- Exact hidden controls in private editors.
- Provider-internal prompts, weights, implementation and private APIs.
- Undocumented limits, billing exceptions and retention behavior.
- Cross-platform parity between web, desktop and mobile.
- Actual performance/quality under our target hardware and usage.

These must remain unknown until verified. No fabricated parity claims.

## 8. Build order

### Foundation (must precede production integrations)
- Capability registry and provider/model constraint contracts.
- Asset store with checksum, lineage and durable retention.
- Workflow graph schema, validator, snapshots and run history.
- Unified job state machine, event log and idempotency.
- Approval, consent, rights and spend controls.
- Provider adapter interface and conformance tests.

### First complete vertical slices
1. Script/storyboard/shot planning to an editable production plan.
2. Image and video generation through one explicitly configured provider adapter.
3. Timeline assembly and deterministic export using local/open tooling.
4. Audio transcript, voice, captions and localization pipeline.
5. Enhancement chain with preview and quality checks.
6. Campaign variants and brand-template data autofill.
7. Workflow canvas with templates, partial runs and version history.

### Scale and enterprise
- Multi-user collaboration, review and tenant isolation.
- Provider marketplace and adapter SDK.
- Scheduled agent workflows and mini-app publishing.
- Analytics, usage ledger, billing and governance.
- Local compute pool and remote worker orchestration.

**Current implementation status:** the repository has an early local-first planning/workflow foundation. This atlas is a target specification; it does not imply that generation, rendering, storage, collaboration, or provider integrations are complete.


## 9. Additional professional-production domains

### Spatial, 3D and procedural creation
- 3D scene, collection, object, mesh, camera, light and material management.
- Procedural geometry and node-based material/compositing graphs.
- Modeling, sculpting, UVs, texture painting, baking and material assignment.
- Character rigging, skeletal animation, facial animation and motion retargeting.
- Camera tracking, object tracking, match-moving and scene reconstruction.
- Physics, particles, cloth, hair, fluids and simulation caches.
- 3D asset import/export, linked assets and dependency packaging.
- Render layers/passes, render farms, frame-range scheduling and render-farm telemetry.
- 2D/3D compositing, masks, keying, rotoscoping, tracking and color integration.
- Virtual set/blocking previews and real-time scene playback.
- USD, glTF, FBX, Alembic and other interchange formats only where the chosen toolchain supports them.

### Production tracking and review operations
- Production hierarchy: show/series → project → sequence → shot → task → version.
- Assignments, owners, departments, due dates, dependencies, status and workload.
- Asset/shot version stacks with deterministic version ordering.
- Playlists, review sessions, screening links and access expiry.
- Frame-accurate annotations, drawing overlays, timecoded notes and attachments.
- Compare modes: side-by-side, wipe, ghost/overlay and previous-version hold.
- Notes resolved against specific versions and frame/time ranges.
- Approval rounds, change requests, review history and decision audit.
- Activity streams and notifications tied to production entities.
- Review access must not accidentally expose source media, unrelated project files or private outputs.

### Media ingest, proxy and interchange
- Camera-card/folder ingest with checksum verification and copy verification.
- Capture metadata, camera/lens metadata, timecode, reel and clip naming.
- Growing-file monitoring and safe ingest of media still being recorded.
- Proxy creation, original/proxy linking, relinking and selective synchronization.
- Background transcode, transcode queue, progress, pause and retry.
- Media inspection for codec, color space, frame rate, audio layout and duration.
- Editorial interchange packages and timeline round-tripping.
- Relink manifests, missing-media reports and dependency collection.
- Archive and restore with checksum validation.
- Transfer acceleration, resumable uploads and transfer integrity reports.

### Live capture and remote production
- Camera, microphone, screen and application-window capture.
- Multi-source recording with synchronized start and timecode where available.
- Remote guest contribution, isolated tracks and local recording where supported.
- Live preview, recording health, dropped-frame and audio-clipping indicators.
- Stream input, stream recording and stream-to-edit handoff.
- Virtual camera/output and live graphics overlays where supported.
- Permissioned remote control and operator handoff.
- Capture session manifest, device metadata and per-source media lineage.

## 10. Expanded end-to-end workflows

11. **Live Session → Finished Episode:** schedule → invite guests → test devices → capture isolated tracks → transcribe → select highlights → edit timeline → add graphics/music → review → publish package.
12. **3D Asset → Cinematic Shot:** ingest model → validate dependencies → materials/rig → camera/light setup → motion/physics → render passes → composite → grade → editorial timeline.
13. **Production Review Loop:** publish version → create playlist → invite reviewers → collect frame-accurate notes → compare versions → assign fixes → submit new version → resolve notes → approve.
14. **Camera Media → Editorial:** checksum ingest → metadata parse → proxy generation → timeline assembly → relink originals → grade/finish → archive package.
15. **Timeline Round Trip:** export interchange package → edit in external tool → import updated timeline → resolve media references → compare revisions → approve.

## 11. Added implementation invariants

16. Ingest is not complete until source copies are checksum-verified.
17. Proxy and original media remain explicitly linked and are never silently substituted for final delivery.
18. Review comments bind to a specific asset version and frame/time coordinate.
19. Version comparisons must preserve source timing and version identity.
20. A timeline interchange import must report unsupported effects, missing media and lossy conversions.
21. 3D renders preserve scene, asset and render-setting manifests.
22. Live capture exposes recording health and records device/source metadata.
23. Local model and render jobs disclose hardware, storage and estimated resource needs before installation or execution.
