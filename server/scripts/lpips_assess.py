#!/usr/bin/env python3
"""Offline-only paired-image LPIPS assessor. Model weights must already be cached."""
import argparse
import json
import math
import sys
from pathlib import Path


def fail(message, code=2):
    print(json.dumps({"ok": False, "error": message}), file=sys.stderr)
    raise SystemExit(code)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--net", choices=("alex", "vgg", "squeeze"), default="alex")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--max-pixels", type=int, default=40000000)
    parser.add_argument("--threads", type=int, default=1)
    args = parser.parse_args()

    if args.max_pixels < 1 or args.max_pixels > 40000000 or args.threads < 1 or args.threads > 8:
        fail("Resource limits are outside the supported range.")

    candidate_path = Path(args.candidate)
    reference_path = Path(args.reference)
    for label, path in (("candidate", candidate_path), ("reference", reference_path)):
        try:
            if path.is_symlink() or not path.is_file():
                fail(label + " must be a regular non-symlink file.")
            if path.stat().st_size < 1 or path.stat().st_size > 250 * 1024 * 1024:
                fail(label + " is empty or exceeds the 250 MiB file limit.")
        except OSError as exc:
            fail(label + " cannot be accessed: " + str(exc))

    try:
        import numpy as np
        import torch
        import lpips
        from PIL import Image
    except Exception as exc:
        fail("LPIPS dependencies are unavailable: " + str(exc))

    cache = Path(torch.hub.get_dir()) / "checkpoints"
    cache.mkdir(parents=True, exist_ok=True)
    expected = {
        "alex": "alexnet-owt-7be5be79.pth",
        "vgg": "vgg16-397923af.pth",
        "squeeze": "squeezenet1_1-b8a52dc0.pth",
    }[args.net]
    if not (cache / expected).is_file():
        fail("Pretrained " + args.net + " backbone weights are not cached. Provision weights offline; this assessor never downloads models.")

    original_loader = torch.hub.load_state_dict_from_url
    def cached_only(url, *positional, **kwargs):
        filename = kwargs.get("file_name") or str(url).rsplit("/", 1)[-1]
        if not (cache / filename).is_file():
            raise RuntimeError("Required pretrained weights are not present in the local cache: " + filename)
        return original_loader(url, *positional, **kwargs)
    torch.hub.load_state_dict_from_url = cached_only

    try:
        with Image.open(candidate_path) as image:
            candidate = image.convert("RGB")
        with Image.open(reference_path) as image:
            reference = image.convert("RGB")
    except Exception as exc:
        fail("Could not decode candidate/reference image: " + str(exc))

    if candidate.size != reference.size:
        fail("Candidate and reference dimensions must match exactly; resize only through an explicit benchmark preprocessing step.")
    width, height = candidate.size
    if width < 64 or height < 64 or width * height > args.max_pixels:
        fail("Image dimensions are below LPIPS minimum or exceed the pixel budget.")

    try:
        torch.set_num_threads(args.threads)
        if args.device == "cuda":
            if not torch.cuda.is_available():
                fail("CUDA was requested but is unavailable.")
            device = "cuda"
        else:
            device = "cuda" if args.device == "auto" and torch.cuda.is_available() else "cpu"

        model = lpips.LPIPS(net=args.net, version="0.1").eval().to(device)
        def tensor(image):
            pixels = np.asarray(image, dtype=np.uint8).copy()
            return torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0).float().div(127.5).sub(1.0).to(device)

        with torch.inference_mode():
            distance = float(model(tensor(candidate), tensor(reference)).mean().item())
        if not math.isfinite(distance) or distance < 0:
            fail("LPIPS returned a non-finite or negative distance.")
        print(json.dumps({
            "ok": True,
            "metric": "LPIPS",
            "version": "0.1",
            "network": args.net,
            "device": device,
            "distance": distance,
            "width": width,
            "height": height,
            "interpretation": "lower_is_more_perceptually_similar",
            "modelDownloadsAllowed": False,
        }, separators=(",", ":")))
    except SystemExit:
        raise
    except Exception as exc:
        fail("LPIPS inference failed: " + str(exc))


if __name__ == "__main__":
    main()
