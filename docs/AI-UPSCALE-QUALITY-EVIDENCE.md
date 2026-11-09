# AI Upscale Quality Evidence

Executive Visuals separates three different claims:

1. **Configured** — the NCNN/Vulkan executable and selected model files are readable.
2. **Execution verified** — a model-specific self-test completed successfully on the worker.
3. **Quality verified** — a complete, model-specific fixture benchmark passed human review.

All three states are required before the corresponding model preset becomes eligible for execution. The worker checks model installation, explicit enablement, the model-specific execution self-test and the model-specific reviewed benchmark both when rendering readiness and when accepting a job. A successful process exit, valid image header, or correct output dimensions is not proof of perceptual quality. The inference worker also pins the source file's device, inode, size and nanosecond timestamps before processing, then checks them again before accepting the derivative. If the source is replaced, modified, removed or changed into a symlink during inference, the derivative is deleted and the job fails closed.

## Local evidence file

The worker reads an operator-managed JSON file from the local filesystem when `GET /api/providers` is requested. Configure the server-side environment variable:

```text
AI_UPSCALE_QUALITY_EVIDENCE_PATH=/absolute/private/path/upscale-quality-evidence.json
```

The path must refer to a regular, non-symlink file no larger than 4 MiB. The reader opens the file without following symlinks where the host supports `O_NOFOLLOW`, checks the opened file descriptor, and enforces the byte limit again after reading. The file is read-only; the application does not write review evidence. Do not commit real review artifacts, private source media, or customer assets to Git.

The JSON document has one top-level `records` array.

Run `npm run verify:upscale-evidence` on the worker host to validate the configured file and print a sanitized per-model readiness report. Exit code `0` means at least one model has passed; `1` means the file is configured but no model passed; `2` means no evidence file is configured. The report does not print reviewer notes, evidence paths or source media.

## Generating a local execution benchmark

The benchmark runner creates execution records but never approves visual quality. Prepare a local manifest containing exactly one fixture for each required category:

```json
{
  "fixtures": [
    { "fixtureId": "portrait-01", "fixtureCategory": "portrait", "path": "fixtures/portrait.png", "scale": 4 },
    { "fixtureId": "texture-01", "fixtureCategory": "fine_texture", "path": "fixtures/texture.png", "scale": 4 },
    { "fixtureId": "text-01", "fixtureCategory": "text", "path": "fixtures/text.png", "scale": 4 },
    { "fixtureId": "animation-01", "fixtureCategory": "animation", "path": "fixtures/animation.png", "scale": 4 },
    { "fixtureId": "lowlight-01", "fixtureCategory": "low_light_noisy", "path": "fixtures/lowlight.png", "scale": 4 }
  ]
}
```

Run this only on an isolated local worker with the NCNN/Vulkan executable and model files already installed. Explicitly enable the local engine for this operator-invoked command:

```sh
AI_UPSCALE_ENABLED=true REALESRGAN_NCNN_PATH=/absolute/path/realesrgan-ncnn-vulkan REALESRGAN_MODEL_DIR=/absolute/path/models npm run benchmark:upscale -- realesrgan-x4plus ./benchmark-fixtures.json ./benchmark-output
```

The optional final argument selects the NCNN tile size: `128` is the default, `256` selects a larger explicit tile, and `0` selects the NCNN executable's automatic tile mode; if that attempt reports a recognized GPU-memory allocation failure, the worker retries with bounded smaller explicit tiles. For a controlled visual comparison, run the same pinned five fixtures and model into separate output directories at (for example) `128`, `256` and `0`. Review each report independently; do not combine records from different tile strategies into one five-fixture quality approval. Each report records the requested tile, actual tile, fallback flag and ordered attempts. The generated human-review package repeats these values on every fixture card and in `review-package.json`, so a reviewer can see whether a specific image used automatic tiling or a smaller fallback rather than relying on the benchmark's default setting.

