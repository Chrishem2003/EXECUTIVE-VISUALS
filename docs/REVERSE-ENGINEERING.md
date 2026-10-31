# Reverse-engineering research and implementation plan

## Method
This project follows the reusable REA workflow: inspect first; gather authorized evidence; map components, workflows, dependencies, APIs and data flows; distinguish observed facts from inferences and unknowns; implement original capability contracts; verify behavior; preserve provenance and limitations.

REA's guidance distinguishes passive browser observation from an agent-performed browser scenario. Passive observation does not establish prior network activity, and captured schemas or page declarations are untrusted evidence. Do not invoke page-declared tools or undocumented private endpoints. Use public documentation, authorized user-owned sessions, explicit test accounts, and user-provided captures.

## Public capability research

### Presenter-led video
Public product documentation describes script-driven avatar video, gesture and delivery controls, voice generation, video translation, lip synchronization, reusable avatars, and programmable video APIs. Executive Visuals will expose these as independent capabilities behind provider adapters.

### Cinematic generation
Public documentation describes text/image/link-to-video workflows, multi-shot scene planning, reference images, camera and lens controls, motion controls, character continuity, model selection, and reusable node-based workflows. Executive Visuals will model scenes, shots, references and camera intent as portable project data.

### Visual enhancement
Public documentation describes image/video restoration, super-resolution, portrait retouch, object/background removal, captions, expansion, color and lighting correction, and frame interpolation. Executive Visuals will represent these as composable editing operations with explicit input/output assets.

## Evidence ledger

| Area | Evidence class | Current conclusion | Unknown |
|---|---|---|---|
| Presenter video | Public product/API documentation | Workflow categories are documented | Private implementation, model weights, undocumented endpoints |
| Cinematic tools | Public product/help documentation | Camera, multi-shot and continuity controls are documented | Internal prompt orchestration and proprietary models |
| Enhancement | Public product documentation | Enhancement operation families are documented | Model internals, exact quality/performance parity |
| Wink workspace | Public web information | Publicly described product capabilities are documented | Full signed-in workspace behavior and private API contracts |

## Independent implementation rules
- Do not copy source code, private API calls, proprietary prompts, model weights, brand assets, or product identity.
- Do not bypass authentication, paywalls, rate limits, consent checks, or licensing.
- Reproduce user-visible workflows through original UI and documented/authorized provider APIs.
- Mark each capability as planned, prototype, adapter-ready, connected, or verified.
- Preserve source links and distinguish observed behavior from inference.
- Never claim parity until representative tests demonstrate it.

## Milestones
1. Foundation: coherent navigation, projects, briefs, local asset shelf, job model, provider status.
2. Creative planning: director, script/storyboard, shot lists, reusable character and brand references.
3. Generation adapters: image, video, avatar and voice providers behind typed contracts.
4. Editing and enhancement: timeline, captions, audio, retouch, restoration and exports.
5. Production operations: durable storage, background jobs, collaboration, permissions, audit and cost controls.
6. Verification: capability-by-capability acceptance tests, provider failure handling, security and rights review.

## Consolidated local enhancement adapters

The platform now routes denoise, color correction, resize/reframe, frame interpolation and FFmpeg scaling through its shared media job and asset pipeline. All outputs are private derived assets with checksums. These adapters are local processing capabilities, not a claim that advanced neural restoration, generative editing or every catalogued capability is implemented.
