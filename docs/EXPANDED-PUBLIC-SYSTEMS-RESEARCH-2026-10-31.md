# Expanded Public Systems Research — 31 October 2026

This dossier adds cross-category production systems research beyond the initial three-product audit. Product and vendor names are intentionally omitted. It records transferable behavior and standards, not protected implementation details.

## Evidence boundary

- **Observed/publicly documented:** behavior described in official documentation, public API schemas and open standards.
- **Inferred design opportunity:** a product capability suggested by the evidence but not verified in the target system.
- **Unknown:** authenticated-only screens, proprietary runtime behavior, unpublished limits and undocumented endpoints.
- No private account was accessed. No private API, credential, prompt, model weight, protected asset or source code was obtained.
- URL inventories and public docs do not reveal all internal features. "Hidden" in this project means undocumented gaps to investigate with authorized access, not permission to bypass access controls.

## 1. Node-graph workflow systems

Public documentation and API schemas expose several important patterns:

- Typed input nodes for text, image, video and audio.
- Model nodes separated from language-model nodes and deterministic media-utility nodes.
- Prompt enhancement nodes with distinct user prompt and system instruction inputs.
- Utility operations for first/middle/last frame extraction, video stitching, audio insertion/extraction, aspect-ratio reframing, background removal and structured JSON parsing.
- Workflow publication as a stable callable endpoint, with version-specific invocation IDs.
- Explicitly exposed inputs and outputs; hidden/internal graph values remain server-side.
- Workflow invocation status and result polling are distinct from ordinary model-task polling.
- Targeted/partial execution can run selected output nodes while reusing upstream results.
- Queue priority, execution history, output metadata, node-level errors and workflow-version references are first-class concepts.

**Design consequence:** the graph engine must distinguish workflow definition, immutable workflow version, invocation, node execution and produced asset. A workflow endpoint is not itself a job result. Each invocation gets a run snapshot and per-node event history.

## 2. Editorial timeline interchange and media references

Open timeline interchange standards describe editorial data independently of media bytes. Core structures include:

- Timeline, track, clip, gap, stack, transition, marker and nested composition.
- Rational time values and explicit source/record ranges.
- External media references rather than embedding the source video/audio in the edit-decision document.
- Metadata and schema versioning.
- Adapter plugins to translate editorial formats and media-linker plugins to resolve storage-specific locations.
- File bundles for carrying timeline documents with supporting resources.

**Design consequence:** separate the edit decision from the media file. Store rational frame/time values, source in/out, track ordering, transforms, transitions, markers and external asset IDs. Export an interchange document and provide relinking instead of creating a proprietary media container.

## 3. Professional post-production and review

Public documentation across editing and review systems reveals:

- Multi-project production structures for long-form work.
- Shared bins and references rather than duplicating media files.
- Project and sequence locks to avoid conflicting edits.
- Explicit publish/sync checkpoints; autosave is not equivalent to publishing a collaborative revision.
- Offline work with later synchronization.
- Presence indicators and visual status for collaborators.
- Version history, revert/restore, review notes and publish comments.
- Timestamped comments and visual annotations that can be imported as timeline markers.
- Review approval and new-upload events as workflow triggers.
- Camera-to-cloud upload flows with device authorization, automatic project/date/device organization, pause/resume controls and upload lifecycle events.

**Design consequence:** implement versioned project state, sequence-level leases, explicit publish checkpoints, reviewer roles, comment timecodes, immutable review versions and resumable uploads. A single shared mutable JSON document is not a safe collaboration model.

## 4. Preview performance and media cache

Public editing manuals describe several distinct cache layers:

- Raw source-frame cache.
- Preprocessed/effect cache.
- Intermediate composite cache.
- Final rendered-frame cache.
- Background frame prefetch.
- Proxy media at reduced resolution/quality.
- Per-strip proxy configuration and preview resolution controls.
- Cache indicators and memory accounting.

