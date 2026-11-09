# AI Upscaling Worker Operations

The Real-ESRGAN NCNN/Vulkan adapter uses the upstream `-j load:proc:save` option to control image-load, processing, and image-save worker counts.

## GPU device selection

The adapter exposes the NCNN CLI `-g` option as `gpu`. The default `auto` lets NCNN select the Vulkan device. An explicit device index from `0` through `31` can be selected for hosts with multiple Vulkan devices. The chosen value is included in execution and self-test diagnostics. The adapter does not probe device capabilities or guarantee that a selected index is present; deployment validation must confirm that the configured worker can initialize that device.

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

The adapter validates image structure, dimensions, output byte/pixel budgets, alpha preservation, source identity, and output scale before accepting a derivative. Failed outputs are removed.

An execution self-test proves that the configured executable produced a structurally valid derivative. It does **not** prove perceptual quality. `inferenceVerified` remains false until representative model/worker inference has been benchmarked and image quality has been reviewed separately.

## Supported CLI boundary

This adapter targets the NCNN/Vulkan CLI. Do not pass Python-only Real-ESRGAN options such as `--fp32`, `--outscale`, or GFPGAN flags to this executable. The NCNN CLI's documented options include `-t` tile size, `-j` worker counts, `-x` TTA, and `-f` output format.

Reference: https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan
