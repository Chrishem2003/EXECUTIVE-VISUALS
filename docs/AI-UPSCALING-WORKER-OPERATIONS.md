# AI Upscaling Worker Operations

The Real-ESRGAN NCNN/Vulkan adapter uses the upstream `-j load:proc:save` option to control image-load, processing, and image-save worker counts.

## Automated image quality and seam review

`server/upscale-visual-quality.mjs` exposes a bounded FFmpeg/FFprobe RGB decoder and a deterministic pixel analyzer. It checks configured tile-grid boundaries for persistent gradient discontinuities and, when an aligned reference is supplied, reports explicitly named global RGB SSIM and PSNR metrics. The paired global SSIM value is not presented as windowed benchmark SSIM. LPIPS is not computed by this module. Images are limited to 40 million pixels by default; decode output is byte-capped and subprocesses have time limits. The assessor can be injected into `createUpscaleBatchProcessor`; assessment failures are recorded as unavailable and never clear the mandatory human-review gate.

## Batch image enhancement

Use `createUpscaleBatchProcessor({ adapter, defaultConcurrency })` from `server/upscale-batch.mjs` to process 1–100 independent assets through the existing single-image adapter. The processor caps concurrency at four (default one), rejects duplicate output paths and any output that would overwrite an input in the same batch, preserves per-item source/output digests and quality-review state, isolates item failures, supports cancellation, and reports progress. It does not bypass adapter validation or mark perceptual quality as passed.

The benchmark runner supports all four inference-engine model identifiers: `realesrgan-x4plus`, `realesrgan-x4plus-anime`, `realesr-animevideov3`, and `realesrnet-x4plus`. A benchmark still requires the selected model files, local execution self-test, and one fixture for each required content category. Registry coverage does not imply that every model has been run or visually approved.

## GPU device selection

The adapter exposes the NCNN CLI `-g` option as `gpu`. The default `auto` lets NCNN select the Vulkan device. An explicit device index from `0` through `31` can be selected for hosts with multiple Vulkan devices. The chosen value is included in execution and self-test diagnostics. The adapter does not probe device capabilities or guarantee that a selected index is present; deployment validation must confirm that the configured worker can initialize that device.

## Content-aware model recommendations

The adapter exposes `recommendModel(contentType)` as an explicit preset helper. Supported content types are `photograph`, `natural_detail`, `anime`, and `animation_video`. It returns an allowlisted NCNN model, a suggested scale, and a rationale. This is operator-selected guidance, not automatic image classification; the caller must pass the returned model to `plan` or `execute` and may override it after review. The helper does not claim that one model is universally best for a particular asset.

## Content-aware execution entry points

Use `planForContent({ contentType, ...options })` to build a validated NCNN plan from an explicit content preset. Use `executeForContent({ contentType, ...options })` to run the same flow and return the selected content type and recommendation rationale with the derivative metadata. Supported presets are `photograph`, `natural_detail`, `anime`, and `animation_video`. Explicit `model` and `scale` options override the preset after the standard allowlist and range validation. No automatic classification is performed.

## Safe thread tuning

- Default: `1:2:2` (conservative worker profile).
- Format: three integer values, `load:proc:save`.
- Each value must be between 1 and 4.
- Each stage is independently capped at 4; the maximum accepted profile is `4:4:4`.
- Upstream guidance suggests `4:4:4` for batches of many small images and `2:2:2` for large images. Benchmark memory and throughput on the target worker before changing the default.
- The adapter passes the value as a separate argv item; it never invokes a shell.
- Invalid values fail before the executable is launched.

Keep the default for memory-constrained GPUs. Increasing worker counts can improve throughput for some batches but can also increase memory pressure; benchmark on the target worker before changing defaults.

## Test-time augmentation (TTA)

The adapter exposes the NCNN CLI `-x` option as an explicit boolean. It is disabled by default because TTA can increase processing time. Enable it only for a quality-oriented job after benchmarking the latency and output on representative assets. The selected setting is included in execution and self-test diagnostics; enabling the flag is not itself a quality certification.

## Tile fallback

Tile size `0` requests the NCNN engine's automatic selection. If a recognized GPU allocation failure occurs, the adapter retries with progressively smaller explicit tiles. All attempts share one overall job deadline. An explicitly selected nonzero tile is never silently changed.

Successful and failed jobs expose the requested tile, attempted tiles, effective tile (on success), and whether fallback occurred.

## Output and quality gates

Perceptual quality remains explicitly unassessed for every derivative until a validated image-quality assessor is integrated: successful results include `qualityAssessment: { status: "not_assessed", method: null }` and `qualityReviewRequired: true`. Structural validation, correct dimensions and SHA-256 integrity are not visual-quality claims. Automatic tile fallback adds a second review reason, not as proof of a bad image: successful results include `tileFallbackReason`, `qualityReviewRequired`, and `qualityReviewReasons`. When the worker had to reduce an automatic tile size because of GPU-memory pressure, downstream review should inspect tile boundaries and fine detail before approval. Explicit operator tile choices are never silently changed.

Benchmark and review timestamps must use an explicit RFC 3339 date-time with a timezone (UTC `Z` or numeric offset); date-only, timezone-free and non-string timestamps are rejected to avoid runtime-dependent parsing.

Human review timestamps must be at or after the benchmark execution timestamp and may not be more than five minutes in the future, allowing limited clock skew while rejecting pre-dated or implausibly future-dated approvals.

Every accepted derivative includes streaming SHA-256 digests for both the original source (`sourceSha256`) and generated output (`outputSha256`). The source digest is recomputed after inference and compared before accepting the derivative; a changed source causes rejection and cleanup. Store these digests with the asset lineage record and use them for integrity verification, not as a substitute for perceptual quality review.

The adapter validates image structure, dimensions, output byte/pixel budgets, alpha preservation, source identity, and output scale before accepting a derivative. Failed outputs are removed.

An execution self-test proves that the configured executable produced a structurally valid derivative. It does **not** prove perceptual quality. `inferenceVerified` remains false until representative model/worker inference has been benchmarked and image quality has been reviewed separately.

## Supported CLI boundary

This adapter targets the NCNN/Vulkan CLI. Do not pass Python-only Real-ESRGAN options such as `--fp32`, `--outscale`, or GFPGAN flags to this executable. The NCNN CLI's documented options include `-t` tile size, `-j` worker counts, `-x` TTA, and `-f` output format.

Reference: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
