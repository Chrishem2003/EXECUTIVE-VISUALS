# AI Upscaling Worker Operations

This runbook describes the guarded worker-side inference verification path. It does not install models, enable GPU execution, or invoke a paid provider.

## Safety defaults

- `AI_UPSCALE_ENABLED` remains opt-in and must be set to `true` on the worker that will execute enhancement jobs.
- Configure `REALESRGAN_NCNN_PATH` and `REALESRGAN_MODEL_DIR` only when the NCNN/Vulkan executable and allowlisted model files are already installed on that worker.
- No model weights or executable are bundled or downloaded automatically.
- The provider catalog reports the capability as `unverified` until the current worker process completes a real inference self-test.
- Verification is held in process memory and is invalidated by a worker restart or a change to the engine/model file size or modification time. Run the self-test again after a restart or model replacement.
- A successful inference self-test proves execution and output-format validity, not perceptual quality, artifact absence, or production suitability. Human review remains required.

## Administrator allowlist

Set `AI_UPSCALE_ADMIN_EMAILS` to a comma-separated list of normalized account email addresses permitted to run the test. The endpoint fails closed when the setting is empty or the authenticated account is not listed.

Example (use real, approved operator addresses in the deployment environment; do not commit them):

```env
AI_UPSCALE_ENABLED=false
AI_UPSCALE_ADMIN_EMAILS=
REALESRGAN_NCNN_PATH=
REALESRGAN_MODEL_DIR=
```

Keep the defaults above until the worker has been provisioned and the operator has explicitly approved GPU execution.

## Run a self-test

1. Sign in as an allowlisted administrator.
2. Upload a small PNG, JPEG, or WebP image (maximum 5 MB) through the authenticated asset-upload flow. The asset must be accessible to the administrator with editor-level permission.
3. After the worker is provisioned and `AI_UPSCALE_ENABLED=true` is intentionally set, send an authenticated JSON request:

```http
POST /api/admin/ai-upscale/self-test
Content-Type: application/json

{
  "sourceAssetId": "00000000-0000-4000-8000-000000000000",
  "model": "realesrgan-x4plus",
  "scale": 2
}
```

The ID above is a placeholder; use the ID returned by the upload API. Allowed scales are 2, 3, and 4. The self-test writes its output to a unique temporary directory and removes that directory whether the test passes or fails.

A successful response includes `selfTest.passed=true` and `selfTest.inferenceVerified=true`. A failed run returns a bounded error response and records an audit event. The source asset is never overwritten.

4. Read `GET /api/providers` again. The local AI-upscale provider should become `ready` only after the self-test passes in that same worker process.

## Operational boundaries

- Do not enable this feature on a production worker until its binary, model provenance, GPU/Vulkan runtime, resource limits, storage capacity, and rollback path have been reviewed.
- The self-test is synchronous and may take up to the configured engine timeout. Keep test images small and run it during a controlled maintenance window.
- A passing test does not replace output dimension/decode checks, provenance capture, asset review, or approval gates in the media job pipeline.
- If the worker is horizontally scaled, each process must pass its own self-test. A readiness result on one process is not proof that another process is ready.
