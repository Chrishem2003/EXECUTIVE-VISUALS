# AI Upscale Worker Operations

This runbook separates worker installation, execution readiness, and image-quality acceptance. A green preflight is not proof that an installed model produces good images.

## Read-only worker preflight

Run on the actual cloud media worker host, from the repository root:

```bash
npm run check:upscale-worker
```

The command prints a JSON report and exits with status 2 when a required gate is missing. It does not download binaries or model weights, enable the worker, contact a paid provider, or modify application data. When `AI_UPSCALE_ENABLED=true` and `UPSCALE_SELF_TEST_IMAGE` points to a licensed local PNG fixture, it also runs a real worker-local inference self-test and records the result for that process. Configure `UPSCALE_SELF_TEST_SCALE` (default 2) and `UPSCALE_SELF_TEST_TILE` (default 0) if needed. It checks:

- FFmpeg and FFprobe are discoverable on PATH.
- The configured Real-ESRGAN NCNN/Vulkan executable is a regular file.
- The selected allowlisted model has both `.param` and `.bin` files.
- `AI_UPSCALE_ENABLED=true` is explicitly configured.
- The engine executable and model hashes match an operator-maintained provenance manifest (`UPSCALE_ENGINE_MANIFEST`).
- The engine has passed its worker-local execution self-test.
- The configured worker temporary directory is writable and supports same-directory hard-link publication.

## Worker configuration

Configure these values only on the isolated media worker service:

| Variable | Purpose |
| --- | --- |
| `REALESRGAN_NCNN_PATH` | Absolute path to the trusted NCNN/Vulkan executable |
| `REALESRGAN_MODEL_DIR` | Directory containing approved model `.param` and `.bin` files |
| `REALESRGAN_DEFAULT_MODEL` | Optional allowlisted model selection; defaults to `realesrgan-x4plus` |
| `AI_UPSCALE_ENABLED` | Explicit opt-in; leave false until the worker host is validated |
| `CLOUD_WORKER_TEMP_ROOT` | Existing writable worker-local temporary directory |
| `UPSCALE_ENGINE_MANIFEST` | Required path to an operator-maintained JSON manifest pinning engine/model SHA-256 hashes and recording source, release and license |
| `UPSCALE_SELF_TEST_IMAGE` | Optional path to a licensed PNG fixture for actual worker-local inference self-test |
| `UPSCALE_SELF_TEST_SCALE` | Optional self-test scale, default 2 |
| `UPSCALE_SELF_TEST_TILE` | Optional self-test tile size, default 0 |

Keep model and executable provenance in the deployment record. Pin trusted release artifacts and verify their checksums before installing. Do not put service-role credentials or provider keys in this runbook, build logs, or the web frontend.

## Acceptance sequence

1. Provision an isolated worker image with FFmpeg, FFprobe, the approved executable and model files.
2. Run the read-only preflight. Resolve every blocker on that same host.
3. Enable the worker's AI upscale flag only after the host and private storage are approved.
4. Set `UPSCALE_SELF_TEST_IMAGE` to a licensed, non-sensitive fixture and run the preflight. The self-test verifies actual execution and output structure; it does not certify perceptual quality.
5. Keep the manifest beside the worker deployment record and update it only after independently verifying the exact release source, license and installed hashes. A hash mismatch blocks readiness.
6. Register outputs from the required benchmark fixture categories: portrait, fine texture, text, animation, and low-light/noisy.
7. Require an independent reviewer to approve benchmark evidence. Keep model and binary hashes attached to every record.
8. Only then treat that pinned model build as quality-verified for the product capability catalogue.

## Important limitations

- The preflight intentionally reports `inferenceQualityVerified: false`. Quality requires fixture evidence and independent review.
- The preflight's hard-link result applies only to the filesystem tested on that worker.
- A passing local development test does not prove the cloud worker image, storage adapter, GPU/Vulkan driver, or model quality.
- Do not apply migrations, enable production workers, or route customer assets until the isolated end-to-end acceptance gates are complete.
