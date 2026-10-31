# Exhaustive public-surface audit — Higgsfield, HeyGen and Wink

**Project:** Executive Visuals  
**Audit date:** 31 October 2026  
**Scope:** Official public help centres, product pages, developer documentation, API/MCP indexes and unauthenticated public workspace pages.  
**Method:** REA-inspired evidence collection, URL inventory, workflow extraction, capability decomposition, version/limit checks and implementation mapping.

> **Scope and integrity statement:** This is not private/binary reverse engineering. It records only public first-party information and publicly visible unauthenticated surfaces. No login bypass, private endpoint probing, proprietary code/assets, hidden prompts, model weights or protected user content were accessed or copied. “Exhaustive” here means a broad inventory of the currently mapped public surfaces and their published workflows—not a claim that private/account-specific product functionality has been fully inspected.

## 0. Coverage and evidence rules

Public URL maps returned:
- Higgsfield Help Center: 112 indexed URLs.
- HeyGen Developer documentation: at least 150 URLs in the first mapped page of results; the official `llms.txt` index itself is approximately 48 KB and enumerates the developer surface.
- Wink public site: 247 URLs in the initial broad map, including localized duplicates, marketing pages, tool landing pages, model pages and blog pages. A narrower root map returned 132 URLs.

Counts are URL discovery counts, not counts of unique backend capabilities. The Wink map contains localized duplicates and editorial pages; the HeyGen docs map is capped/paginated and must not be read as a final endpoint count.

Evidence labels used throughout:
- **DOCUMENTED:** stated in an official first-party page or API reference.
- **VISIBLE:** present in a public unauthenticated page/navigation.
- **INFERRED:** engineering design conclusion drawn from documented/visible behavior.
- **UNKNOWN:** not exposed by the public sources inspected; must not be fabricated.

---

# PART I — HIGGSFIELD

## 1. Product surfaces and major capability families

The official help center groups the product into:
- Image generation: Soul, Soul 2.0, Soul Cinema, Nano Banana families, GPT Image, Seedream, Recraft, FLUX and other catalogued models.
- Video generation: Seedance, Kling, Higgsfield DoP, Wan, Grok Imagine, Sora, Veo, Minimax/Hailuo and other model families.
- Audio: Seed Audio, Eleven, Seed Speech, MiniMax Speech, VibeVoice and related voice/audio models.
- Creation workspaces: Cinema Studio, Canvas, Marketing Studio, Supercomputer and AI Influencer.
- Transformation: Genjutsu, image/video extension/editing, lip-sync, voiceover, translation and upscale.
- Reusable entities: Soul ID, Elements (characters, locations, props), assets and project references.
- Developer/agent interfaces: API, MCP, CLI + Skills, external integrations and Katana.

The important architecture distinction is **model vs tool vs workflow**:
- A model is the generation engine.
- A tool/workspace is the user-facing control surface.
- A workflow combines one or more tools/models, assets and approvals into a repeatable process.

## 2. Cinema Studio — project and shot-level directing

Official guide: https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio

### Version-specific workflow

| Version | Main use | Documented controls |
|---|---|---|
| 2.5 | AI actors and film color grading | Up to 3 Soul Cast characters; optics, motion, composition; post-generation color grade |
| 3.0 | Realism, physics-oriented movement | Up to 9 references; genre; speed ramp; camera movements |
| 3.5 | AI-assisted directing and collaboration | Project-wide visual settings plus per-shot camera; Claude Chat AI Director; Elements; shared projects |
| 4.0 | Deep cinematography controls and longer clips | Director's Panel; up to 50 references; clips up to 30 seconds; forward/backward extension and regional video edits |

### Project-wide settings
- Genre and era/tone.
- Tempo and speed-ramp/edit rhythm.
- Style and camera-move-set style.
- Lighting.
- Color palette.
- Shared visual direction for the project.

### Shot-level settings
- Camera body/type.
- Lens.
- Focal length.
- Aperture.
- Camera movement.
- Shot-specific prompt and references.

### Director's Panel
- Camera selection includes film/video camera looks (examples in the guide: 35mm film, 8mm film, DV camcorder).
- Lens choices range from clean/sharp to anamorphic and vintage looks.
- Camera movement includes named cinematic moves such as POV, robot arm and helicopter shot.
- Lighting has six presets plus a custom setup controlling color, brightness, diffusion and angle.

### Shot lifecycle
1. Create/open a project.
2. Set global visual direction.
3. Add or select references and reusable Elements.
4. Describe the story/shot or ask the AI Director to break a script into shots.
5. Review the proposed shot plan and parameters.
6. Generate the selected shot(s).
7. Inspect the result and revise individual shots.
8. Extend or regionally edit supported clips.
9. Apply post-production/color grade where available.
10. Save reusable Elements and export/continue editing.

### References and Elements
- Version 3.0 documents up to 9 references.
- Version 4.0 documents up to 50 references.
- References may include uploaded images/videos, saved Elements, past generations and liked assets.
- Elements are reusable Characters, Locations and Props. They can be reused across shots and projects; some are project-scoped/shared within team projects.
- Soul Cast actors can be saved as Elements.

### Collaboration and native audio
- Cinema Studio 3.5 documents simultaneous generation by team members in shared projects, with Elements shared within the project.
- Current versions document native audio generation (speech, effects and music) alongside video.
- Upload duration limits differ: 2.5 does not accept video uploads; 3.0/3.5 accept up to 15 seconds; 4.0 accepts up to 30 seconds.

**INFERRED for Executive Visuals:** implement a ProjectDirection object and separate ShotDirection records. A storyboard should be editable before generation. Every shot revision should preserve its prior output. Reference roles must be typed (identity, location, style, start frame, prop, etc.) because model semantics differ. Never hard-code one generation duration/reference limit across providers or model versions.

## 3. Canvas — visual node workflow

Official guide: https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-canvas

**DOCUMENTED sequence**
1. Create a canvas.
2. Add text/prompt nodes.
3. Add generation nodes and select models.
4. Connect node outputs to downstream inputs.
5. Add image/video/audio references and existing assets.
6. Execute individual nodes or a connected sequence; use parallel branches for alternatives/comparison.
7. Inspect outputs side by side.
8. Save reusable templates and collaborate on a shared board.

