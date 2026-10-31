# Deep workflow research — public product surfaces

Date: 31 October 2026  
Project: Executive Visuals  
Targets: Platform A, Platform B, Platform C  
Method: REA-inspired inspection of official first-party documentation and unauthenticated public pages.

> This is independent product research, not a claim of private reverse engineering. It records observed workflows and implementation implications. It does not copy source code, private assets, hidden prompts, private APIs or model weights.

## 1. Platform A — director studio, node canvas and agent workspace

Sources:
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-canvas
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer
- [Public source ref EXT-001] A.ai/creator-hub/help-center/tools/how-do-i-use-ai-influencer
- [Public source ref EXT-001] A.ai/creator-hub/help-center/ai-models/how-do-i-create-and-use-a-soul-id-character

### Cinema Studio workflow

The public guide describes a project/shot-oriented workflow rather than a single prompt box.

- Project-wide direction includes genre, era, tempo/editing rhythm, style/color palette, lighting and camera-move style.
- Each shot can have its own camera body, lens, focal length, aperture and movement.
- References include uploaded media, prior generations and reusable character/location/prop Elements.
- The Director's Panel groups film setup, camera, color palette and lighting into one control surface.
- Modes include reference-driven generation, forward/backward extension of a source clip and regional video editing.
- AI Director can turn a script into shot-level prompts/settings, but the generated plan is presented for user review before generation.
- Elements are reusable assets. Trained characters can be selected repeatedly across scenes/projects.

**Version volatility:** Reference caps and clip durations differ by Cinema Studio version. These must be read from the selected model/version capability schema, never encoded as platform-wide constants.

**Executive Visuals implications:** Separate project direction from shot direction; make camera/lens/lighting structured fields; build an editable storyboard before paid generation; persist reusable character/location/prop records with provenance and rights/consent; make extend/edit operations create derived revisions rather than replace source media.

### Canvas workflow

The public guide documents this sequence:
1. Create a canvas and add a text/prompt node.
2. Add a generation node and select a model.
3. Connect node outputs to downstream inputs.
4. Add reference-image/audio nodes or existing assets.
5. Run nodes individually or in sequence; parallel branches can be compared.
6. Save the graph as a reusable template and collaborate on a shared board.

Reference semantics are model-specific. Some connected images act as start frames, while other models use them as references only when their role is explicitly described. Executive Visuals therefore needs provider/model-specific input contracts and validation. The guide says graph construction itself is free and credits are consumed when generation nodes run. Planning/validation should likewise be separated from execution, with cost shown before a billable node starts.

### Marketing Studio workflow

Three entry paths are documented:
- Template-first: choose a task/category template, attach a product, optionally swap avatar/hook/setting, then recreate.
- Product-link: provide a product page URL and create a social video ad from extracted product context.
- Reference-ad: provide an ad the user is allowed to use, attach their product/avatar and recreate its composition/format.
- Prompt-first remains for cases not covered by templates.

Categories include product shots, motion, UGC, TikTok, ads, posters and marketplace assets. Cost is shown before confirmation. The same avatar can be reused across variants for identity consistency.

**Design implications:** Model a campaign as brief + product source + audience/channel + template/reference + presenter identity + variant set + review/export. Require rights confirmation for reference ads and uploaded brand assets.

### Supercomputer and identity

Supercomputer is described as a chat-driven multi-step agent: propose a plan, route individual tasks to suitable models, execute, assemble outputs and accept iterative changes. It connects to external apps, files and workspace storage. Skills are reusable procedures, can be built from chat work and invoked from external agent surfaces. Costs accrue per generation step and are surfaced while the task runs.

AI Influencer is a menu-driven character builder with base identity fields and advanced Face, Body and Style groups. Characters are saved to a library, can be edited, regenerated and animated. Soul ID is a reusable identity-training layer; its guide requests 20–80 photos of one person, recommends varied recent well-lit photos and says users must have permission to use the person's likeness. It is provider-scoped, not a downloadable standalone identity file, and consistency is not guaranteed to be pixel-identical.

