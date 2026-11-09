# AI Upscaling Worker Operations

The Real-ESRGAN NCNN/Vulkan adapter uses the upstream `-j load:proc:save` option to control image-load, processing, and image-save worker counts.

## Automated image quality and seam review

`server/upscale-visual-quality.mjs` exposes a bounded FFmpeg/FFprobe RGB decoder and a deterministic pixel analyzer. It checks configured tile-grid boundaries for persistent gradient discontinuities and, when an aligned reference is supplied, reports explicitly named global RGB SSIM and PSNR metrics. The paired global SSIM value is not presented as windowed benchmark SSIM. An optional paired-reference LPIPS adapter can be injected; it is never run without an explicit same-resolution reference and locally provisioned model weights. Images are limited to 40 million pixels by default; decode output is byte-capped and subprocesses have time limits. The same assessor is now invoked by the local `media.ai-upscale` worker after derivative generation and C2PA preservation, and can also be injected into `createUpscaleBatchProcessor`; assessment failures are recorded as unavailable and never clear the mandatory human-review gate. The worker records seam findings and explicit review reasons in derivative processing provenance.

The Asset Library now exposes a batch-selection workflow for original image assets in the currently selected project/private workspace. It offers only models whose server readiness reports installed weights, a passed execution self-test and reviewed quality evidence; users choose 2×/3×/4× and submit the selected set. The UI is only a client convenience: the API repeats all ownership, project-boundary, model-evidence and execution-readiness checks before queueing.

The authenticated API also accepts `POST /api/jobs/batch` with an `items` array of 1–100 unique `{ sourceAssetId, model?, scale?, tile?, format? }` records and optional batch-level defaults (`model`, `scale`, `tile`, `format`, `projectId`). It validates image ownership/editor access, keeps every source within one project/private-workspace boundary, validates each model/options set, verifies each model's reviewed benchmark evidence and worker readiness, then atomically queues one ordinary `media.ai-upscale` job per item. The response includes a `batchId` and individually trackable jobs. This is queue fan-out, not a single GPU process: worker capacity and existing queue leases continue to control actual inference concurrency.

## Video temporal signal QA

The media QA worker now samples FFmpeg `signalstats` metadata at 8 fps and retains frame-average luma, saturation and U/V chroma values. It reports repeated alternating luma, saturation and chroma changes, while excluding samples around detected scene cuts. This is a low-cost screening signal for coarse exposure/color pumping; it is not optical-flow compensated, does not compare local regions, and cannot certify high-frequency flicker or temporal perceptual quality. The sample rate and findings are exposed in the media quality report. An unavailable FFmpeg check remains explicitly unknown rather than a clean result.

Do not describe this signal analysis as video-frame enhancement. The current AI upscaler still operates on image assets; a production video-frame enhancement path must separately prove frame-count/timestamp preservation, audio synchronization, model execution, color-range preservation, and temporal consistency before release.

## Video AI upscaling (framewise baseline)

`server/video-ai-upscale.mjs` adds an opt-in `media.ai-video-upscale` job. It probes the source, checks every frame timestamp, rejects variable-frame-rate, HDR and unsupported high-bit-depth inputs, extracts lossless PNG frames, runs the existing NCNN/Real-ESRGAN image adapter sequentially on each frame, and reassembles an H.264 MP4. It verifies the exact frame count, output dimensions, audio stream count and output byte budget before the asset is published. The original audio streams are copied when MP4-compatible; other audio codecs are transcoded to AAC. Content Credentials preservation and source-asset lineage are applied by the media worker.

This is a controlled framewise baseline, **not** a temporally trained video-super-resolution model. Independent image inference can flicker or change detail between adjacent frames. The result records `temporalConsistency: not-certified` and `qualityReviewRequired: true`; no automated approval is possible. The worker also runs scene-cut-aware FFmpeg signal analysis at 8 fps after reassembly, records global luma/saturation/chroma sample counts and emits alternating luma/color-instability warnings. If the optional temporal QA command is unavailable, that status is recorded and the derivative remains review-required. These are coarse frame-average screening signals, not motion-compensated or learned temporal perceptual metrics. A later temporal model adapter must use neighboring-frame alignment/propagation or an equivalent temporal architecture and pass sequence-level benchmark and human review before it can be presented as temporal-consistent enhancement.

### Enablement and limits