**Important details**
- An image connection does not have identical semantics across all models. It may be a start frame or a reference; the role can require explicit instruction.
- Graph construction/planning is distinguished from running billable generation nodes.
- Generated assets are retained in the account's Assets.

**INFERRED:** node ports must have semantic media roles, not just MIME types. Add dry-run validation, estimated cost, provider/version pinning, branch comparison, node-level retry and downstream invalidation. A failed node should not erase successful sibling outputs.

## 4. Marketing Studio and Ad Multiplier

Official guide: https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads

Documented entry patterns:
- Template-first: choose a campaign/task template, attach a product, choose/adjust presenter, hook and setting, then generate.
- Product URL: supply a product page URL and use extracted product context for a social/video ad.
- Reference-ad: use an ad the user is authorized to use, provide their product/character assets and create a new variation.
- Prompt-first: describe a custom creative when a template is not suitable.

Documented creative categories include product shots, motion, UGC, TikTok-style, ads, posters and marketplace creative. Multiple variations can reuse the same presenter identity. Cost/credits are visible before generation.

MCP docs also describe **Ad Multiplier**: use a reference ad and the user's product/character images to create versions that vary product, location, hook or CTA.

**INFERRED workflow model:** CampaignBrief → ProductSource → BrandContext → Audience/Channel → TemplateOrReference → Presenter → Hook/CTA variants → Preflight/cost → Generate → Review → Export. Preserve the original reference and record rights/authorization. Keep product facts distinct from generated marketing copy.

## 5. Supercomputer, AI Director and Apps

Official sources:
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer
- https://higgsfield.ai/creator-hub/help-center/tools/what-are-higgsfield-apps

Supercomputer is described as a chat-driven agentic workspace:
- Understand a natural-language task.
- Propose a multi-step plan.
- Route steps to suitable models/tools.
- Execute steps and assemble outputs.
- Let the user refine the plan/result.
- Connect external apps, files and workspace assets.
- Use reusable Skills and workspace memory/storage.
- Support scheduled/ongoing tasks where exposed by the product.

Higgsfield Apps lets a user describe and create a generative application within Supercomputer, customize and publish/share it. Public docs position this as a no-code app-building path.

**INFERRED:** an Executive Visuals Director should show a step graph and a human-readable execution plan before any paid action. Every step should disclose provider, inputs, output type, expected cost and permissions. Skills should be versioned procedures, not hidden prompt blobs. App generation should be isolated from production services until tested.

## 6. AI Influencer, Soul ID and character continuity

Official sources:
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-ai-influencer
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-create-and-use-a-soul-id-character

Documented concepts:
- AI Influencer builder has base identity attributes and advanced Face, Body and Style controls.
- Character profiles can be saved, edited, regenerated and animated.
- Soul ID is a reusable identity-training layer.
- The guide requests 20–80 photos of one person and recommends recent, varied, well-lit source photos.
- User must have permission to use the subject's likeness.
- Soul ID is provider-scoped and is not a standalone downloadable identity file.

**INFERRED:** identity should be a first-class consented asset with subject, rights basis, source manifest, purpose, allowed operators, retention/deletion state and provider reference. A local profile should not claim to reproduce a provider's trained weights.

## 7. Soul image family and Popcorn storyboards

Official sources:
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-soul-to-generate-images
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-popcorn

### Soul / Soul 2.0 / Soul Cinema
- Soul is the native image family for cinematic/fashion/aesthetic images and character consistency.
- Soul 2.0 adds reference-driven direction and Moodboards.
- Moodboards can be curated presets or user-created from a cohesive reference set; the guide recommends 20+ coherent images without faces for personal style boards.
- Soul HEX extracts a color palette from a reference image or uses built-in palettes; documented for Soul 2.0 and Soul Cinema.
- Soul ID supplies character identity across the Soul family.
- Documented controls include aspect ratios 9:16, 3:4, 2:3, 1:1, 4:3, 16:9, 3:2; quality 1.5k/2k; batch size 1–4; color transfer.
- When a reference image is attached in the described Soul workflows, the prompt field may become unavailable; reference and prompt modes must be represented as separate modes.

### Popcorn
- Storyboard/multi-frame image generation, with up to 8 connected frames documented.
- Auto and Manual modes.
- Supports image references and frame-to-frame continuity.
- Can be used for storyboards and edits that carry across frames.

**INFERRED:** create a Storyboard entity with ordered frame cards, shared continuity context, per-frame overrides and linked source references. Make storyboard-to-video an explicit next action, not an assumption.

## 8. DoP, Genjutsu, lipsync and audio

Official sources:
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-dop
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-genjutsu
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-lipsync-voiceover-and-aspect-ratios

### DoP
- Image/keyframe-to-video workflow.
- Cinematic camera movement and VFX presets.
- Camera motion is a first-class control, not merely prompt text.

### Genjutsu
- Video reconstruction/editing while retaining the original filmed motion.
- Public guide documents Motion Transfer, Object Swap and Restyle modes, plus Genjutsu Lite.
- Intended workflow: provide source video and replacement/reference assets, select the transformation mode, direct the desired change, generate and review the modified clip.
- Exact per-mode parameters and model constraints are version-specific and should be read from the active tool, not inferred.

### Lipsync / Voiceover / Translation
- Audio and video can be combined in a generation workflow.
- Lip-sync, voiceover and translation are separate capabilities and may be exposed as model/tool-specific options.
- Aspect ratio controls are part of the output workflow.
- Some video models create native audio as part of the generation pass; standalone audio models are not necessarily present in the API catalog.

## 9. Higgsfield API vs MCP vs CLI + Skills

Official sources:
- https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api
- https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp
- https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-access-higgsfield-via-cli
- https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent
- https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-use-katana

| Surface | Auth/account | Billing | Best fit |
|---|---|---|---|
| Web app | User session | Subscription/credits; some plan entitlements | Human creative work |
| MCP | OAuth to existing account | Standard credits for every automated generation | Chat agents |
| CLI + Skills | Authenticated Higgsfield account | Standard credits | Coding agents and repeatable skill calls |
| API | Separate developer account and API key | USD prepaid/pay-as-you-go | Product integrations and production pipelines |

