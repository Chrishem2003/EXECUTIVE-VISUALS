# Capability discovery notes — additional public ecosystems

This file records product-neutral findings that expanded the Executive Visuals specification. Provider names and branding are intentionally omitted from the product-facing documentation. Findings are from public first-party documentation and public product surfaces; they are not private implementation claims.

## Additional workflow-engine findings
- A visual graph can include manual input nodes, generative media nodes, LLM nodes and deterministic utility nodes.
- LLM nodes can accept system instructions and multimodal inputs, allowing dynamic prompt generation and media analysis inside a graph.
- Utility nodes can stitch clips, extract first/middle/last frames, add or extract audio, reframe for other aspect ratios and remove image backgrounds.
- Workflows can be run end-to-end or node-by-node; concurrent node groups expose an active-runs view with progress and cancellation.
- Node outputs can be locked so reruns do not regenerate stable upstream work.
- Nodes can be swapped only where contracts are compatible; multi-selection supports batch editing of shared settings.
- Workflow saves create versions that can be inspected and restored. Templates, workspace sharing, project sharing and view-only link sharing have distinct semantics.
- Input assets and generated outputs may have different sharing rules. Executive Visuals must encode those rules explicitly rather than assuming a workflow share link includes every output.

## Additional design and content-operation findings
- Creative APIs may expose assets, folders, design creation, page retrieval, export, comments, replies, analytics and brand-template operations as separate domains.
- Brand-template datasets can be inspected and populated through asynchronous autofill jobs.
- Media assets can be uploaded directly or by URL, with separate job creation and job-status retrieval.
- Video editing integrations can expose selected video content for controlled replacement or manipulation.
- API versions and preview status matter. Preview contracts must be labelled and isolated from production-critical flows.
- A design can be generated in a platform, edited by the user there, and exported back to the originating system. This supports an integration-first architecture rather than forcing every editing feature into one proprietary renderer.

## Additional generative-image findings
- Custom subject and style models can be trained and referenced by stable model/asset identifiers.
- Composite operations can place a product/object into a generated scene while harmonizing lighting, shadows, tones and textures.
- Image upscaling and natural-language instruction-based editing should be separate capabilities with independent constraints.
- Reusable trained models need versioning, access grants, provenance and deletion controls; they are not interchangeable with ordinary image reference files.

## Additional audio findings
- Audio APIs separate speech synthesis, streaming speech, transcription, real-time transcription, voice creation, voice settings, dubbing, music and sound effects.
- Speech-to-text can provide word timestamps, speaker diarization and key-term prompting.
- Voice-agent platforms combine recognition, an LLM, speech synthesis and turn-taking; this is a different workflow from offline voiceover generation.
- Dubbing should preserve speaker mapping and timing as structured data, not just return one flattened audio file.
- Credit systems may meter characters, audio duration or model-specific units; cost estimation must be capability-specific.

## Additional local-processing findings
- Desktop enhancement tools can expose model managers that inspect hardware compatibility, model versions and disk-space requirements before installing model files.
- Model installation/removal, download progress, hardware eligibility and app-version compatibility belong in the local runtime manager.
- Media enhancement is a chain of distinct operations: upscale, denoise, stabilization, frame interpolation, deblur, SDR/HDR conversion and other restoration steps.
- Folder/batch import and queue management are core operational features, not merely convenience controls.
- Local execution requires an explicit runtime capability report (CPU/GPU/VRAM/RAM/disk/OS) and must never silently download multi-gigabyte models.

## Architecture decisions for Executive Visuals
1. Build a provider-neutral capability registry with semantic ports and versioned constraints.
2. Separate graph planning, validation, simulation, approval and execution.
3. Keep utility nodes distinct from generative nodes; deterministic steps should not incur model charges.
4. Persist immutable run snapshots and workflow version history.
5. Support node-level execution, subgraph execution, concurrent runs, output locking and safe retries.
6. Add a local model/runtime manager with hardware and disk preflight.
7. Treat brand-template autofill, comments, analytics and exports as first-class integration domains.
8. Model voice, speaker, transcript, word timing and locale tracks as separate objects.
9. Record provider limits, cost units, API version and preview status per capability.
10. Never claim a feature is operational until its adapter, test fixture and end-to-end verification exist.

## Primary public references
The underlying first-party documentation was inspected during the research pass. Source references are retained as neutral IDs in the research workspace; this product-facing note intentionally does not reproduce vendor names or branded UI labels.