- Video processing is disabled unless `AI_VIDEO_UPSCALE_ENABLED=true` is explicitly set by an administrator. The existing `AI_UPSCALE_ENABLED`, installed model weights and successful model-specific execution self-test are also required.
- Submit through `POST /api/jobs` with `jobType: media.ai-video-upscale`, an accessible `sourceAssetId`, an allowlisted model, `scale: 2` or `4`, an NCNN `threads` plan (`load:process:save`, each 1–4), optional `tta`, and an explicit source-rights attestation. A worker must have FFmpeg, FFprobe and the configured NCNN/Vulkan executable/model files.
- For multi-clip work, `POST /api/jobs/video-batch` accepts 1–10 unique MP4/MOV source assets in one writable project. It validates each asset, model readiness and per-item rights attestation, then atomically queues individually tracked jobs. An `Idempotency-Key` makes retries safe; this is queue fan-out, not parallel GPU execution.
- Defaults: maximum 1,800 frames, 600 seconds, 40 million output pixels, 2 GiB input, 4 GiB output, sequential GPU inference and a two-hour total job budget. Frame and duration ceilings can be adjusted with `AI_VIDEO_UPSCALE_MAX_FRAMES` and `AI_VIDEO_UPSCALE_MAX_DURATION_SECONDS`; output pixels use `AI_VIDEO_UPSCALE_MAX_OUTPUT_PIXELS`.
- Only MP4 and QuickTime/MOV containers with constant-frame-rate, 8-bit SDR YUV 4:2:0/4:2:2/4:4:4 sources are accepted. VFR, HDR and unsupported pixel formats fail closed rather than silently changing timing or color depth.
- Source media is never overwritten. Temporary extracted/enhanced frames are removed after success or failure. Partial output files are removed on cancellation, validation failure or provenance-publication failure.
- Automatic NCNN tile fallback remains available when `tile: 0` is selected. The derivative records the count and first 100 frame indexes that needed fallback; explicit tile choices remain authoritative. Thread plans and TTA settings are included in processing provenance.
- The first release is an explicit worker/API capability. A UI control must not be shown as available until the server feature flag and worker readiness checks pass.

### Optional paired-reference LPIPS

LPIPS is a learned perceptual distance, not a no-reference artifact detector. Lower distances indicate greater perceptual similarity for the supplied pair; a score is not a universal quality grade and must not automatically approve a derivative. The adapter requires candidate and reference images at exactly matching dimensions (minimum 64×64), defaults to an 8,294,400-pixel ceiling, and refuses configured limits above 16 million pixels to bound tensor memory, plus locally installed Python packages and cached pretrained backbone weights.

- Install a compatible local Python environment with PyTorch, torchvision, LPIPS and Pillow. Match the PyTorch/torchvision build to the worker's CPU or CUDA runtime.
- Provision the selected torchvision backbone weights into the local Torch Hub checkpoint cache during a controlled image-build/setup step. Runtime downloads are explicitly blocked; missing weights return `AI_UPSCALE_LPIPS_UNAVAILABLE`.
- Select the Python executable with `AI_UPSCALE_LPIPS_PYTHON` if `python3` is not the correct runtime.
- Run `npm run assess:upscale-pair -- <candidate-image> <same-resolution-reference-image> [alex|vgg|squeeze] [auto|cpu|cuda]` to produce a paired report. `alex` is the default forward metric; `vgg` and `squeeze` are selectable alternatives.
- Do not resize the low-resolution source and call it ground truth. Use a genuine aligned high-resolution reference from a benchmark dataset or a controlled capture. The command returns LPIPS alongside seam/PSNR/global-SSIM diagnostics; it never clears human review.

The Python process is launched without a shell, with bounded execution time and output, and offline flags. It rejects symlinked files, mismatched dimensions, unsupported sizes, non-finite scores and worker responses that claim downloads are enabled. This is an opt-in local assessment path; the production worker does not silently install Python dependencies, fetch model weights, or invent a reference image.

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

Every AI-upscale derivative receives a bounded automated visual assessment after generation and Content Credentials preservation. The current assessor reports deterministic pixel-gradient seam findings and, only when an aligned reference image is supplied, explicitly named global RGB SSIM and PSNR values. LPIPS is optional and requires a genuine aligned high-resolution reference plus a pre-provisioned offline Python model environment. The assessor does not classify all artifact types and does not issue an automated quality pass. Assessment failures are recorded as `assessment_unavailable`; they do not invalidate an otherwise structurally valid derivative, but they add a review reason. Every derivative keeps `qualityReviewRequired: true` until signed human review evidence satisfies the separate quality-evidence contract. Structural validation, correct dimensions, hashes, and automated seam heuristics are not substitutes for perceptual approval. Automatic tile fallback adds a second review reason, not proof of a bad image: downstream review should inspect tile boundaries and fine detail before approval. Explicit operator tile choices are never silently changed.

Benchmark and review timestamps must use an explicit RFC 3339 date-time with a timezone (UTC `Z` or numeric offset); date-only, timezone-free and non-string timestamps are rejected to avoid runtime-dependent parsing.

Human review timestamps must be at or after the benchmark execution timestamp and may not be more than five minutes in the future, allowing limited clock skew while rejecting pre-dated or implausibly future-dated approvals.

Every accepted derivative includes streaming SHA-256 digests for both the original source (`sourceSha256`) and generated output (`outputSha256`). The source digest is recomputed after inference and compared before accepting the derivative; a changed source causes rejection and cleanup. Store these digests with the asset lineage record and use them for integrity verification, not as a substitute for perceptual quality review.

The adapter validates image structure, dimensions, output byte/pixel budgets, alpha preservation, source identity, and output scale before accepting a derivative. Failed outputs are removed.

An execution self-test proves that the configured executable produced a structurally valid derivative. It does **not** prove perceptual quality. `inferenceVerified` remains false until representative model/worker inference has been benchmarked and image quality has been reviewed separately.

## Supported CLI boundary

This adapter targets the NCNN/Vulkan CLI. Do not pass Python-only Real-ESRGAN options such as `--fp32`, `--outscale`, or GFPGAN flags to this executable. The NCNN CLI's documented options include `-t` tile size, `-j` worker counts, `-x` TTA, and `-f` output format.

Reference: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