### API facts documented by Higgsfield
- One API key covers the current API catalog (the help page advertises 50+ image/video models).
- Separate from the website subscription and plan credits.
- REST API plus Python and TypeScript SDKs.
- 20 concurrent requests when creating an API key (as stated in the help page).
- Asynchronous request ID; poll status or receive webhook.
- An estimate endpoint provides request cost before execution.
- Pay per generated image or video second/configuration; model-specific prices.
- Minimum top-up $5; funds expire one year after adding.
- Only successful generations are charged; failed generation cost is returned.
- Generated output files remain available for at least 7 days; download to durable storage.
- Team organizations are supported.
- The model catalog has per-model resolution, duration, rates and sample code.

### MCP facts
- Connector URL: https://mcp.higgsfield.ai/mcp
- OAuth, no separate API key.
- Uses existing account and credits.
- Unlimited web entitlements/free generations do not apply to automated MCP/CLI/Canvas/Supercomputer generation.
- Outputs appear in Assets tagged with MCP source.
- Published operations include image/video generation, Marketing Studio, Ad Multiplier, Genjutsu, Soul character training/reuse, audio, credit balance and Asset Library.
- User is responsible for the actions an authorized agent takes with their account.

### CLI + Skills facts
- Install package documented as `npm i -g @higgsfield/cli`.
- Skills package documented as `npx skills add higgsfield-ai/skills`.
- Login with `higgsfield auth login`.
- Documented skill names: `generate`, `soul`, `product-photoshoot`.
- Product-photo presets include product_shot, lifestyle_scene, closeup_product_with_person, pinterest_pin, hero_banner, social_carousel, ad_creative_pack, virtual_model_tryout, conceptual_product and restyle.
- Video presets include UGC, Tutorial, Unboxing, Hyper Motion, Product Review, TV Spot, Wild Card, UGC Virtual Try On and Pro Virtual Try On.
- CLI + Skills is optimized for coding agents and structured output; MCP is a broader tool connection with free parameter selection.
- CLI skills and Supercomputer skills are distinct systems.

### Katana
- Public help page describes reference-video edit recreation through Higgsfield MCP in Claude.
- The workflow uses an authorized reference video plus the user's own characters, products or clothing, then adapts the edit to the new subjects.
- Presets/uploads/credits are part of the public guide.
- The exact authenticated editor internals and hidden model parameters are not public.

## 10. Assets, community, credits, ownership and safety

- Generated outputs appear in the Assets library and can be reused as references.
- Usage history records deductions/refunds, model and timestamp.
- Batch size charges each output separately.
- Automated generation through MCP/CLI/Canvas/Supercomputer uses standard credits even where website Unlimited access exists.
- Public docs explain subscription reset, credit pack expiry and concurrency add-ons; these are commercial-plan mechanics, not media-engine behavior.
- Public Community features include creator profiles, Open Projects, remixing, sharing, ratings, achievements, contests and grants.
- Public ownership guidance says users retain output ownership and commercial-use rights under the cited Terms of Use, while the service has a limited license and may use content for model training unless Enterprise terms apply. User remains responsible for third-party copyright/trademark/likeness rights; outputs cannot be used to train competing AI models under the cited terms.
- Public safety/troubleshooting docs cover NSFW/copyright flags, failed jobs and refunds, account privacy/data requests and deletion.

**INFERRED:** keep an immutable usage ledger, per-node cost preflight, consent and rights manifests, user-controlled retention/deletion, moderation/error states and durable download/writeback.

---

# PART II — HEYGEN

## 11. Product and developer surfaces

Primary index: https://developers.heygen.com/llms.txt  
MCP index: https://developers.heygen.com/mcp/overview  
REST reference: https://developers.heygen.com/docs/quick-start  
Public product site: https://www.heygen.com/

The developer index is extensive and includes API reference, MCP, Skills, CLI, models, guides, examples, webhooks, batch APIs, rendering, avatar workflows, voices, translation and changelog. It should be re-read before implementing each adapter because identifiers and constraints evolve.

## 12. Authentication and integration choices

Documented integration paths:
- API key in the `X-Api-Key` header for direct REST calls.
- OAuth remote MCP at `https://mcp.heygen.com/mcp/v1/`, connected to the user's HeyGen workspace and plan credits.
- CLI/official Skills for coding-agent workflows.
- Official SDK/docs and webhooks for production automation.

The current developer onboarding index recommends API key first for repeatable/production pipelines; OAuth/MCP is positioned for trial-scale user-authorized agent use. Never ask users to paste secrets into chat; use secure secret storage and server-side calls.

## 13. Avatar data model and creation

Official sources:
- https://developers.heygen.com/docs/create-avatar
- https://developers.heygen.com/docs/avatar-from-video
- https://developers.heygen.com/docs/avatar-from-photo
- https://developers.heygen.com/docs/avatar-from-prompt
- https://developers.heygen.com/docs/avatars
- https://developers.heygen.com/avatar-iv

### Character vs look
- A **character/avatar group** is the identity container.
- A **look/avatar item** is a particular outfit, pose, style or renderable representation.
- The look ID is passed as `avatar_id` when generating a video.
- One character may own multiple looks and a default voice.
- Each look advertises supported rendering engines and preferred orientation.

### Four creation paths
1. Video footage → digital twin, potentially with voice cloned from the recording.
2. One photo → photo avatar.
3. Text prompt → synthetic avatar.
4. Existing character → new outfit/setting/style look, either prompt-generated or via Look Pack.

Creation is asynchronous. Look and group statuses are distinct:
- Look status tracks processing/training/moderation.
- Group consent status tracks consent approval.
- The look can be completed while the group still has a consent state to resolve; check both.

### Photo avatar
- Single still image.
- Can use public URL, uploaded asset ID or base64 input.
- Poll look status; completion includes preview URL and supported engines.
- Photo avatars may not have a platform-collected consent record. The user remains responsible for obtaining and retaining subject permission.

### Prompt avatar / new look
- Prompt length documented up to 1,000 characters.
- Aspect ratios documented: 16:9, 9:16, 1:1, 4:5, 5:4 or auto.
- For a new synthetic character, no real person is depicted and no likeness-consent step applies.
- For an existing avatar, prompt can create a new look while conditioning on the selected look to preserve identity.

