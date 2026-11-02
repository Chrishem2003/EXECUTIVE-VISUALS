# AI Transformation Studio

**Status:** transformation contract and resumable finishing orchestrator implemented; provider execution is still adapter-gated.

## Product intent
Transform an existing video while retaining the parts of the shot the creator wants to keep. This is a first-class editing workflow, not a new text-to-video screen.

### Initial transformation families
- **Vehicle replacement:** replace a car, motorcycle or other vehicle with a specified design or reference asset.
- **Wardrobe replacement:** change clothing, fabric, colour, accessories or styling while retaining the subject's performance.
- **Object replacement:** swap a product, prop or other selected object.
- **Background replacement:** change the location or environment.
- **Person replacement:** replace an on-screen person only when source/reference rights and explicit subject consent requirements are satisfied.
- **Style transfer:** restyle the visual treatment.
- **Object removal:** remove a selected object and reconstruct the scene.
- **Relighting:** change lighting direction, quality or mood.

## User workflow
1. Select an existing video asset in a project.
2. Select the transformation type and describe the target result.
3. Optionally attach up to four approved reference-image asset IDs.
4. Choose preservation constraints: camera movement, timing, composition, source audio, subject identity, pose, lighting or background.
5. Review the selected adapter's declared limits, supported constraints, input requirements, queue status and price estimate. Unknown prices remain unknown.
6. Review a draft plan and approve any remote/paid execution explicitly.
7. Submit an asynchronous job only after provider integration, source permissions, storage and approval gates are ready.
8. Compare original and result, inspect frame-level defects, accept or reject, then create a new derived asset with source lineage.

## Engineering contract now in place
The provider-neutral contract provides request normalization, supported operation validation, source-video checks, clip/reference bounds, explicit rights confirmation, subject-consent checks for person replacement, capability checks and transformation provenance.

The contract is intentionally non-executing. It does not upload files, accept arbitrary provider URLs, call a remote model, spend credits or claim a generated result. Adapters must declare both supported operations and preservation behavior. Unsupported constraints fail closed.


## Workspace draft experience

The Enhancement Lab now includes a Transformation Studio draft form. It loads private cloud-project assets, allows a creator to choose a source video, transformation family, target description, detailed instruction, duration up to 30 seconds, optional private image references and preservation constraints. Source/reference rights are confirmed before a draft can be saved; person replacement also requires explicit subject-consent confirmation.

Drafts are saved in browser planning state and included in the project JSON export. They are visibly labelled **draft / not submitted**. This is a planning interface only: there is no API submission endpoint wired to it, and no provider call or credit spend occurs.

## Checkpointed finishing pipeline

`server/video-finishing-pipeline.mjs` now orchestrates a provider-neutral sequence of transformation, upscale, frame-rate, HDR, audio finishing and transcode steps. It requires a known estimate for every step, explicit approval and an adequate budget before any remote step can run, exact adapter capability declarations, and a valid derivative receipt whose parent is the immediately preceding asset.

Each successful step is saved as a checkpoint with a deterministic idempotency key derived from the pipeline, step, input asset checksum and normalized settings. A resumed run reuses matching successful checkpoints and refuses stale or conflicting checkpoints. Original media is never passed as an output target; adapters must publish a new derivative through the existing private asset boundary.

The orchestrator is deliberately adapter-injected. It does not submit remote requests, choose providers, download arbitrary URLs or spend credits by itself. A local SQLite checkpoint store is now available with owner/project scoping, idempotent writes and conflict detection. The API/worker must still construct it only after the authenticated user’s project write permission has been checked. Cloud-database checkpoint migration and production adapter wiring remain integration work.

## Quality and review gates
- Compare original and transformed frames at the start, middle, end and points of fast motion.
- Inspect object geometry, occlusion, shadows, reflections, contact with the ground, clothing seams, hands/faces, background edges and flicker.
- Verify source audio and timing independently; do not imply they were preserved unless the adapter declares and tests that behavior.
- Store immutable source assets; results are new derivatives with parent asset ID, SHA-256, model/version, request hash, reference asset IDs, settings, approval and timestamps.
- Keep a visible “needs review” state until a human accepts the output.
- Retry only with an explicit new attempt record; do not overwrite the source or a previously accepted result.

## Release gates still outstanding
- One approved video-to-video adapter with documented operation-specific capability declarations.
- Secure private media upload/ingestion and output validation.
- Asynchronous job lifecycle, polling/webhooks and bounded retries.
- Cost disclosure and explicit remote execution approval.
- Integration tests proving lineage, owner/project isolation, no source overwrite and truthful provider readiness.
- Side-by-side visual QA fixtures and human review evidence.

No competitor names, logos, proprietary prompts, private endpoints or copied assets are part of this product feature.
