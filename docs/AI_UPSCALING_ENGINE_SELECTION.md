# AI Video Upscaling — Engine Selection and Integration Plan

## Decision

Adopt a pluggable worker-side AI enhancement interface. Keep classical FFmpeg scaling as the guaranteed fallback. The first candidate for a low-cost image/frame enhancement backend is Real-ESRGAN NCNN/Vulkan, subject to runtime, model-weight and commercial-use review before enabling it.

Primary references:
- Real-ESRGAN official repository and BSD-3-Clause source licence: https://github.com/xinntao/Real-ESRGAN
- Portable NCNN/Vulkan executable usage and model list: https://github.com/xinntao/Real-ESRGAN#portable-executable-files-ncnn
- NCNN implementation: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
- Video2X integration reference (AGPL-3.0; not selected as the hosted-service dependency): https://github.com/k4yt3x/video2x

## Why this first candidate

The upstream project documents portable NCNN executables for Intel, AMD and NVIDIA GPUs, without requiring a CUDA or PyTorch installation. That is a better initial fit than a CUDA-only research pipeline. It has general-scene and animation-oriented models, configurable scale and tile size, and can run as an isolated worker process.

This is a candidate, not a claim that the engine is installed or operational. The hosted worker must explicitly detect the executable, model files, Vulkan device and memory budget before offering the operation.

## Important limitations

- Real-ESRGAN is primarily a per-image restoration model. Processing video frame-by-frame does not guarantee temporal consistency and can introduce flicker or changing details.
- The NCNN Vulkan CLI documents tile-based processing; tile seams/block inconsistency are a known consideration. Validate representative footage and compare source/output before production use.
- Do not use face restoration by default. Face/identity enhancement must remain an explicit, consent-aware operation.
- A frame-by-frame AI pass is not automatically a complete video pipeline. The final worker must preserve frame rate, timestamps, audio streams, rotation metadata, colour metadata and duration, then verify all output with FFprobe.
- Do not assume GPU availability on generic cloud instances. A missing Vulkan device must fail closed or use the existing classical fallback only after the user selects it.

## Worker contract

1. Probe: report executable, model, model-file, Vulkan device, driver and available-memory status. Never download weights automatically.
2. Plan: validate input dimensions, requested output dimensions, scale, model compatibility, tile size, estimated temporary storage and timeout budget.
3. Execute: run without a shell, in an isolated temporary directory, with cancellation and bounded runtime/output size.
4. Verify: check every frame output exists; verify exact output dimensions; rebuild video with source timestamps and audio; use FFprobe to verify codec, pixel format, frame count, frame rate, duration and audio preservation.
5. Review: record source/output checksums, engine/model version, settings and validation results. Provide side-by-side preview and allow rejection without overwriting source.
6. Fallback: keep the current Lanczos/bicubic/spline36 pipeline clearly labelled as classical scaling, never as AI.

## Hardware policy

Use adaptive tiling and a single processing stream on low-memory GPUs. Start with conservative tiles and a short sample clip; increase only after the worker proves it can complete without out-of-memory errors. If no compatible GPU exists, show AI enhancement as unavailable rather than silently switching execution modes.

## Not selected for first hosted integration

- Video2X is useful as a local desktop orchestration reference, but its AGPL-3.0 licence requires a separate hosted-service distribution review.
- High-compute video diffusion restoration systems such as SeedVR2 or research pipelines such as PS-SR require GPU resources and operational validation that are not justified for the initial low-cost worker.
- No paid or remote enhancement API should be called without a separate explicit approval and usage budget.

## Acceptance gates

- Reproducible sample set covering live-action faces, low-light footage, fine text, motion, animation and compression artifacts.
- No unreviewed identity changes or invented fine details in faces/text.
- No visible temporal flicker beyond agreed tolerances.
- Audio, frame rate, duration and timestamps preserved.
- Output dimensions and codec verified.
- Cancellation, timeout, retry and cleanup tests pass.
- Source is never overwritten; only a verified derivative is published.
- Engine, weights and dependency licences reviewed for hosted/commercial distribution.


## Implementation status — 1 November 2026

The first still-image adapter has now been added to the repository as an optional worker operation.

Implemented:
- A distinct `media.ai-upscale` job type for still-image assets; video inputs are rejected.
- NCNN/Vulkan executable and allowlisted model-file readiness checks. No model weights are downloaded automatically.
- Scale, tile, output-format, timeout and output-size validation.
- Process launch without a shell, cancellation support and source/output path separation.
- PNG, JPEG and WebP output-signature validation before a derivative can be published.
- Source-linked derivative provenance including engine, model, scale and tile settings.
- Local and cloud worker integration, with tests for missing dependencies, invalid settings, output validation, derivative provenance and video rejection.

Not yet implemented or verified:
- No NCNN/Vulkan executable or model weights are bundled or installed by this change.
- A Vulkan device/driver and available-memory probe is still required; file presence alone is not proof that GPU execution will succeed.
- The current adapter verifies the container signature, not decoded image integrity, dimensions or perceptual quality. Those are required before a production-quality release.
- No temporal video super-resolution path is enabled.
- Generic hosted workers must not advertise the operation as available unless a compatible runtime is provisioned and its health check passes.

## Next engineering gates

1. Add an explicit engine self-test and Vulkan/device/memory probe; expose its result in the media capability/readiness API.
2. Decode and validate the output image, dimensions and checksum before publishing; add corrupted/truncated-image tests.
3. Add an image comparison review surface with original/derivative toggle and clear AI provenance.
4. Build a separate video pipeline: bounded frame extraction, timestamp manifest, scene-aware batching, optional temporal model interface, audio remux, FFprobe verification and cleanup on cancellation.
5. Run a curated quality benchmark across portraits, text, animation, low-light and compressed images. Do not use face restoration by default.
6. Gate hosted execution on worker-specific GPU capability, dependency licensing and explicit operator enablement.


### Worker enablement and capability reporting

The adapter now requires an explicit worker-side `AI_UPSCALE_ENABLED=true` setting in addition to a readable executable and the selected model's `.param` and `.bin` files. It defaults to disabled. The authenticated provider catalog probes the configured engine and reports a separate `ai-upscale` capability; the capability is only advertised as ready when both engine files are present and the explicit enable flag is true.

This is a configuration gate, not a hardware certification. A successful readiness result does not yet prove that a Vulkan driver/device can complete a real inference. Before enabling this in a hosted environment, provision the executable and model on an isolated worker, run a controlled self-test against a known sample, verify output dimensions and decoded integrity, and only then enable the flag for that worker. Keep the flag off on generic CPU-only web/API services.


### Output-dimension verification

The cloud still-image path now requires FFprobe on the worker and probes both the original and enhanced image. It checks that output width and height equal the source dimensions multiplied by the requested scale before publishing the derivative. The verified source/output dimensions are retained in processing provenance. If FFprobe is missing, cannot decode either image, or reports unexpected dimensions, publication is blocked.

This remains a structural validation gate, not a perceptual-quality score or a Vulkan inference self-test. The engine must still be tested on the target worker with representative images before production enablement.


### Full image decode gate

Cloud still-image AI upscaling now requires both FFprobe and FFmpeg. After checking that the output dimensions match the requested scale, the worker decodes the entire enhanced image through FFmpeg to a null sink. A decoder error or timeout prevents derivative publication. This catches truncated or structurally corrupt files that pass a short file-signature check or metadata probe. It does not measure perceptual quality, detect hallucinated detail, or certify Vulkan/GPU readiness; those remain separate review and worker qualification gates.
