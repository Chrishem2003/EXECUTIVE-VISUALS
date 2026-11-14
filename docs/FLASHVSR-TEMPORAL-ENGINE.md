# FlashVSR Temporal Video Super-Resolution

## Status and safety

The application includes an isolated adapter for the official OpenImagingLab FlashVSR v1.1 tiny-long inference path. It is disabled by default and is not available on the hosted Render Free deployment unless a compatible local CUDA worker, the official source checkout, model weights, and a successful operator-run inference self-test are separately provisioned.

No model code, checkpoints, Python packages, CUDA toolkit, or GPU capacity is downloaded or purchased automatically. The feature does not make remote provider calls. Existing Real-ESRGAN framewise processing remains a separate engine.

## Upstream and license

- Upstream: https://github.com/OpenImagingLab/FlashVSR
- Code and v1.1 checkpoint repository declare Apache-2.0: https://huggingface.co/JunhaoZhuang/FlashVSR-v1.1
- Model weights: use the upstream FlashVSR v1.1 checkpoint distribution and retain its accompanying model card/terms. The bridge does not redistribute weights.
- Selected entry point: \`examples/WanVSR/infer_flashvsr_v1.1_tiny_long_video.py\`
- The bridge imports upstream pipeline classes/functions at runtime; it does not copy or patch upstream implementation files.

The official repository documents Python 3.11.13, PyTorch 2.6.0+cu124, CUDA, bfloat16 inference and a separately installed Block-Sparse Attention backend. Its own notes identify A100/A800 as tested acceleration targets and H200 as supported with reduced acceleration; other GPU families are not guaranteed. Published performance figures are upstream claims, not Executive Visuals benchmarks.

## Provisioning (operator-managed)

Provision these components on an isolated GPU worker, not on the web/API process:

1. A clean Python 3.11 environment compatible with the upstream pinned dependencies.
2. A checkout of the official FlashVSR repository.
3. From that checkout, install the upstream package and pinned requirements with \`pip install -e .\` and \`pip install -r requirements.txt\`.
4. The official Block-Sparse Attention backend installed in that same environment, following the upstream build instructions. This is a separate dependency and is not installed by this application.
5. The FlashVSR v1.1 model files in \`examples/WanVSR/FlashVSR-v1.1/\`:
   - \`diffusion_pytorch_model_streaming_dmd.safetensors\`
   - \`LQ_proj_in.ckpt\`
   - \`TCDecoder.ckpt\`
   - \`Wan2.1_VAE.pth\`
6. FFmpeg and FFprobe available to the worker.

Set the following server environment variables only after provisioning:

- \`FLASHVSR_PYTHON\`: absolute path to the environment's Python executable.
- \`FLASHVSR_ROOT\`: absolute path to the official FlashVSR checkout.
- \`FLASHVSR_MODEL_DIR\`: absolute path to \`examples/WanVSR/FlashVSR-v1.1\` (optional if using the default).
- \`FLASHVSR_ENABLED=true\`: explicit administrator opt-in after staging validation.
- \`FLASHVSR_SELF_TEST_PASSED=true\`: operator attestation set only after a real, representative local GPU inference and output inspection have passed.
- \`FLASHVSR_QUALITY_EVIDENCE_PASSED=true\`: separate operator attestation set only after the controlled staging benchmark and blinded human review pass; it is not implied by model readiness or a successful smoke test.
- \`AI_VIDEO_UPSCALE_ENABLED=true\`: existing video-upscale feature gate.

The readiness API checks the Python runtime, CUDA/bfloat16 availability, imports, upstream entry point and required checkpoint files. Readiness alone is not a successful model execution test. The adapter reports \`executionVerified=false\` until the operator sets the self-test attestation, and does not report ready until the separate quality-evidence attestation is set.

## Inference contract

The integration is 4× only. The upstream v1.1 long-video demo uses a 128-pixel output alignment and an 8-frame temporal window convention. The bridge:

- Rejects non-integer frame rates rather than silently changing cadence.
- Pads the right/bottom edge to a 32-pixel input multiple, then crops the model result back to the exact 4× source dimensions.
- Pads the tail with cloned frames to satisfy the upstream temporal-window convention, then trims back to the exact source frame count.
- Requires exactly one video stream and verifies output dimensions, frame count and frame rate.
- Returns video-only output; the application remuxes the original source audio/subtitle streams and then performs its existing codec, timestamp, checksum and provenance checks.
- Never overwrites the source asset.

The adapter subprocess uses argument arrays (no shell), byte-accurate stdout/stderr capture limits, a hard timeout and cancellation. Timeout, cancellation and capture-limit failures first request SIGTERM, then escalate to SIGKILL after a bounded grace period so an unresponsive model process cannot be left running. Temporary input/output files are scoped to a per-job temporary directory and removed on completion or failure. Contract tests cover both timeout and cancellation escalation.

## API and UI

The Enhancement Lab offers two distinct choices:

- \`realesrgan-framewise\`: existing per-frame image-model path, 2× or 4×.
- \`flashvsr-v1.1-tiny-long\`: temporal video-model path, 4× only.

The authenticated batch API revalidates the selected engine and readiness for every source before atomically queuing the batch. FlashVSR jobs require both explicit enablement and the operator self-test attestation.

## Quality and release gates

FlashVSR is generative: it can invent plausible high-frequency detail rather than recover the exact lost original signal. This can alter faces, fine textures, text, graphics, animation and intentionally soft backgrounds. It must not be used as a fidelity-preserving enhancement without task-specific validation. A temporal architecture is not by itself a quality certificate. Every derivative remains subject to human review. The existing post-render signal checks are coarse luma/chroma and scene-cut-aware screening, not motion-compensated perceptual metrics.

Before enabling for users, run a controlled staging benchmark covering:
- Static detail, fine texture, fast motion, camera pans, occlusion and scene cuts.
- Frame-to-frame warping error / temporal LPIPS where a validated implementation is available.
- PSNR/SSIM on aligned paired references, plus perceptual metrics and blinded human review.
- Frame count, timestamps, audio sync, subtitles, colour, source checksum and output decode.
- Peak GPU memory, throughput, thermal stability and failure recovery on the actual target GPU.

No benchmark score, GPU compatibility or model inference success is claimed by the adapter contract tests. The live app's Render Free worker is not an appropriate FlashVSR inference target.
