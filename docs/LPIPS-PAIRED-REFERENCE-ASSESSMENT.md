# Offline paired-reference LPIPS assessment

Executive Visuals includes an optional command-line LPIPS evaluator for comparing an enhanced image with a genuine, aligned high-resolution reference.

## Run

```bash
npm run assess:upscale-pair -- <candidate-image> <same-resolution-reference-image> [alex|vgg|squeeze] [auto|cpu|cuda]
```

The evaluator requires a locally provisioned Python environment with compatible PyTorch, torchvision, LPIPS, NumPy and Pillow packages. The selected pretrained backbone checkpoint must already exist in the local Torch Hub cache.

Set `AI_UPSCALE_LPIPS_PYTHON` to the intended Python executable if `python3` is not correct.

## Safety and interpretation

- The command compares two explicit image paths; it never invents or resizes a reference.
- Candidate and reference dimensions must match exactly and be at least 64×64.
- The default ceiling is 8,294,400 pixels; the hard ceiling is 16 million pixels.
- Files must be regular, non-symlink files no larger than 250 MiB each.
- Python runs without a shell, with a bounded timeout and output size.
- Hugging Face and Transformers offline flags are set, and the Python bridge refuses to download missing pretrained weights.
- LPIPS is a learned perceptual distance: lower is more perceptually similar for the supplied pair. It is not a universal quality score, no-reference detector, or approval signal.
- A completed metric never bypasses the application's mandatory human review or delivery gates.

This is an opt-in local assessment utility. It does not install Python packages, download checkpoints, enable remote execution, or change production worker configuration.
