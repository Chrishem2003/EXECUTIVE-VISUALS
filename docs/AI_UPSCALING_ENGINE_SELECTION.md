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