**Design consequence:** model source media, proxies, preview caches and final outputs as different asset roles. Cache invalidation must include source hash, time range, effects graph revision, color settings, resolution and frame rate. Never replace the original source with a proxy.

## 5. Automated editing and speech workflows

Public API and product documentation exposes trigger-driven pipelines:

- New recording, article, folder arrival or webhook as an automation trigger.
- Import, transcription, filler-word removal, audio enhancement, clip extraction and caption creation as separate steps.
- Translation, dubbing, speaker attribution and subtitle export.
- Human review checkpoints before publishing.
- Publish actions may create shareable web versions, while direct source-file export can remain a separate capability.
- API token scopes can be restricted to a specific workspace/drive.
- A workflow can be automated even when final media export still requires a local or desktop step.

**Design consequence:** do not equate transcript export, share-page creation and binary media export. Model each as a separate capability with a verified output contract.

## 6. Local model and media-runtime management

Public local workflow APIs reveal the need to track:

- Workflow graph submission and a unique prompt/run identifier.
- Queue position and execution priority.
- Node execution errors and output metadata.
- Execution history, per-run status and output retrieval.
- Partial output and selected-node execution.
- Workflow templates and reusable subgraphs.
- Runtime node inventory and dynamic input metadata.

**Design consequence:** a local worker needs model inventory, runtime capability checks, queue state, progress events, execution history and output checksums. A model being installed does not prove the workflow is executable; validate required nodes, custom operators, device memory, model files and runtime version before dispatch.

## 7. Additional capability gaps to include in the product

The expanded scope should explicitly cover:

1. Timeline interchange, rational frame timing, nested sequences and media relinking.
2. Source/proxy/original lineage and cache invalidation.
3. Multi-project production organization and reusable shared assets.
4. Project, sequence and asset locking with explicit publish checkpoints.
5. Presence, reviewer roles, comments, annotations, approvals and review links.
6. Trigger-based workflow automation and resumable device ingest.
7. Workflow endpoint versions, exposed input/output contracts and invocation records.
8. Partial reruns, per-node retries, reusable subgraphs and deterministic utility nodes.
9. Per-node execution history, queue priority, node errors and output lineage.
10. Transcript-to-timeline editing, speaker diarization, glossary enforcement and subtitle review.
11. Local model discovery, runtime compatibility, hardware/resource preflight and cache management.
12. Distinct deliverables for transcript, preview, review link, source file, proxy, master and distribution variant.

## 8. Implementation priority

| Priority | Capability | Why |
|---|---|---|
| P0 | Durable project/asset/job storage, ownership and audit | Needed before multi-user or cloud use |
| P0 | Real local media processing, safe upload and derivatives | First end-to-end value without paid generation |
| P0 | Versioned workflow graph and node-run records | Turns the canvas into executable infrastructure |
| P1 | Timeline model and interchange export | Prevents editing lock-in and supports professional handoff |
| P1 | Proxy/cache pipeline and media relinking | Makes large projects practical on modest hardware |
| P1 | Review comments, approvals, locks and revision publishing | Enables teams without overwriting each other's work |
| P1 | Local model/runtime discovery and resource-aware scheduling | Enables a cost-controlled generation path |
| P2 | External provider adapters, paid generation and campaign publishing | Add only after contract and cost gates pass |

## 9. Acceptance gates

- Every feature has an evidence label and a clear readiness state.
- No unknown provider limit is invented.
- A workflow run stores a versioned graph snapshot and per-node outputs.
- Retrying one branch does not destroy successful sibling outputs.
- Media originals are immutable; all processing writes a derivative.
- File integrity is checked on ingest and before export.
- Every user-owned row is protected by tenant-aware authorization.
- Project membership is role-based; owner, editor, reviewer and viewer rights differ.
- Publish and approval are explicit, auditable transitions.
- Cost estimates and human approval precede paid calls.
- No integration is labelled ready until an adapter test and a real end-to-end test pass.