The benchmark and review pipeline supports these four NCNN/Vulkan model identifiers, each with an independent five-fixture benchmark and human approval:

| Model | Intended content | Review emphasis |
| --- | --- | --- |
| `realesrgan-x4plus` | General photography and mixed imagery | Natural texture, faces, noise and invented detail |
| `realesrnet-x4plus` | General restoration with a smoother MSE-oriented result | Over-smoothing, texture loss and edge fidelity |
| `realesrgan-x4plus-anime` | Anime illustrations | Line continuity, flat-color boundaries and fine strokes |
| `realesr-animevideov3` | Animation/video frames | Frame-to-frame consistency, line stability and flicker |

These are upstream model names, not quality rankings. Choose the model by source content, and do not treat approval of one model as approval of another. The upstream NCNN executable exposes scale and tile options; this application validates requested output dimensions and records the actual tile path. NCNN's tiled crop-and-stitch processing can introduce block inconsistency, so reviewers must inspect tile boundaries as well as full-frame appearance. See the upstream [Real-ESRGAN usage and model notes](https://github.com/xinntao/Real-ESRGAN#portable-executable-files-ncnn).

The runner validates the exact five-category manifest and resolves and hashes every fixture (including its size bound) before probing or self-testing the model, so a missing, oversized or unsafe later fixture cannot waste a GPU self-test or partial inference run. It rechecks each fixture immediately before inference, executes all five fixtures, checks exact output dimensions, hashes the executable, model files, inputs and outputs, and confirms those artifacts did not change during the run. It stores output images in a unique run folder and writes a separate JSON report. It rejects symlinked fixtures and unsafe paths.

Every generated record records its requested tile size, final tile size, fallback flag and ordered tile attempts. This is required to reproduce the exact execution path and interpret tile-boundary artifacts during review. The current benchmark uses an explicit 128-pixel tile; automatic tile fallback is tested separately and is never silently substituted for an explicit tile selection. The benchmark validator also requires the attempt history to begin with the requested tile, end with the recorded final tile, and agree with the fallback flag: multiple attempts require fallback=true, while a single attempt cannot claim fallback. Fallback is also rejected for explicit non-zero tile requests because the adapter never silently changes an operator-selected tile. This prevents contradictory execution histories from entering review packages.

Every generated record deliberately has `qualityReview: "not_reviewed"`. Compare each source/output pair at native and enlarged viewing scales, record visible artifacts, text/edge integrity, detail retention, noise behavior and temporal consistency where relevant, then add the required human-review fields and review-artifact digest. Only after a genuine review may the records be copied into the configured evidence file. A successful benchmark command is not permission to enable production inference. Each model must have a distinct, complete set of records covering all five categories:

- `portrait`
- `fine_texture`
- `text`
- `animation`
- `low_light_noisy`

Every record must include the benchmark fields validated by `server/upscale-benchmark.mjs`, including pinned model/version, executable and model-file SHA-256 hashes, source/output hashes, integer dimensions, exact scale, duration, execution status and timestamp. Successful outputs must exactly match the declared 2×, 3× or 4× dimensions.

Within each model's five-fixture benchmark summary, every record must use the same `model`, `modelVersion`, `binarySha256` and `modelFilesSha256`. A benchmark that mixes model versions, executable builds or model weights is invalid even when each fixture record is otherwise valid. Re-run all five fixtures against one pinned artifact set rather than combining records from different runs.

Every passing review must additionally include the exact field names enforced by `server/upscale-benchmark.mjs`:

- `qualityReview: "reviewed_pass"`
- `qualityReviewer`: stable reviewer identifier
- `qualityReviewedAt`: ISO-8601 timestamp
- `qualityReviewNotes`: substantive notes of at least 20 characters
- `qualityReviewArtifactPath`: relative path to the actual review report/artifact, stored beside the evidence JSON
- `qualityReviewArtifactSha256`: SHA-256 digest of the artifact bytes