### Avatar IV
- Supported avatar types: studio_avatar, digital_twin, photo_avatar, arbitrary image and prompt.
- `motion_prompt` directs body motion/hand gestures for photo avatars and arbitrary images.
- `expressiveness` supports high/medium/low for photo avatars and arbitrary images.
- Arbitrary images can be animated without a registered avatar.
- Rendering is asynchronous and returns a video ID.

### Consent
- Digital twin/private avatar flows have an explicit consent process.
- Public MCP documentation describes a consent URL that the subject opens in their browser; link expires after 24 hours and accepts one submission.
- Consent and moderation are separate from training completion.

**INFERRED:** model identities and look assets separately. Keep a local consent record even if a provider omits consent capture. Do not make an identity available for every workspace by default; require explicit scope and revocation handling.

## 14. Video creation and Video Agent

Official sources:
- https://developers.heygen.com/docs/video-agent
- https://developers.heygen.com/docs/interactive-sessions
- https://developers.heygen.com/docs/edit-scenes
- https://developers.heygen.com/docs/models/heygen-video

### Video Agent modes
- `generate`: one-shot prompt-to-video, fire-and-forget.
- `chat`: multi-turn session that pauses at checkpoints for user review and direction.

The agent can plan script, choose avatar, compose scenes and render. Optional fields include avatar, voice, visual style, brand kit and brand glossary. Styles are searchable/filterable by tags.

### Interactive lifecycle
1. Create a session in chat mode.
2. Poll/get session state and agent messages.
3. Agent may pause in `waiting_for_input` or `reviewing`.
4. User reviews storyboard and sends feedback or approval.
5. Session enters `generating`.
6. Retrieve completed video and session outputs.

Documented states include thinking, waiting_for_input, reviewing, generating, completed and failed. A stop operation halts at the next checkpoint and preserves partial results.

### Scene-level revision
- Read completed video's scenes; response contains ordered scene IDs, scripts, backgrounds, elements and an edit_version.
- Send an edit_plan containing the scene ID, change instruction, source snapshot video ID and edit_version.
- Only named scenes are changed; other scenes preserve script/visuals/pacing.
- Poll the new draft video ID directly; session video_id can remain null during edit.
- Session can list every cut/version it has produced.
- A scene document may return 409 resource_not_ready while still being prepared.
- Edit version is not a hard document lock; concurrent edits may both be accepted.

**INFERRED:** build immutable cuts/revisions, scene IDs and edit plans; track parent revision, changed scenes, approval, output and provenance. Never re-render unaffected scenes when a provider supports scoped edits.

## 15. HeyGen Video model vs avatar rendering

These are different product families:
- Avatar rendering animates an existing look from a script/audio and voice.
- HeyGen Video generates a complete scene (subject, setting, light, sound) from prompt/reference.

HeyGen Video documented modes:
- Text-to-video: prompt → new scene with sound.
- Image-to-video: prompt + one image → clip begins on that image as first frame.
- Reference-to-video: prompt + reference images/videos/audio → new scene preserving supplied products/people/places.
- Model identifier: `heygen-video-1`.
- Documented compatible text/image clips can reach 30 seconds; reference-to-video is 5–15 seconds.
- MCP tool path has a narrower 5–15 second duration limit for this model; HTTP API supports longer compatible settings. This is a concrete example of why capability must be scoped by interface, model and plan.

## 16. Templates, brand kits and brand glossary

Official sources:
- https://developers.heygen.com/create-template
- https://developers.heygen.com/docs/brand-kits
- https://developers.heygen.com/docs/brand-glossary
- https://developers.heygen.com/docs/on-brand

### Templates
- Templates are edited in the web editor; API lists API-ready templates with variables.
- A template can be created from a supported video and contains scenes/media/avatar/script.
- Variables bind text/media/character/voice to scene elements.
- Variable schema can be set/updated.
- Generate from template by filling variables; scene IDs can select, reorder or repeat existing scenes.
- Idempotency key prevents duplicate generation when supported.
- Some legacy/editor formats are not API-supported; check template version.

### Brand kit
- Stores colors, fonts and logos.
- Can be imported from a public website or authored in the app.
- Video Agent applies kit to scene backgrounds, text, chart palettes and logo placement.
- API-created kits remain editable in the app.
- Importing assets requires the caller to confirm rights.
- Kit creation is asynchronous; roles include color, logo and heading/body fonts.

### Brand glossary
- Stores custom terms and pronunciations.
- Supports do-not-translate and forced-translation rules.
- Pronunciation rules affect generated audio; translation rules affect localization.
- Language-specific rules can override all-language rules.
- Glossary can be used with Video Agent, script-driven videos, templates and translation.
- Conflict/duplicate validation and concurrent-edit errors are documented.

## 17. Voices, speech, audio and lip-sync

Official sources:
- https://developers.heygen.com/docs/voices/heygen-voice-instant-clone
- https://developers.heygen.com/docs/voices/professional-voice-clone
- https://developers.heygen.com/docs/voices/heygen-voice-speech
- https://developers.heygen.com/lipsync-speed
- https://developers.heygen.com/lipsync-precision

Documented functions:
- Browse/filter public and workspace voices by language, gender, engine/type.
- Design/select voices from natural-language descriptions.
- Clone voice from audio; poll clone status.
- Professional voice cloning and instant voice cloning have different training/slot/usage constraints.
- Text-to-speech returns audio URL/duration and may include word timestamps.
- Speech can be streamed via Server-Sent Events.
- Speech engines include HeyGen Voice, Starfish and supported ElevenLabs models; vendor access may be restricted by workspace policy.
- Speech endpoints document per-member rate limits and language/engine compatibility errors.
- Lip-sync takes source video + replacement audio, then redraws mouth movement; Speed and Precision trade latency for fidelity.
- Lip-sync is distinct from translation: lip-sync uses supplied audio; translation transcribes/translates/generates audio and can optionally add lip-sync.
- Audio-only translation can produce replacement audio without mouth animation.

## 18. Translation, proofread, subtitles and localization

