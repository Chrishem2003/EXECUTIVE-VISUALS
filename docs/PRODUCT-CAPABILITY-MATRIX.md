# Executive Visuals — capability research matrix

Research snapshot: 31 October 2026. Sources: public first-party product pages, help-centre documentation, developer documentation, public product directories and unauthenticated workspace landing pages.

This is an evidence-led capability map for an independently designed product. It is not a source-code reconstruction or a claim of private application parity.

## Evidence labels
- **Observed/documented:** explicitly described by a first-party public source or visible in a public page.
- **Inferred:** an engineering or UX implication, not a claim about internal implementation.
- **Unknown:** requires authorized authenticated access, controlled testing or direct confirmation.

---

## 1. Platform A

### Product and capability inventory

| Product area | Publicly documented capability | Executive Visuals interpretation |
|---|---|---|
| Cinema Studio | Project brief, genre, era, tempo, camera body, lens, focal length, aperture, camera movement, lighting, color grading, references, cast, locations, props, multi-shot scenes, per-shot settings, collaboration, folders | Production bible plus scene/shot records. Global visual rules with shot-level overrides. |
| AI Director | Conversational direction, camera/light selection, prompt refinement, script-to-shot breakdown, camera parameter suggestions | Assistant proposes structured editable changes; human approval before generation. |
| Soul image generation | Text-to-image, image references, aesthetic presets, editorial/fashion/culture-oriented generation | Image model adapter plus style and reference management. |
| Soul ID | Identity training from 20+ photos according to public help; reusable identity across supported generations | Consent-gated identity asset with source provenance, usage scope and revocation. |
| AI Influencer | Menu-driven human and non-human character builder; identity, face, body, style; reusable character library; direct animation | Structured character composer and reusable cast records. |
| Motion Control / Genjutsu | Motion-reference video and preset-driven movement/effects | Motion-transfer and preset execution capabilities. |
| Marketing Studio | Template-first product ads; Product Shot, Motion, UGC, TikTok, Ads, Posters, Marketplace; product image replacement; avatar/hook/setting changes; product URL ingestion; reference-ad structure; prompt fallback | Product profile, template recipes, ad creative angles and variant matrix. |
| Ads Studio | Website/brand/product ingestion; brand kit; selling-angle research; batch static ads by SKU, angle and design | Brand ingestion, catalog, campaign brief and batch creative generation. |
| Canvas | Infinite node board; prompt/text/reference/upload/model nodes; image/video/audio generation; sequential and parallel execution; side-by-side comparison; reusable templates; collaboration; autosave | Typed directed acyclic graph, node-level jobs, execution history and cost preflight. |
| Supercomputer | Natural-language brief; task decomposition; model routing; image/video/audio generation; external connectors; skills; memory; workspace storage; schedules; app/website/game building | Agentic orchestrator over shared project and workflow graph. |
| Model catalogue | First-party and external model families; model choice; differing constraints and costs | Dynamic provider registry with live constraints, version and pricing. |
| Integrations | MCP, CLI/skills, Figma/FigJam plugin, external connectors | Integration boundary using documented APIs and user-authorized connectors. |
| Editing and enhancement | Image/video editing, ad variation, enhancement, audio and model-specific transformations | Non-destructive edit graph and dedicated processing adapters. |

### Cinema Studio: original domain model

A production contains a brief, genre, era, tempo, aspect ratio, output intent, style, color palette, lighting profile, references and team.

Each shot contains order, scene, subject, action, camera body, lens, focal length, aperture, ordered movement sequence, lighting override, duration, prompt, reference roles and selected model.

Reusable elements include cast identities, wardrobe, locations, props and their source references. A generation attempt stores the prompt snapshot, model/version, parameters, input references, estimate, provider job ID, status, outputs, error and audit history.

Public documentation varies by Cinema Studio version on maximum duration and reference counts. Therefore limits must be read from the selected model/version capability schema, never hard-coded as universal product limits.

### Canvas graph semantics

Documented workflow patterns:
1. Text prompt feeds image generation.
2. Image output feeds video generation.
3. Video output feeds edit or enhancement.
4. Parallel model nodes produce comparable outputs.
5. Audio references can feed supported video/audio workflows.
6. A completed graph can be saved as a reusable template.

Original implementation rules:
- Explicit typed input ports: prompt, image reference, start frame, end frame, audio, video, mask and text.
- Reject incompatible edges before execution.
- Node configuration is a draft; each run creates an immutable execution snapshot.
- Each node is independently retryable only when safe and idempotent.
- Dependent nodes wait for valid upstream outputs.
- Graph editing is separate from paid execution.
- Persist intermediate assets, hashes, provenance and parent-child relationships.

### Agentic orchestration

The Executive Visuals agent should turn an outcome request into a draft plan, explain each step/model choice, show required inputs and expected outputs, estimate cost/time, request missing references and rights/consent, require approval before paid or external actions, execute the approved graph, expose intermediate results, and rerun only affected nodes after changes.

