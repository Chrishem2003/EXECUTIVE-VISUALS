# AI upscaling integrity and quality gate

## Purpose

Executive Visuals treats image enhancement as a provenance-preserving media transformation. A successful process exit is not proof that a usable, correctly scaled, visually improved image was produced.

## Runtime checks

The Real-ESRGAN NCNN adapter:

- Accepts only allowlisted model names and PNG/JPEG/WebP output formats.
- Uses a shell-free process invocation with a bounded timeout and cancellation.
- Requires the source to be a readable regular file and refuses existing output targets.
- Reads PNG, JPEG and WebP image headers and extracts source dimensions before launching inference.
- Rejects malformed dimensions, dimensions above 32,768 pixels per side, and images above 100 million pixels.
- Validates the output container signature and decoded header dimensions.
- Requires output width and height to equal the source dimensions multiplied by the requested 2×, 3× or 4× scale.
- Applies a byte-size ceiling and never overwrites the source.
- Reports execution verification separately from independent visual-quality verification.

These are structural integrity checks. They do not establish perceptual quality, faithful detail recovery, absence of hallucinated texture, or suitability for a particular creative use.

## Model selection

Use a model matched to the source content rather than one universal preset:

- General photographs: `realesrgan-x4plus` or a general-scene model after adapter support is explicitly added and tested.
- Anime and illustration: anime-specific model; do not apply face-restoration models intended for real faces.
- Noisy/low-light imagery: compare restoration and denoising strength carefully; inspect texture loss and invented detail.

The upstream Real-ESRGAN project documents general and anime-specific models, arbitrary output scales, tiling, and its warning that tiled NCNN inference can introduce block inconsistencies. See [upstream model and inference guidance](https://github.com/xinntao/Real-ESRGAN).

## Benchmark protocol

A quality-verification candidate must include independently captured records for all five fixture categories:

1. Portrait and facial detail.
2. Fine texture and natural detail.
3. Text, logos and graphic edges.
4. Animation and illustration.
5. Low-light and noisy source material.

Each benchmark record pins SHA-256 hashes for the source, output, executable, and model files; records source/output dimensions, scale, model version, duration and execution result; and distinguishes `not_reviewed`, `reviewed_pass` and `reviewed_fail`. A reviewed record must also include a reviewer identifier, review timestamp, substantive review notes (at least 20 characters), and a SHA-256 digest of the review artifact. LPIPS and SSIM values are constrained to the normalized 0–1 range.

A reviewer must compare source, output and a suitable reference where one exists. Review should consider:
- Real detail recovery versus invented detail.
- Face identity and geometry preservation.
- Texture, edge and text fidelity.
- Ringing, halos, oversharpening and tile seams.
- Noise suppression versus loss of natural detail.
- Color, alpha and orientation preservation.
- Temporal consistency for frame sequences.

PSNR/SSIM/LPIPS values may be recorded when a trusted reference exists, but they are not substitutes for review and should not be fabricated for unpaired real-world imagery.

## Release gate

The benchmark summary remains `qualityVerified: false` until every required category has at least one valid, successful, human-reviewed passing record, with no failed, rejected, unreviewed or invalid records.

Do not claim that AI upscaling is production-quality merely because:
- the binary is installed;
- a self-test exits successfully;
- the output has a valid image header; or
- the output dimensions match the requested scale.

## Deployment boundary

Do not enable remote inference or incur provider charges to satisfy this gate. Run local/isolated tests first. Keep AI upscaling disabled on production workers until executable/model availability, worker capacity, source/derivative storage, provenance, cancellation, and quality review have all been verified.