Official sources:
- https://developers.heygen.com/docs/video-translate
- https://developers.heygen.com/reference/create-proofread-session
- https://developers.heygen.com/docs/brand-glossary

Documented translation workflow:
1. Query supported target language codes.
2. Submit source video and target language(s).
3. Select speed or precision mode.
4. Optionally set voice cloning, lip-sync, speaker number, subtitle/SRT, speech enhancement, music handling, video stretching and brand glossary.
5. Poll or receive webhook.
6. Retrieve localized video/audio and failure details.
7. Proofread/edit translation where supported before generating final outputs.

Proofread sessions support video, output languages, brand voice/glossary, speaker number, SRT, speed mode, keep-format option, speech enhancement, disable music track and video stretching. Exact options depend on endpoint schema and current model.

## 19. AI clipping and filler-word removal

Official sources:
- https://developers.heygen.com/reference/create-ai-clipping
- https://developers.heygen.com/filler-word-removal

### AI clipping
- Submit source video and optional input language.
- Set duration bands, output aspect ratio, captions, caption style and prompt.
- Job is asynchronous and can produce multiple short clips.
- Highlights are based on spoken dialogue; silent/music-only videos are unsuitable.
- Job status and output clip URLs are retrievable; webhook callbacks are supported.

### Filler-word removal
- Submit a video with speech track.
- Asynchronous job cuts filler words and long silences.
- Returns cleaned video and removal statistics.
- Supports callback URL and idempotency key.
- Documented billing is per source minute with a minimum charge; verify current price before any live call.
- If nothing changes, the docs describe automatic refund behavior.

## 20. Hyperframes — programmable video composition and rendering

Official sources:
- https://developers.heygen.com/hyperframes-overview
- https://developers.heygen.com/hyperframes

Hyperframes is an HTML/CSS/JS composition rendered as video:
- HTML is the scene/timeline representation.
- CSS/JS/GSAP/WebGL can produce motion graphics and transitions.
- Composition is packaged as a ZIP with a root `index.html` or configured composition entry.
- Runtime variables parameterize one composition for many videos.
- A cloud rendering flow uploads a bundle, submits render, then polls or receives webhook.
- CLI can package, upload, submit, poll and download.
- Public docs advertise 150+ reusable blocks/components for charts, lower thirds, cards, code animations, device mockups, transitions and shaders.
- A deterministic rendering model is a stated design goal; validate actual rendering determinism with tests.

**INFERRED:** Executive Visuals should separate the visual timeline/composition engine from AI video generation. This provides reliable typography, charts, lower-thirds, data visualizations and repeatable brand variants without depending on generative-video consistency.

## 21. HeyGen MCP — documented tool groups

Official index: https://developers.heygen.com/mcp/overview

The public MCP catalogue includes the following groups. Tool names are preserved as published; schemas must be refreshed before implementation.

- **Video Agent:** list/create sessions, list styles, get session, send message/revision/edit plan, get session resource, stop session, list session videos.
- **Videos:** list/create/get/delete videos, retrieve scene documents.
- **Templates:** list/create/get/update/delete templates, set template variables, generate from template.
- **Voices:** list/design/clone/get/delete voices, create speech.
- **Audio:** search audio/music/sound-effect catalogue.
- **Video Translate:** list languages/jobs, create/get/update/delete translations.
- **AI Clipping:** list/create/get/delete clipping jobs.
- **Batches:** create/get video batch; bulk status reads.
- **Video Translation Batches:** create/get batch; bulk translation statuses.
- **Lipsync Batches:** create/get batch; bulk lip-sync statuses.
- **Asset Batches:** create presigned asset upload batch, complete batch, get batch and bulk status reads.
- **User:** get current user/profile and billing/credit details.
- **Avatars:** list groups/looks/templates, create avatar/looks, get/update/delete look/group, create consent.
- **Assets:** list/create upload/get/delete/complete asset.
- **Folders:** create/get folder.
- **Lipsync:** list/create/get/update/delete lip-sync jobs.
- **Brand:** list/create/get/update/delete brand kits and glossaries.
- **Models:** convert model speech, generate model speech, list/create/get/delete model voices, create/get image generation, create/get model video.
- **Filler Word Removal:** create/get filler-word removal jobs.

### Batch semantics
- Video, translation and lip-sync batches document up to 100 payloads per request.
- Items run independently and have queued/processing/completed/failed states.
- Bulk status endpoints support up to 100 IDs in one request.
- Asset batch upload uses presigned URLs; upload each file, then finalize the batch.
- Idempotency keys are documented for retry-safe batch operations.

### Reliability and webhook semantics
- Jobs are asynchronous; keep job IDs and poll or subscribe to events.
- Webhook payload signatures use HMAC-SHA256 over raw body.
- Verify signatures using constant-time comparison before trusting payload.
- Respond 2xx quickly; process asynchronously and deduplicate event IDs/deliveries.
- Retry behavior and event families are documented; read the latest docs before coding.
- 429 rate-limit errors may carry Retry-After; respect it and use bounded backoff.
- Do not treat presigned URLs as permanent; refresh/retrieve output when needed.

## 22. Usage limits and API constraints

Official page: https://developers.heygen.com/docs/usage-limits

The published limits are plan- and endpoint-specific and include:
- Concurrent workflow capacity by plan, with Enterprise burst behavior.
- Video, image and audio input format/file size/resolution requirements.
- Script/prompt length limits.
- Output duration/resolution/ratio constraints.
- Per-endpoint request rate limits and 429 Retry-After behavior.
- Pagination and batch-size constraints.

Examples visible in the current public docs include video generation input MP4/WebM up to 100 MB and below 2K; image JPG/PNG up to 50 MB and below 2K; audio WAV/MP3 up to 50 MB. These are endpoint-specific input constraints, not global Executive Visuals limits. URLs must be publicly accessible where URL input is used; file extension must match actual content. Always read current schema/limit pages before submitting a real job.

---

# PART III — WINK

## 23. Public surfaces and platform split

Sources:
- https://wink.ai/
- https://wink.ai/workspace
- https://wink.ai/ai-workflow
- https://wink.ai/pricing
- https://wink.ai/download-guidance