Persistent project memory must be distinct from transient chat context. Recurring jobs need an explicit schedule, budget ceiling and approval policy.

---

## 2. Platform B

### Avatar and identity families

| Area | Publicly documented capability | Executive Visuals interpretation |
|---|---|---|
| Stock avatars | Catalogue of presenters | Provider-neutral presenter catalogue. |
| Digital twins | Presenter identity generated from source footage with consent | Identity asset, capture/training job, consent grant and revocation. |
| Photo avatars | Talking presenter from a still image and script/audio | Dedicated image-to-talking-presenter capability, distinct from generic image-to-video. |
| Video avatars | Presenter trained from video footage | Training workflow, readiness status, voice pairing and rights. |
| Cinematic avatars | Short prompt-driven avatar performances with references | Specialized scene/performance generation. |
| UGC avatars | Creator-style actors for ads | Presenter casting by audience, style and use case. |
| Avatar looks/groups | Reusable looks and grouped identities | Canonical identity with approved looks and wardrobe variants. |

### Video creation modes

- Script-to-avatar: exact script spoken by selected avatar and voice.
- Prompt-to-video / Video Agent: brief converted into script, scene plan, presenter/voice choices, composition and rendered video.
- Image-to-video: animate a still image.
- Audio-to-video / lip-sync: align mouth movement to supplied or generated audio.
- Studio composition: ordered scenes combining avatar, image and video segments.
- Templates: fixed layouts with variable data for branded repeatability.
- Batch generation: create multiple outputs from structured inputs.
- AI clipping: derive clips from longer source media.
- Filler-word removal: speech cleanup.
- Background music and sound effects: soundtrack and effects layer.

### Voice, translation and localization

Public documentation covers text-to-speech, public and compatible private voices, voice cloning, voice settings, locale compatibility, video translation/dubbing, lip-sync translation, speed and precision modes, audio-only translation, captions, speaker separation, partial translation by time range, background music removal, speech enhancement, brand glossary and multi-language batch jobs.

Original design: link source script, source audio, transcript, translated transcript, pronunciation glossary, speaker map, voice assignment, timing map and rendered language variants. A translated output must remain traceable to its source version.

### Video Agent interaction pattern

1. User provides job, audience and scale, with optional source documents/attachments.
2. Agent proposes or creates a production plan.
3. User reviews and revises key choices in a conversational workflow.
4. Agent selects avatar, voice, model, brand kit and output settings.
5. Render starts asynchronously.
6. Status updates arrive through polling or webhooks.
7. Final video, captions and metadata are delivered.
8. Batch variants or language versions derive from the same source.

Keep planning conversation, structured plan, immutable job snapshot and render status as separate domain records. Do not couple the UI to one provider request schema.

### Brand and enterprise layer

Publicly documented areas include brand kits, glossaries, template repeatability, team workspaces, SSO/security material, API key and OAuth/MCP access, REST APIs, CLI, SDK references, webhooks and batch endpoints. Developer documentation advertises batches up to 100 requests per call, subject to live API/account limits.

Executive Visuals should provide tenant-scoped brand spaces, role-based access, audit logs, a provider key vault, webhook verification, rate limits, per-tenant quotas and approval policies.

---

## 3. Platform C

### Public workspace structure

The unauthenticated workspace landing surface exposes Home, Video, Image and Recents. It lists dedicated editing tools and a custom workflow area. Private account history and authenticated editor state were not inspected.

### Video tool families

| Tool family | Documented function | Executive Visuals interpretation |
|---|---|---|
| Video Enhancer / AI UHD | Scene-aware repair; portrait, concert, animation, game, product and AI-generated-visual modes | Scene classification, model routing and adjustable strength. |
| Video Repair | Detect and repair quality defects | Auto-diagnosis followed by repair pipeline. |
| Video Upscaler | Resolution options up to 8K on a public page | Resolution-aware processing with file-size/cost preflight. |
| Video Denoiser | Reduce noise while retaining detail | Adjustable denoise operation. |
| Low-light enhancement | Improve dark footage | Exposure/noise restoration pipeline. |
| Video Retouch | Face and body retouching, multi-face workflows | Track identities and apply per-subject settings. |
| Watermark/text removal | Automatic or manual marking/removal | Mask creation, temporal tracking and inpainting. |
| Object removal | Mark unwanted object and reconstruct background frame by frame | Mask timeline, object tracking and temporal inpainting. |
| AI Video Expansion | Extend frame/canvas for new aspect ratios | Generative outpainting with composition controls. |
| Frame interpolation | Generate intermediate frames | FPS conversion with motion-artifact review. |
| Color matching | Batch color adjustment | Reference-based transform/LUT workflow. |
| Color correction | Correct visual tone | Exposure, white balance, contrast and color controls. |
| Converter/compressor | Format and file-size conversion | Deterministic media utilities. |
| Audio extractor | Extract audio from video | Derived audio asset. |
| Image-to-video / Text-to-video | Generate motion from text or image | Generation adapter, not a repair operation. |
| Template-to-video | Preset-led media creation | Template and asset-slot system. |
| AI Anime/effects | Stylize footage | Style-transfer adapter and versioned presets. |

