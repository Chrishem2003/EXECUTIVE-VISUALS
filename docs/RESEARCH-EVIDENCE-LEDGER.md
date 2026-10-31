# Evidence ledger — public reverse engineering

Date: 31 October 2026  
Target: public product surfaces for Platform A, Platform B and Platform C  
Repository: Executive Visuals  
Method: REA-inspired evidence-first research and independent implementation.

## Scope boundary

This pass examined public first-party marketing pages, public help-centre documentation, public developer documentation, product directories and the unauthenticated Platform C workspace landing surface. It did not inspect private source code, private endpoints, authenticated project data, model weights, proprietary prompts or hidden service infrastructure.

The Platform B app landing surface returned only a minimal public shell; its signed-in workspace was not available. Platform C's workspace exposes a login state and public tool catalogue; private account data was not accessed.

The REA skill documentation says to use REA tools for shipped-artifact/runtime evidence and browser runtime observation, and to verify that its server is actually connected. REA MCP inspection tools were not exposed in this session. Therefore this report uses public first-party evidence and does not claim binary decompilation, authenticated runtime tracing or private API discovery.

## Evidence register

| ID | Surface | Supports | Confidence |
|---|---|---|---|
| HF-01 | Platform A What is Platform A help page | Soul, Soul ID, Cinema Studio, Marketing Studio, Canvas, Supercomputer, audio and model catalogue | High |
| HF-02 | Platform A tool selector | Tool-to-task mapping and workflow selection | High |
| HF-03 | Cinema Studio page and guide | Camera, lens, lighting, genre, era, tempo, references, cast, project settings and collaboration | High for advertised capabilities |
| HF-04 | Marketing Studio help | Template ads, product URL, reference ads, avatar reuse and prompt path | High |
| HF-05 | Canvas help | Nodes, graph connections, sequential/parallel runs, templates and collaboration | High |
| HF-06 | Supercomputer help | Agent planning, model routing, connectors, skills, memory, storage and schedules | High |
| HF-07 | AI Influencer help | Menu-driven character builder, face/body/style, reusable character assets and motion references | High |
| HG-01 | Platform B product llms.txt | Product catalogue, avatar families, translation, localization and enterprise | High |
| HG-02 | Platform B developer llms.txt | Auth models, API families, batch, webhooks, CLI, MCP and developer docs | High |
| HG-03 | Platform B developer portal | Avatars, voices, video agent, translation, lip-sync, realtime avatar and assets | High |
| HG-04 | Platform B public tools directory | Text/video/image generation, face swap, lip-sync, voice cloning, captions and editing | High |
| WK-01 | Platform C public workspace | Home, Video, Image, Recents and tool catalogue | High for public shell |
| WK-02 | Platform C AI Workflow page | Ordered custom enhancement workflow and upload/import entry | High |
| WK-03 | Platform C workspace catalogue | Enhancer, watermark remover, repair, upscaler, retouch, restoration, converter, compressor, denoise, expansion, color and interpolation | High |
| WK-04 | Platform C benefits/product pages | Scene-specific models, batch processing and platform-specific capability differences | High for advertised capabilities |
| WK-05 | Platform C object removal/text-to-video pages | Marked object removal, frame-wise reconstruction and text-to-video flow | High for advertised workflow |

## Direct observations

- Platform A publicly describes focused studios, a chat-driven orchestrator and a visual node workflow.
- Platform A documents model choice, reusable identity/character assets, references, project-level settings and team collaboration.
- Platform B documents distinct avatar/video, speech, translation, lip-sync, template, agent and batch API families.
- Platform C's public workspace exposes separate media tools and custom workflow; its pages describe ordered processing and scene-specific repair.
- Platform B and Platform A expose developer/agent integration surfaces. Platform C publicly documents a desktop agent skill for enhancement.

## Engineering inferences for Executive Visuals

- A shared project/asset/job graph is a coherent architecture for combining these functions.
- Provider-neutral contracts reduce lock-in and allow separate generation and enhancement engines.
- Immutable job snapshots and per-node cost preflight support reproducibility and paid-generation safety.
- Identity, voice and media rights should be first-class records with consent and audit history.
- A non-destructive timeline and asset lineage preserve provenance and support revisions.

## Unknown / not asserted

- Internal microservices, database schema, queues, storage vendors, model weights, orchestration prompts, ranking systems, private endpoints and private UI behaviour.
- Account-specific plans, credit balances, model availability and workspace settings.
- Exact quality, latency, cost and reliability for each provider/model.
- Exact authenticated Platform C editor controls and Platform B application editor states.

## Volatility and conflicts

- Platform A Cinema Studio limits vary by version and source. Duration and reference limits must come from the selected model's live schema.
- Platform B language coverage differs across public pages. Locale support must be validated per language pair.
- Platform C features differ between web, PC and mobile and may be plan/credit dependent.
- Public catalogues change; availability and cost must not be hard-coded.

## Sources

### Platform A
- [Source URL redacted] A.ai/creator-hub/help-center
- [Source URL redacted] A.ai/creator-hub/help-center/getting-started/what-is-Platform A
- [Source URL redacted] A.ai/creator-hub/help-center/tools/which-Platform A-tool-should-i-use
- [Source URL redacted] A.ai/cinematic-video-generator
- [Source URL redacted] A.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio
- [Source URL redacted] A.ai/creator-hub/help-center/tools/how-do-i-use-marketing-studio-to-create-video-ads
- [Source URL redacted] A.ai/creator-hub/help-center/tools/how-do-i-use-canvas
- [Source URL redacted] A.ai/creator-hub/help-center/tools/how-do-i-use-supercomputer
- [Source URL redacted] A.ai/creator-hub/help-center/tools/how-do-i-use-ai-influencer
- [Source URL redacted] A.ai/soul-intro

### Platform B
- [Source URL redacted] B.com/llms.txt
- [Source URL redacted] B.com/llms.txt
- [Source URL redacted] B.com/
- [Source URL redacted] B.com/mcp/overview
- [Source URL redacted] B.com/tool
- [Source URL redacted] B.com/avatars
- [Source URL redacted] B.com/translate
- [Source URL redacted] B.com/enterprise
- [Source URL redacted] B.com/security

### Platform C
- [Source URL redacted] C.ai/workspace
- [Source URL redacted] C.ai/ai-workflow
- [Source URL redacted] C.ai/
- [Source URL redacted] C.ai/benefits
- [Source URL redacted] C.ai/about-us
- [Source URL redacted] C.ai/video-enhancer/upload
- [Source URL redacted] C.ai/video-repair/upload
- [Source URL redacted] C.ai/video-upscaler/upload
- [Source URL redacted] C.ai/video-retouch/upload
- [Source URL redacted] C.ai/video-watermark-remover/upload
- [Source URL redacted] C.ai/video-frame-interpolation/upload
- [Source URL redacted] C.ai/ai-video-extender/upload
- [Source URL redacted] C.ai/video-color-match/upload
- [Source URL redacted] C.ai/remove-object-from-video
- [Source URL redacted] C.ai/text-to-video-ai

### Method
- [Source URL redacted]
- [Source URL redacted]

## Conclusion
Public evidence is sufficient to define a broad independent capability map and target architecture. It is not sufficient to claim exact private product parity. The next engineering gate is the shared durable platform and real documented engines behind tested adapters.