**Design implications:** Keep the agent plan visible/editable; route through a provider registry; preserve step outputs and rerun only affected descendants; make skills versioned and inspectable; represent identity training as a consent-gated provider-scoped asset.

## 2. Platform B — programmable avatar/video system and agent tools

Sources:
- [Public source ref EXT-002] B.com/
- [Public source ref EXT-002] B.com/docs/quick-start
- [Public source ref EXT-002] B.com/mcp/overview
- [Public source ref EXT-002] B.com/skills/overview
- [Public source ref EXT-002] B.com/docs/webhooks
- [Public source ref EXT-002] B.com/docs/usage-limits

### Integration and authentication

The public developer docs expose REST API authentication with an API key in the X-Api-Key header, and a remote MCP endpoint at [Public source ref EXT-003] B.com/mcp/v1/ using OAuth to connect an agent to a user's existing plan.

The quick start describes creating a Video Agent session, receiving a session_id, polling until a video_id is assigned, then polling the video until completed or failed. The output includes a video URL and duration. Webhooks can replace frequent polling.

Platform B Skills are a higher-level layer: skills encode task expertise/instructions, while MCP and CLI expose tools. The documented skill chain is avatar skill → reusable avatar/voice identity handoff → video skill → finished video → translate skill. This is a useful architecture pattern: durable human-readable handoff state between reusable procedures. Executive Visuals should create its own skill contracts and project state, not copy Platform B skill files or prompts.

### Public MCP tool families

The MCP overview documents:
- Video Agent: create one-shot or multi-turn sessions; list styles/sessions; send follow-up messages or scene edit plans; inspect session resources; stop at a checkpoint; list session outputs.
- Videos: list/create/get/delete videos and inspect scene structures.
- Templates: list/get/create/update/delete templates, define variables and generate from a template; scene selection can reorder or repeat existing scenes.
- Voices: list and describe voices, clone a voice, synthesize speech, inspect clone status and delete owned clones.
- Audio: search music or sound effects by natural-language description.
- Video translation: create/list/get/update/delete translation jobs and list target languages; supports voice cloning/lip-sync and speed/precision modes.
- AI clipping: submit a source video asynchronously and create short clips from spoken-dialogue highlights; silent/music-only sources are documented as unsuitable.
- Batch operations: video, translation, lip-sync and asset-upload batch workflows.
- Avatars/assets/user resources: documented catalogue and resource-management groups.

The tool catalogue is a moving target. Refresh the official MCP index and exact endpoint schemas before implementation; do not infer omitted tool fields or call unlisted endpoints.

### Async jobs, events and reliability

The documented pattern is submit work and retain a session/job ID; poll a status endpoint or register a webhook; inspect failure codes/messages; preserve partial results when an agent is stopped at a checkpoint; and use idempotency/de-duplication where supported.

Webhook docs state that deliveries are HMAC-SHA256 signatures over the raw request body. Verify before trusting, use constant-time comparison, respond 2xx quickly and de-duplicate because retries can deliver the same event again. The documented retry window is up to 24 hours with exponential backoff. A signing secret is returned on endpoint creation/rotation and must be stored securely.

### Constraints and capability metadata

Platform B publishes plan-specific concurrency, per-endpoint rate limits, input formats/sizes, script/prompt limits, output ratios, scene limits and pagination. It documents 429 responses with Retry-After and rate-limit headers. Values are endpoint/plan specific and change; Executive Visuals should load provider capability metadata and expose it in preflight, not hard-code current limits as universal rules. Respect retry headers and bounded backoff. Never put provider API keys in browser code or logs.

## 3. Platform C — media repair and ordered enhancement workflow

Sources:
- [Public source ref EXT-001] C.ai/workspace
- [Public source ref EXT-001] C.ai/ai-workflow
- [Public source ref EXT-001] C.ai/video-enhancer/upload
- [Public source ref EXT-001] C.ai/video-repair/upload
- [Public source ref EXT-001] C.ai/video-retouch/upload