The evidence loader opens each referenced artifact as a regular non-symlink file beneath the evidence directory, enforces a 25 MiB limit, and recomputes its SHA-256. Missing files, traversal paths, symlinks, oversized artifacts or changed bytes invalidate the model review. A digest-shaped string alone is not accepted as proof that a review artifact exists.

Optional SSIM and LPIPS values must be normalized to the 0–1 range. Do not invent metric values when no suitable reference exists. A review artifact should document the source/output comparison and the checks performed.

## Model isolation

Evidence is grouped and evaluated independently by model. A passing general-purpose model review does not approve the anime model, and vice versa. Each model needs its own complete five-category fixture set and review artifacts.

The API exposes only each model's readiness state and a short reason. It does not return reviewer notes, evidence-file paths, source media, or the evidence document.

## Fail-closed behavior

The model remains unavailable when the file is missing, malformed, oversized, symlinked, incomplete, invalid, or contains an unreviewed/rejected record. Presets remain visible but disabled in the Asset Library with the relevant blocker. The authenticated job-creation API independently enforces the same per-model evidence gate, so direct API requests cannot bypass the disabled UI.

This evidence file does not install model weights, enable `AI_UPSCALE_ENABLED`, run inference, or authorize remote AI spending. Production workers must remain disabled until the worker executable, model files, execution self-test, benchmark evidence, derivative storage, cancellation, provenance and capacity have all been independently verified.


## GPU-memory recovery and tile provenance

The local NCNN adapter starts with the requested tile setting. When the operator leaves tile size at automatic (`0`), the worker retries only recognized GPU-memory allocation failures with progressively smaller tiles: 256, 192, 128, 96, 64, then 32. It does not retry generic process failures. Explicit non-zero tile selections are never silently changed.

Every retry removes any partial output from the failed attempt before starting the next one. If a run succeeds, the actual tile, requested tile, fallback flag and ordered tile attempts are attached to the derivative's processing metadata. If output validation fails, the invalid output is removed and no derivative is published.

Smaller tiles reduce peak GPU memory use but may introduce tile-boundary inconsistencies; inspect large flat areas, fine textures and high-contrast edges during visual review. This recovery behavior is an execution reliability aid, not a quality improvement or a substitute for human approval.

## Preparing a human visual-review package

After a five-fixture execution benchmark succeeds, create an offline review folder with the exact source/output files whose SHA-256 digests appear in the report:

```sh
npm run review:upscale -- ./benchmark-output/upscale-benchmark-realesrgan-x4plus-REPORT.json ./benchmark-fixtures.json ./benchmark-output/run-RUN_ID ./upscale-review
```

The output folder must not already exist. The generator validates the report, five-category manifest, pinned model artifacts, source/output hashes, safe regular files and size limits before copying the images. It creates a standalone `review.html` with an interactive reveal slider, per-fixture decisions and notes, plus an exportable review-notes JSON and checksum manifest. Copied assets are re-hashed after copying. The package always reports `qualityVerified: false`; it cannot update the private evidence file or approve a model. An authorized reviewer must inspect all images, validate and hash the review artifact, then update the private evidence file through the established process.

## Model isolation

Evidence is grouped and evaluated independently by model. A passing general-purpose model review does not approve the anime model, and vice versa. Each model needs its own complete five-category fixture set and review artifacts.

The API exposes only each model's readiness state and a short reason. It does not return reviewer notes, evidence-file paths, source media, or the evidence document.

## Fail-closed behavior

The model remains unavailable when the file is missing, malformed, oversized, symlinked, incomplete, invalid, or contains an unreviewed/rejected record. Presets remain visible but disabled in the Asset Library with the relevant blocker. The authenticated job-creation API independently enforces the same per-model evidence gate, so direct API requests cannot bypass the disabled UI.

This evidence file does not install model weights, enable `AI_UPSCALE_ENABLED`, run inference, or authorize remote AI spending. Production workers must remain disabled until the worker executable, model files, execution self-test, benchmark evidence, derivative storage, cancellation, provenance and capacity have all been independently verified.


