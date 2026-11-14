# Cloud video AI upscaling worker

## Integration status

The cloud media queue and executor support the `media.video-ai-upscale` job type. The feature is **disabled by default** and cannot be queued or executed until both worker gates below are explicitly enabled.

- `AI_VIDEO_UPSCALE_ENABLED=true`
- `AI_VIDEO_UPSCALE_WORKER_SELF_TEST_PASSED=true`

The second setting is an operator attestation, not an automatic inference claim. Set it only after the exact worker process has completed a real video inference smoke test using the installed NCNN/Vulkan executable, selected model weights and FFmpeg/FFprobe. The existing administrator image self-test alone does not prove that the video pipeline works.

The API also requires the existing image-model installation, enablement, execution self-test and model-specific five-category human-reviewed quality evidence. A configured key or a successful process exit does not qualify as quality evidence.

## Execution contract

- Uses sequential Real-ESRGAN image inference on extracted video frames.
- Creates a separate MP4 derivative; the source asset is never overwritten.
- Requires a single video stream, constant frame rate, supported 8-bit SDR pixel formats and verified source frame timestamps.
- Rejects HDR, variable-frame-rate, unsupported ancillary streams, excessive frame counts, durations, input/output sizes and output pixel budgets.
- Preserves audio streams when the source codec is safe to copy; otherwise transcodes audio to AAC and verifies codec, channel count and sample rate.
- Converts text subtitle streams to MP4-compatible `mov_text` and verifies the resulting subtitle count.
- Re-probes output dimensions, frame count, frame rate, codec and audio/subtitle stream profiles before publication.
- Pins the source digest and rejects source changes during processing.
- Publishes with derivative lineage, a checksum, C2PA preservation result and processing provenance under the worker's lease-fenced publication key.
- Reports temporal consistency as **not certified**. Coarse temporal signal analysis is only a screening aid; every result requires human review.

## Worker budgets

Defaults are deliberately bounded:

| Setting | Default |
|---|---:|
| `CLOUD_VIDEO_AI_UPSCALE_MAX_INPUT_BYTES` | 2 GiB |
| `CLOUD_VIDEO_AI_UPSCALE_MAX_OUTPUT_BYTES` | 4 GiB |
| `CLOUD_VIDEO_AI_UPSCALE_MAX_TEMP_BYTES` | 8 GiB |
| `CLOUD_VIDEO_AI_UPSCALE_MAX_OUTPUT_PIXELS` | 40 million |
| Maximum frames | 300 |
| Maximum duration | 600 seconds |

The worker honors a per-command output capture ceiling of 8 MB for frame timestamp and temporal-signal analysis. These limits do not imply that the current Render Free instance has sufficient compute, memory or temporary disk for production video inference.

## Deployment checklist

1. Install FFmpeg, FFprobe, the NCNN/Vulkan executable and the selected model files on the actual worker host.
2. Keep `AI_UPSCALE_ENABLED` disabled until image-model execution self-test and quality evidence are complete.
3. Run a real, non-sensitive video fixture through the exact cloud worker and verify output, audio/subtitles, lease recovery, cancellation and derivative publication.
4. Only then set both video worker gates on the worker and API service, using the same reviewed configuration.
5. Confirm the provider readiness panel reports the worker gates and the UI unlocks video enhancement.
6. Keep production disabled if any gate, private storage, durable database or worker capacity is missing.

No provider credentials, model downloads, production environment variables, paid infrastructure or deployment settings are changed by this code integration.