### Public workflow observations

The unauthenticated workspace exposes image/video categories, recents and individual tools. The Custom Workflow page publicly lists these ordered processing steps:
1. AI Enhancer
2. Remove Watermark (Auto)
3. AI Repair
4. AI Upscaler
5. AI Retouch
6. Noise Reduction
7. Color Enhancer
8. Night View

The page states that after upload, the file is processed in order using the steps on the left. It exposes upload, drag/drop and import-from-link entry points. The public page does not expose the full signed-in editor state; step reordering/removal mechanics, detailed parameters, execution queue and output revision behavior remain unverified.

The Video Enhancer page exposes modes including HD, Ultra HD, Portrait, AI UHD, Professional, AI-Gen Visuals, Concert, Animation and Game, followed by upload/import. Video Repair describes detection/restoration and offers upload/import. Video Retouch describes beauty/retouching and offers the same file-ingestion choices. Other public catalogue entries include upscaling, watermark removal, denoise, low-light enhancement, frame interpolation, video expansion, color match/correction, conversion, compression, audio extraction, image/video generation and templates.

**Unknowns:** The unauthenticated pages do not reveal exact model parameters, backend execution, cost rules, per-file constraints, processing-time behavior or authenticated editor controls. These are not claimed as observed.

**Executive Visuals implications:** Implement enhancement as an ordered non-destructive chain. Each step needs typed media input/output, parameters, provider/version, estimated cost, status and failure details. Preserve the original and create derived assets with lineage. Provide presets (portrait, low-light, restoration, social export) plus step-level control. Include file validation and before/after comparison. Treat watermark removal as rights-sensitive and require confirmation of authorization.

## 4. Consolidated architecture lessons

| Product pattern | Public evidence | Executive Visuals response |
|---|---|---|
| Director studio | Global direction + per-shot camera/lighting + reusable scene elements | Project brief, storyboard, shot direction and reference library |
| Node canvas | Typed connected nodes, parallel branches, templates and reruns | Validated workflow graph with dependency-aware execution |
| Agent workspace | Multi-step plans, model routing, connectors, selective refinement | Inspectable AI Director plan with approval and rerun diff |
| Avatar system | Reusable presenter identity, voice, script and scene composition | Consent-gated identity/voice registry and presenter studio |
| Template campaigns | Product + template + avatar + variants | Campaign builder and batch variant review |
| Translation | Existing video to target languages with voice/lip-sync | Localization jobs with language-pair capability checks |
| Enhancement chain | Ordered repair/upscale/retouch/noise/color steps | Non-destructive media-processing pipeline |
| Async execution | Job IDs, polling, webhooks, failure states | Unified job lifecycle, signed webhook ingestion and retries |
| Agent skills | Reusable task expertise separate from tool endpoints | Versioned Executive Visuals skills and workflow templates |

## 5. Next research and implementation gates

1. Inspect linked first-party documentation and versioned API schemas before implementing adapters.
2. Inspect authenticated UI only through an account/session the user explicitly authorizes; do not bypass access controls.
3. Capture accessible UI states and interaction sequences with date/source labels.
4. Turn each workflow into an evidence table: action, input, control, state transition, output, errors, billing/cost, permissions and confidence.
5. Build original components/contracts and test independently of any one provider.
6. Keep production provider calls disabled until credentials, costs, rights, rate limits and user approval are configured.

## 6. Evidence classification

- Observed/documented: directly visible in cited first-party pages and developer docs.
- Inferred: architecture recommendations for Executive Visuals based on those workflows.
- Unknown: private UI state, private service internals, undocumented endpoints, account-specific plan settings or unexposed parameters.

A public product page is evidence of an advertised workflow, not proof of internal implementation or output quality. Revalidate provider capabilities immediately before integration.