### Image tool families

Public pages describe image quality enhancement and super-resolution, photo restoration, unblur/sharpen, portrait retouch and skin smoothing, face detail enhancement, product-image enhancement, text clarity, object/sticker/logo removal, background cutout/replacement, image expansion/outpainting, color enhancement/matching, creative style conversion and image-to-video.

### Custom Workflow pattern

The public workspace shows ordered custom processing steps after upload/import, with batch upload available on some tools.

Original design:
- User creates a reusable recipe from approved steps.
- Every step declares accepted MIME types, maximum dimensions/duration, parameters and output type.
- Preview the pipeline and estimate cost/time before execution.
- Each output is a derivative of its source.
- A failed step resumes from the last valid output.
- Batch processing preserves per-asset results and errors.
- Before/after comparison and adjustable intensity are first-class controls.

### Integrity controls

- Object/watermark removal is for material the user has rights to edit; never position it as a way to defeat ownership marks or licensing controls.
- Retouch is optional, adjustable and non-destructive.
- AI reconstruction can invent texture/detail not present in the original; label it accordingly.
- Preserve masks, parameters and source media for revision.

---

## 4. Consolidated Executive Visuals workspaces

1. Command Centre — projects, production status, approvals, costs and outputs.
2. AI Director — brief intake, story development, creative direction and structured plan.
3. Production Bible — brand, tone, cast, wardrobe, locations, props, visual rules and rights.
4. Storyboard & Shot Planner — scenes, beats, shot list, lens/camera/light/movement and timing.
5. Character & Voice Studio — original characters, licensed likeness profiles, voice profiles and consent.
6. Image Studio — text/reference generation and image editing.
7. Cinematic Studio — shot-level image/video generation and continuity controls.
8. Presenter Studio — scripted presenter, photo/video avatar, voice and lip-sync.
9. Audio & Localization — TTS, transcription, translation, dubbing, glossary and captions.
10. Timeline Editor — non-destructive multi-track editing and render graph.
11. Enhancement Lab — restoration, upscale, denoise, retouch, removal, expansion, interpolation and color.
12. Campaign Studio — product ingestion, creative angles, templates, variants and channel exports.
13. Workflow Canvas — visual DAG for chaining providers, models and deterministic tools.
14. Asset Library — versioned media, references, generated assets, metadata, rights and lineage.
15. Engine Marketplace — provider adapters, model versions, limits and health.
16. Automation & Scheduler — approved recurring jobs and batch processing.
17. Team & Review — comments, approvals, permissions and audit history.
18. Settings & Governance — credentials, quotas, storage, retention and policy.

All workspaces share project IDs and the same project/asset/job records. No module should create a disconnected project copy.

## 5. Unified project record

A production project owns the brief, audience, brand, cast/identity and consent, script versions, storyboard, shot list, references and their roles, workflow graph, jobs, assets and derivatives, review/approval decisions, export profiles, final deliverables, cost ledger and audit events.

## 6. Research sources

### Platform A
- [Public source ref EXT-001] A.ai/creator-hub/help-center/getting-started/what-is-Platform A
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/which-Platform A-tool-should-i-use
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-canvas
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-ai-influencer
- [Public source ref EXT-001] A.ai/creator-hub/changelog
- [Public source ref EXT-001] A.ai/cinematic-video-generator
- [Public source ref EXT-001] A.ai/soul-intro

### Platform B
- [Public source ref EXT-002] B.com/llms.txt
- [Public source ref EXT-003] B.com/llms.txt
- [Public source ref EXT-003] B.com/
- [Public source ref EXT-003] B.com/mcp/overview
- [Public source ref EXT-002] B.com/tool
- [Public source ref EXT-002] B.com/avatars
- [Public source ref EXT-002] B.com/translate
- [Public source ref EXT-002] B.com/enterprise
- [Public source ref EXT-002] B.com/security

### Platform C
- [Public source ref EXT-001] C.ai/workspace
- [Public source ref EXT-001] C.ai/ai-workflow
- [Public source ref EXT-001] C.ai/
- [Public source ref EXT-001] C.ai/benefits
- [Public source ref EXT-001] C.ai/about-us
- [Public source ref EXT-001] C.ai/video-enhancer/upload
- [Public source ref EXT-001] C.ai/video-repair/upload
- [Public source ref EXT-001] C.ai/video-upscaler/upload
- [Public source ref EXT-001] C.ai/video-retouch/upload
- [Public source ref EXT-001] C.ai/video-watermark-remover/upload
- [Public source ref EXT-001] C.ai/video-frame-interpolation/upload
- [Public source ref EXT-001] C.ai/ai-video-extender/upload
- [Public source ref EXT-001] C.ai/video-color-match/upload
- [Public source ref EXT-001] C.ai/remove-object-from-video
- [Public source ref EXT-001] C.ai/text-to-video-ai

### Method
- [Public source ref EXT-004]
- [Public source ref EXT-005]