## GPU-memory recovery and tile provenance

The local NCNN adapter starts with the requested tile setting. When the operator leaves tile size at automatic (`0`), the worker retries only recognized GPU-memory allocation failures with progressively smaller tiles: 256, 192, 128, 96, 64, then 32. It does not retry generic process failures. Explicit non-zero tile selections are never silently changed.

Every retry removes any partial output from the failed attempt before starting the next one. If a run succeeds, the actual tile, requested tile, fallback flag and ordered tile attempts are attached to the derivative's processing metadata. If output validation fails, the invalid output is removed and no derivative is published.

Smaller tiles reduce peak GPU memory use but may introduce tile-boundary inconsistencies; inspect large flat areas, fine textures and high-contrast edges during visual review. This recovery behavior is an execution reliability aid, not a quality improvement or a substitute for human approval.


## Structured reviewer rubric

The standalone review page exports rubric decisions for each fixture under protocol `ev-upscale-rubric-v1`. Reviewers must assess detail retention, edge/text integrity, halos/ringing/artifacts, color/tonal consistency, and natural appearance. Each item must be marked acceptable, issue found, or not applicable before export. A fixture cannot be marked Pass when any rubric item is marked issue found; record a Fail and explain the defect instead. Notes must remain substantive (at least 20 characters) for every fixture. The browser export control remains disabled until all five fixtures satisfy the review rules and a reviewer name of 2–120 characters is entered; readiness is announced through an accessible status message. This is a usability guard only—the server-side validator remains authoritative.

The rubric is a review aid, not an automated quality score. A reviewer must inspect the source/output pair at fit-to-screen and 100% zoom and consider category-specific risks such as facial identity, fine texture, small text, temporal flicker, and low-light noise. PSNR, SSIM, LPIPS and no-reference IQA scores may be useful supporting measurements, but no metric should override visible structural defects or the human decision. Recent super-resolution research reports that conventional metrics can disagree with human preferences, so the package deliberately keeps execution evidence, rubric responses and formal model approval separate.


## Server-side review export validation

The review package module exposes `validateUpscaleHumanReviewNotes(notes, reviewManifest)` for trusted server-side verification before an exported browser review is considered for the private evidence record. It requires the exact five manifest fixtures, matching categories and SHA-256 source/output checksums, a supported model and protocol, reviewer identity, timestamp, substantive notes, all five rubric decisions, and consistency between Pass decisions and issue flags. It rejects any attempt to set `qualityVerified: true`; successful validation only establishes that the submitted review is structurally complete and bound to the package assets. It does not independently prove that the reviewer inspected the images or certify quality. Authorization, durable reviewer identity, artifact hashing, and an approved evidence-record update remain separate controls.


## Metric interpretation and perceptual benchmarking

Keep restoration fidelity and perceptual preference as separate evaluation tracks. PSNR and SSIM can describe reference fidelity; LPIPS and other learned perceptual metrics provide complementary signals, but none is a universal quality verdict. The CVPR 2026 super-resolution evaluation study reports that common metrics can correlate weakly or negatively with human preference in some settings and proposes a relative quality comparison framework. The NTIRE 2026 x4 challenge likewise separates restoration and perceptual tracks rather than collapsing them into one score. For Executive Visuals, preserve the raw metric values, reference/registration context, model and artifact identity, and reviewer decision independently. Do not label a derived composite or RQI score as validated until its implementation, calibration data, and human-agreement tests are present.

Research references:
- CVPR 2026, *Bridging the Perception Gap in Image Super-Resolution Evaluation*: https://openaccess.thecvf.com/content/CVPR2026/html/Su_Bridging_the_Perception_Gap_in_Image_Super-Resolution_Evaluation_CVPR_2026_paper.html
- NTIRE 2026 x4 super-resolution challenge: https://arxiv.org/abs/2604.14558
- SR-Prominence artifact evaluation dataset/protocol: https://arxiv.org/abs/2605.14847