Wink publicly presents itself as an AI video and image enhancement/editing product across web, desktop, mobile and a Premiere Pro plug-in. Public pages describe a broad tool catalogue, but the actual feature set and controls differ by platform and plan. The unauthenticated workspace shell exposes navigation and upload entry points; signed-in workspace state was not accessed.

## 24. Workspace tool directory — public navigation inventory

Public upload/tool pages list these groups:
- Video Enhancer
- Video Watermark Remover
- Image to Video
- Template to Video
- Video Repair
- Video Upscaler
- Text to Video
- AI Video Expansion
- Video Retouch
- Video Converter
- Video Compressor
- Audio Extractor
- Video Color Matching
- Video Denoiser
- AI Anime
- Video Color Correction
- AI Frame Interpolation
- Low-Light Video Enhancer

Other public site pages/catalogue entries include object removal, video clearer, unpixelate video, portrait retouch, image enhancement/restoration, image generators, AI talking photo, text-to-video, animal video and social/marketing creative tools. The 247-URL broad map includes many localized duplicates, editorial content and landing pages; it is not a count of unique tools.

## 25. Custom AI Workflow — ordered enhancement chain

Official page: https://wink.ai/ai-workflow

Publicly visible chain:
1. AI Enhancer
2. Remove Watermark (Auto)
3. AI Repair
4. AI Upscaler
5. AI Retouch
6. Noise Reduction
7. Color Enhancer
8. Night View

Page text states that after upload the file is processed in order using the steps shown. Inputs include upload/drag-drop and Import from Link.

**VISIBLE but not fully inspectable:** the page exposes keyboard-accessible draggable-item guidance, which indicates draggable items in the interface. The public scrape does not reveal authenticated state, exact save/execute controls, individual parameter forms, cost per step or output lineage. Reordering appears consistent with the drag affordance, but must be confirmed in an authorized live UI session.

**INFERRED:** represent this as a typed sequential pipeline with explicit order, enable/disable per stage, stage parameters, progress, per-stage result and retry. Preserve source media and every intermediate result. A pipeline must not silently include a watermark-removal stage; make it opt-in, rights-gated and disabled by default.

## 26. Video Enhancer and scenario selection

Official pages:
- https://wink.ai/video-enhancer
- https://wink.ai/video-enhancer/upload

Public upload UI labels:
- HD
- Ultra HD
- Portrait
- AI UHD
- Professional
- AI-Gen Visuals
- Concert
- Animation
- Game

Marketing page also describes Regular and Scenario sections, batch upload/folder upload, social-link import (TikTok/Instagram), intensity adjustment, real-time preview and Save/export. The landing page distinguishes portrait, scenery, concert and game scene use cases. Public page claims support for MP4, MOV and more; do not infer the complete format list.

**INFERRED:** scene preset is a model/profile selector; intensity is a user parameter. Keep model profile, intensity and output resolution separate in our own contract.

## 27. Video Repair, clarity and unpixelation

Official sources:
- https://wink.ai/ai-video-repair
- https://wink.ai/video-repair/upload
- https://wink.ai/video-clearer
- https://wink.ai/unpixelate-video

Documented target defects:
- Exposure/lighting problems.
- Noise.
- Blur and lack of sharpness.
- Shake/jitter.
- Resolution loss and pixelation.
- Color/contrast issues.
- Frame-to-frame inconsistency.

Public repair workflow:
1. Upload source video.
2. Select/run repair mode.
3. AI scans and repairs multiple issues.
4. Preview result in Recent Tasks.
5. Save/download output.

Unpixelate workflow routes through Video Enhancer, offers HD/Ultra HD/Portrait/AI UHD or scene models (game, concert, animation, AI-generated visuals), and then preview/download. The public page claims upscaling to 4K; a separate dedicated Video Upscaler page advertises 1080P, 2K, 4K and 8K tiers. Treat each as separate published capability/page, not one guaranteed mode for every input.

## 28. Upscaling and frame interpolation

Official sources:
- https://wink.ai/video-upscaler/upload
- https://wink.ai/video-frame-interpolation

### Upscaler
- Public upload page exposes resolution tiers: 1080P HD, 2K UHD, 4K Ultimate, 8K Master.
- Inputs include upload and import-from-link.
- The public page does not disclose codec/bitrate controls or per-tier file constraints.

### Frame interpolation
- Upload video or batch-upload/folder.
- Select target frame rate or slow-motion speed.
- Select Medium or High interpolation mode (documented in the page FAQ).
- Adjust interpolation intensity.
- Preview then Export.
- Public page says it can increase 30fps to 60fps+; exact maximum is not specified.
- FAQ states output file size may increase with frame count/resolution/duration and mild stabilization may be applied.

## 29. Object removal, watermark/text removal and rights

Official sources:
- https://wink.ai/remove-object-from-video
- https://wink.ai/video-watermark-remover/upload

### Object removal
- Upload video/photo.
- Select Mark removal mode and paint over unwanted object with brush.
- System detects/tracks object and reconstructs background across frames.
- Preview and download.
- Public description claims frame-by-frame reconstruction, tracking and background fill matching color/texture/lighting/motion.

### Watermark/text removal UI labels
- Mark removal
- Remove Text (Auto)
- Remove Text (Manual)

**Safety/legal design rule:** watermark-removal functionality can be used to remove ownership/attribution marks from third-party works. Executive Visuals must not offer removal of another party's copyright/trademark/ownership watermark. A rights-holder-only workflow may be considered with explicit rights attestation and audit; the feature should remain disabled unless authorization is established. Object removal should not be marketed as a method to evade attribution or conceal provenance.

## 30. Retouch and portrait workflows

Official sources:
- https://wink.ai/video-retouch/upload
- https://wink.ai/

Public homepage describes:
- Auto-Retouch.
- Partial Retouch for fine control over skin and facial detail.
- Individual Retouch, detecting and treating faces separately.
- Retouch in Clips, allowing different styles across clip segments.
- Face/portrait enhancement and body shaping are also advertised.

The upload page itself exposes only the tool title and upload/import entry; exact slider names, values and face/body parameters are not public in the unauthenticated page. Do not invent them.

