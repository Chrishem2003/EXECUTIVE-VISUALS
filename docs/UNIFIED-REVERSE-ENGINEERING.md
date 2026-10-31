# Unified reverse-engineering dossier

## Scope and evidence
This original product specification consolidates publicly observable feature families from HeyGen, Higgsfield and Wink. It follows the REA method: inspect authorized surfaces, gather public evidence, map workflows and data boundaries, separate observed facts from inference, implement independently, then verify. The signed-in HeyGen application requires authentication; private workspace screens and undocumented endpoints were not inspected.

## Capability map
| Domain | Consolidated functions |
|---|---|
| Creative intelligence | brief, hook, script, storyboard, scenes, shot lists |
| Presenter and identity | reusable avatars, presenter profiles, voice, gesture/delivery, lip sync, dubbing |
| Cinematic generation | text/image/video generation, multi-shot, references, camera/lens/motion, first/last frames, continuity |
| Image creation/editing | prompt, references, variations, inpainting, outpainting, generative fill, background |
| Video generation | model routing, motion transfer, object replacement, multi-shot sequences |
| Post-production | timeline, trimming, transitions, overlays, captions, audio, social cutdowns, exports |
| Enhancement | upscale, restoration, portrait repair, denoise, low-light, stabilization, interpolation, color, repair |
| Cleanup | object/background removal, expansion, conversion and compression |
| Campaigns | product ads, UGC concepts, creator-led explainers, channel variants, batches |
| Orchestration | node graph, multi-engine routing, reusable workflows, versioning and collaboration |
| Operations | asset library, jobs, permissions, storage, approvals, audit and cost controls |

## End-to-end flow
Project → brief → script/hooks → storyboard/scenes/shots → character/voice/brand references → keyframes → image/video generation → presenter/voice/localization → multi-track edit → enhancement chain → campaign variants → review/approval → render/export/archive.

## Shared data model
Project, Brief, Script, Scene, Shot, Character, VoiceProfile, BrandKit, WorkflowGraph, Job, Asset, Timeline, ConsentRecord, Review, Deliverable. Generated and transformed assets retain provider/model/version, operation metadata, parent asset, checksum, timestamps, consent reference and usage/cost where available.

## Capability maturity
Planned → Local prototype → Adapter-ready → Connected → Verified. A capability is not available because a vendor or key is mentioned. Verified requires a representative end-to-end test with persisted output.

## Security and rights
- No proprietary source, private APIs, protected prompts, model weights or brand assets copied.
- No bypassing authentication, paywalls, rate limits, licensing or consent.
- Provider credentials live only on a trusted server/secrets manager.
- Validate media types, sizes, checksums, user rights and permissions before dispatch.
- Require documented consent for real-person face/voice cloning, identity transfer and dubbing.
- Preserve originals; transformations create derivatives with parent lineage.
- Enforce budgets, approval gates, rate limits and provider attribution.
- Redact secrets and signed URLs from logs.

## Target architecture
Web client: project workspace, graph canvas, storyboard, character bible, media library, timeline and review UI.
API: authenticated project/asset/job endpoints, capability discovery, validation and authorization.
Orchestrator: graph validation, dependency scheduling, provider selection, retries, cancellation, webhooks and usage.
Adapters: provider-neutral image, video, avatar, speech, translation, editing and enhancement interfaces.
Storage: private object storage, signed upload/download, checksums and asset lineage.
Database: users, workspaces, projects, permissions, briefs, scenes, shots, jobs, assets, consents, provider usage and audit events.
Workers: background media processing, polling and webhook ingestion.
Observability: structured logs, trace IDs, queue health, failure classification and cost dashboards.

## Acceptance gates
1. Create and reopen a project without losing metadata.
2. Brief creates editable script/scene/shot records.
3. Reuse character and voice profiles with consent visible.
4. Workflow validation rejects missing inputs, cycles and incompatible media types.
5. Provider secrets never appear in client bundles or logs.
6. Jobs support queued/running/succeeded/failed/cancelled and idempotency.
7. Outputs persist with checksum and source lineage.
8. Timeline renders audio, captions and requested aspect ratio.
9. Enhancement preserves originals and creates derived outputs.
10. Campaign variants share approved product and brand references.
11. Usage, cost and failures attributed to user, project, provider and model.
12. Verified requires an end-to-end provider test.

## Current boundary
This branch consolidates the product architecture and adds a local-first interactive workspace with project briefs, storyboard records, character profiles, workflow graph, local asset previews and campaign concept scaffolding. It does not yet include authentication, durable storage, actual model execution, rendering, or provider adapters. Those require trusted backend infrastructure and authorized provider accounts or a local inference/render environment.
