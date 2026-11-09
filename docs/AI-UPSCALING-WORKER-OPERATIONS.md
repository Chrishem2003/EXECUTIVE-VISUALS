# AI Upscaling Worker Operations

The Real-ESRGAN NCNN/Vulkan adapter uses the upstream `-j load:proc:save` option to control image-load, processing, and image-save worker counts.

## Safe thread tuning

- Default: `1:2:2` (conservative worker profile).
- Format: three integer values, `load:proc:save`.
- Each value must be between 1 and 4.
- Combined total must not exceed 8.
- The adapter passes the value as a separate argv item; it never invokes a shell.
- Invalid values fail before the executable is launched.

Keep the default for memory-constrained GPUs. Increasing worker counts can improve throughput for some batches but can also increase memory pressure; benchmark on the target worker before changing defaults.

## Tile fallback

Tile size `0` requests the NCNN engine's automatic selection. If a recognized GPU allocation failure occurs, the adapter retries with progressively smaller explicit tiles. All attempts share one overall job deadline. An explicitly selected nonzero tile is never silently changed.

Successful and failed jobs expose the requested tile, attempted tiles, effective tile (on success), and whether fallback occurred.

## Output and quality gates

The adapter validates image structure, dimensions, output byte/pixel budgets, alpha preservation, source identity, and output scale before accepting a derivative. Failed outputs are removed.

An execution self-test proves that the configured executable produced a structurally valid derivative. It does **not** prove perceptual quality. `inferenceVerified` remains false until representative model/worker inference has been benchmarked and image quality has been reviewed separately.

## Supported CLI boundary

This adapter targets the NCNN/Vulkan CLI. Do not pass Python-only Real-ESRGAN options such as `--fp32`, `--outscale`, or GFPGAN flags to this executable. The NCNN CLI's documented options include `-t` tile size, `-j` worker counts, `-x` TTA, and `-f` output format.

Reference: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