**INFERRED:** build retouch as consent-aware, reversible per-face/per-segment adjustments with intensity controls only when verified in a real authorized UI session.

## 31. Color matching, denoise, low-light, conversion, compression and audio extraction

Public workspace catalogue includes:
- Video Color Matching (batch adjustment).
- Video Color Correction.
- Video Denoiser.
- Low-Light Video Enhancer.
- Video Converter.
- Video Compressor.
- Audio Extractor.

Color Match upload page shows batch upload and import-from-link; detailed matching controls/reference semantics are not visible in the public page scrape. Other pages are tool entry points rather than full editor documentation.

**INFERRED:** treat each as a separate typed media operation with explicit inputs/outputs, format metadata, processing parameters and quality preview. Do not assume a color-match page exposes reference-based color transfer unless the UI confirms it.

## 32. Image/video generation and templates

Public site includes:
- Text-to-video: prompt, model, duration and aspect ratio; generates and downloads.
- Image-to-video: reference image + scene/action direction + model/duration/aspect ratio; preview in Recent and export.
- Template-to-video and AI video expansion.
- AI Anime/style conversion and a range of image-generation pages (product mockups, profile images, invitations, stickers, art styles, etc.).
- Animal video generator describes text or image reference, model selection, motion/framing/style/format and refinement via enhancer/upscaler/repair.

These are public product/SEO landing pages, not complete authenticated editor specifications. Confirm active model availability and controls in the actual product before building provider adapters.

## 33. File ingestion, batch, Recent and export

Public surfaces repeatedly expose:
- Upload.
- Drag/drop.
- Import from Link.
- Batch Upload and folder upload on selected tools.
- Recent/Recent Tasks for reviewing outputs.
- Preview before Save/Export/Download.
- Supported common formats on some pages (e.g. MP4/MOV; object removal page mentions MP4/MOV/AVI and more).

Unknown publicly: exact max file size/duration, signed URL lifetime, queue concurrency, storage retention, exact output codec/bitrate, account-specific quotas and internal worker topology.

## 34. Plans and credit economy

Official page: https://wink.ai/pricing

The current public web pricing page documents:
- Free: basic models, limited AI generations with credits, exports include watermark.
- Standard: 1,000 credits/month, web-only, premium models, priority generation, no watermark.
- Pro: 4,000 credits/month, web-only, premium models, priority generation, no watermark.
- Monthly credits valid for 31 days.
- Credit cost varies by feature and processing tier and is shown before a task starts.
- If balance is insufficient, user is prompted to upgrade or add credits.
- Add-on availability depends on subscription state.

Do not treat these web plans as equivalent to mobile/desktop entitlements.

---

# PART IV — CROSS-PRODUCT SYSTEM MODEL FOR EXECUTIVE VISUALS

## 35. Unified domain model

| Domain object | Required responsibilities |
|---|---|
| Workspace / Organization | Members, roles, teams, quotas, provider connections |
| Project | Brief, purpose, status, brand, collaborators, rights context |
| Creative brief | Audience, message, tone, platform, format, constraints, acceptance criteria |
| Story / Script | Narrative beats, dialogue, narration, language, revision history |
| Storyboard | Ordered scenes/shots, references, timing, camera, lighting, transitions |
| Character / Identity | Synthetic or real-person identity, source assets, consent, allowed use, revocation |
| Look / Wardrobe | Character variant, outfit, environment, orientation, provider compatibility |
| Voice | Voice source, clone state, consent, locale, speech settings |
| Brand kit | Logos, colors, fonts, layout rules, safe zones |
| Brand glossary | Pronunciation, translation rules, approved terminology |
| Asset | Original/derived media, metadata, checksum, source, rights, retention |
| Workflow graph | Nodes, typed ports, edges, dependency order, version |
| Workflow run | Inputs, provider, model version, cost estimate, approvals, execution |
| Job | Async state, progress, retries, error, cancellation, callback |
| Revision / Cut | Immutable version, parent, changed scenes, preview, export |
| Campaign | Product, channel, audience, templates, hooks, variants, approval |
| Enhancement chain | Ordered processing stages, parameters, stage outputs, comparison |
| Export | Resolution, ratio, codec, subtitles, audio mix, watermark policy |
| Usage ledger | Estimate, charge, refund, provider request ID, cost attribution |
| Consent / Rights record | Subject authorization, source rights, scope, expiry, revocation evidence |

## 36. Unified job state machine

Recommended states:
`draft → validated → awaiting_approval → queued → submitted → processing → reviewing → completed`

Terminal/exception states:
`failed`, `cancelled`, `expired`, `blocked`, `needs_input`, `partial`.

Required job metadata:
- Internal job ID and provider request/session ID.
- Workspace/project/user.
- Provider/model/version/interface.
- Immutable input manifest and content hashes.
- Capability and schema version.
- Cost estimate, approval and final charge/refund.
- Retry count, idempotency key and callback event IDs.
- Status timestamps and progress.
- Output asset IDs, download expiry and durable-storage confirmation.
- Structured failure code/message and safe retry guidance.

## 37. Cross-product design principles

1. **Separate plan from execution.** AI Director may propose a plan; user reviews it before billable generation.
2. **Capabilities are versioned.** Provider, model, interface, plan and region can change constraints.
3. **Use typed references.** Identity, style, location, product, start frame and audio references are not interchangeable.
4. **Keep originals immutable.** Edits create new assets/revisions with lineage.
5. **Make all async work observable.** Job state, progress, cost, retry, failure and outputs are visible.
6. **Use idempotency and signed webhooks.** Polling is fallback, not the only execution design.
7. **Persist outside temporary provider storage.** Download and verify outputs before provider URLs expire.
8. **Treat identity and brand as governed assets.** Consent, rights, scope, revocation and access controls are first-class.
9. **Preserve human approvals.** Especially for likeness, publishing, paid calls, external connectors and irreversible deletion.
10. **Do not reproduce provider-specific quirks as universal product rules.** Normalize them behind adapters and capability schemas.

## 38. Proposed original Executive Visuals workspaces

