# AI Transformation Studio

**Status:** capability contract and planning foundation implemented; provider execution is not yet enabled.

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