1. **Director:** brief-to-plan, story/script, shot list, AI Director review.
2. **Storyboard:** frame/scene continuity, camera, lens, lighting, reference roles.
3. **Presenter Studio:** synthetic characters, consented likeness, looks, wardrobe, voice.
4. **Image Lab:** generation, references, editing, style boards, color transfer, upscale.
5. **Video Lab:** text/image/reference-to-video, motion, extension, scene edits.
6. **Cinema Studio:** multi-shot project, camera rigs, shot continuity, native audio.
7. **Voice & Localization:** TTS, voice cloning, dubbing, lip-sync, translation, captions, glossary.
8. **Enhancement Lab:** ordered repair/upscale/retouch/denoise/color/interpolation pipeline.
9. **Campaign Studio:** product ingestion, ads, UGC, templates, variants, brand consistency.
10. **Motion Graphics & Timeline:** deterministic HTML/CSS/JS composition, scenes, captions, charts, audio and render.
11. **Workflow Canvas:** typed graph, parallel branches, validation, dry-run, approval, reusable templates.
12. **Agent & Skills:** reusable task procedures, tool routing, connected apps and scheduled jobs.
13. **Assets & Projects:** versions, metadata, provenance, durable storage and collaboration.
14. **Operations:** provider health, usage, cost, queue, failures, retries, audit and security.

## 39. Verification backlog — do not claim these as completed

### Requires authorized authenticated product access
- Exact Higgsfield Cinema Studio editor states for each version.
- Actual Canvas node catalog, ports, connection rules, graph persistence and rerun semantics.
- Supercomputer plan editing, skills management, connectors and scheduled tasks.
- Katana UI and its actual reference-video edit controls.
- HeyGen signed-in Studio scene editor, avatar creation UX, translation proofreading and template editor.
- Wink signed-in workflow builder: add/remove/reorder steps, per-stage settings, run controls, progress, Recent, export options and batch management.
- Cross-device differences among Wink Web, desktop, mobile and Premiere plugin.

### Requires schema/API verification
- Current Higgsfield API OpenAPI model catalogue and exact request schemas.
- Current HeyGen API OpenAPI schema, event payloads, pagination, error codes and all endpoint-level limits.
- Any public Wink API/SDK (none established by the pages inspected).
- Current provider pricing, quotas and retention policies before live integrations.

### Requires hands-on output testing
- Identity consistency across shot changes and camera angles.
- Audio/lip-sync synchronization and language quality.
- Scene edits preserving untouched content.
- Upscale/repair artifact rate and temporal consistency.
- Color matching and skin-retouch quality.
- Deterministic motion-graphics render reproducibility.
- Failure recovery, webhook duplication, cancellation and output URL expiry.

## 40. Source register

### Higgsfield
- https://higgsfield.ai/creator-hub/help-center/getting-started/what-is-higgsfield
- https://higgsfield.ai/creator-hub/help-center/tools/which-higgsfield-tool-should-i-use
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-canvas
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer
- https://higgsfield.ai/creator-hub/help-center/tools/what-are-higgsfield-apps
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-ai-influencer
- https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-genjutsu
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-popcorn
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-dop
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-soul-to-generate-images
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-create-and-use-a-soul-id-character
- https://higgsfield.ai/creator-hub/help-center/ai-models/how-do-i-use-lipsync-voiceover-and-aspect-ratios
- https://higgsfield.ai/creator-hub/help-center/ai-models/which-ai-model-should-i-use
- https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api
- https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp
- https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-access-higgsfield-via-cli
- https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent
- https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-use-katana
- https://higgsfield.ai/creator-hub/help-center/account/who-owns-my-generations-and-can-i-use-them-commercially
- https://higgsfield.ai/creator-hub/help-center/credits/what-uses-my-credits

### HeyGen
- https://developers.heygen.com/llms.txt
- https://developers.heygen.com/mcp/overview
- https://developers.heygen.com/docs/quick-start
- https://developers.heygen.com/docs/usage-limits
- https://developers.heygen.com/docs/create-avatar
- https://developers.heygen.com/docs/avatar-from-video
- https://developers.heygen.com/docs/avatar-from-photo
- https://developers.heygen.com/docs/avatar-from-prompt
- https://developers.heygen.com/avatar-iv
- https://developers.heygen.com/docs/video-agent
- https://developers.heygen.com/docs/interactive-sessions
- https://developers.heygen.com/docs/edit-scenes
- https://developers.heygen.com/docs/models/heygen-video
- https://developers.heygen.com/create-template
- https://developers.heygen.com/docs/brand-kits
- https://developers.heygen.com/docs/brand-glossary
- https://developers.heygen.com/docs/on-brand
- https://developers.heygen.com/docs/voices/heygen-voice-instant-clone
- https://developers.heygen.com/docs/voices/professional-voice-clone
- https://developers.heygen.com/docs/voices/heygen-voice-speech
- https://developers.heygen.com/lipsync-speed
- https://developers.heygen.com/lipsync-precision
- https://developers.heygen.com/docs/video-translate
- https://developers.heygen.com/reference/create-proofread-session
- https://developers.heygen.com/reference/create-ai-clipping
- https://developers.heygen.com/filler-word-removal
- https://developers.heygen.com/hyperframes-overview
- https://developers.heygen.com/hyperframes

### Wink
- https://wink.ai/
- https://wink.ai/workspace
- https://wink.ai/ai-workflow
- https://wink.ai/pricing
- https://wink.ai/video-enhancer
- https://wink.ai/video-enhancer/upload
- https://wink.ai/ai-video-repair
- https://wink.ai/video-repair/upload
- https://wink.ai/video-clearer
- https://wink.ai/unpixelate-video
- https://wink.ai/video-upscaler/upload
- https://wink.ai/video-frame-interpolation
- https://wink.ai/video-color-match/upload
- https://wink.ai/remove-object-from-video
- https://wink.ai/video-watermark-remover/upload
- https://wink.ai/video-retouch/upload
- https://wink.ai/ai-video-extender/upload
- https://wink.ai/text-to-video-ai
- https://wink.ai/ai-animal-video
- https://wink.ai/download-guidance

## Final status

This document is a public-surface research specification. It does not certify private product internals or production output quality. The next reverse-engineering pass should use user-authorized authenticated sessions to document exact screen states and control behavior, then refresh public API schemas and build conformance tests for original Executive Visuals components.
