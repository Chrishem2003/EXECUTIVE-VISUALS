#!/usr/bin/env python3
"""Isolated FlashVSR v1.1 tiny-long inference bridge.

This bridge imports the upstream Apache-2.0 implementation without copying or
modifying it. It never downloads code or model weights at runtime.
"""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile


REQUIRED_WEIGHTS = (
    "diffusion_pytorch_model_streaming_dmd.safetensors",
    "LQ_proj_in.ckpt",
    "TCDecoder.ckpt",
    "Wan2.1_VAE.pth",
)


def run_json(command):
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=600)
    return json.loads(result.stdout)


def probe(repo_root, model_dir):
    root = Path(repo_root).expanduser().resolve()
    wan = root / "examples" / "WanVSR"
    script = wan / "infer_flashvsr_v1.1_tiny_long_video.py"
    weights = Path(model_dir).expanduser().resolve()
    missing = [name for name in REQUIRED_WEIGHTS if not (weights / name).is_file()]
    checks = {"repository": root.is_dir(), "upstream_script": script.is_file(),
              "model_directory": weights.is_dir(), "missing_weights": missing}
    runtime = {"python": sys.version.split()[0], "cuda": False, "bfloat16": False,
               "torch": None, "gpu": None, "dependencies": False}
    reason = None
    try:
        import torch
        runtime["torch"] = torch.__version__
        runtime["cuda"] = bool(torch.cuda.is_available())
        if runtime["cuda"]:
            runtime["gpu"] = torch.cuda.get_device_name(torch.cuda.current_device())
            runtime["bfloat16"] = bool(torch.cuda.is_bf16_supported())
        import numpy
        import PIL
        import imageio
        import einops
        sys.path.insert(0, str(wan))
        sys.path.insert(0, str(root))
        import diffsynth
        from utils.TCDecoder import build_tcdecoder
        runtime["dependencies"] = True
    except Exception as exc:
        reason = type(exc).__name__ + ": " + str(exc)[:400]
    ready = all(checks[k] for k in ("repository", "upstream_script", "model_directory")) and not missing
    ready = ready and runtime["cuda"] and runtime["bfloat16"] and runtime["dependencies"]
    return {"available": bool(ready), "checks": checks, "runtime": runtime, "reason": reason,
            "license": "Apache-2.0", "model": "FlashVSR-v1.1-tiny-long",
            "executionVerified": False}


def ffprobe(path):
    return run_json(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                     "stream=codec_type,width,height,avg_frame_rate,nb_read_frames",
                     "-of", "json", str(path)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--scale", type=int, default=4)
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(probe(args.repo_root, args.model_dir)))
        return 0
    if not args.input or not args.output:
        parser.error("--input and --output are required for inference")
    if args.scale != 4:
        raise RuntimeError("Official FlashVSR v1.1 tiny-long integration supports 4x only")
    report = probe(args.repo_root, args.model_dir)
    if not report["available"]:
        raise RuntimeError("FlashVSR runtime is not ready: " + str(report.get("reason") or report["checks"]))
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    if not source.is_file() or source == output or output.exists():
        raise RuntimeError("Input must exist and output must be a new, distinct file")
    root = Path(args.repo_root).expanduser().resolve()
    wan = root / "examples" / "WanVSR"
    weights = Path(args.model_dir).expanduser().resolve()
    if weights != (wan / "FlashVSR-v1.1").resolve():
        raise RuntimeError("Place the verified v1.1 checkpoint directory at examples/WanVSR/FlashVSR-v1.1")
    meta = ffprobe(source)
    videos = [s for s in meta.get("streams", []) if s.get("codec_type") == "video"]
    if len(videos) != 1:
        raise RuntimeError("Exactly one source video stream is required")
    stream = videos[0]
    width, height = int(stream["width"]), int(stream["height"])
    frames = int(stream["nb_read_frames"])
    rate = stream.get("avg_frame_rate", "0/1")
    num, den = [int(x) for x in rate.split("/")]
    fps = num / den if den else 0
    if frames < 1 or fps <= 0 or abs(fps - round(fps)) > 0.0001:
        raise RuntimeError("FlashVSR integration requires a readable constant integer frame rate")
    padded_frames = frames + ((5 - frames % 8) % 8)
    pad_w = ((width + 31) // 32) * 32
    pad_h = ((height + 31) // 32) * 32
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ev-flashvsr-", dir=str(output.parent)) as tmp:
        tmpdir = Path(tmp)
        prepared = tmpdir / "prepared.mp4"
        model_output = tmpdir / "model-output.mp4"
        filters = [f"pad={pad_w}:{pad_h}:0:0:black"]
        if padded_frames > frames:
            filters.append(f"tpad=stop_mode=clone:stop={padded_frames - frames}")
        subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source),
                        "-map", "0:v:0", "-vf", ",".join(filters), "-an", "-sn", "-dn",
                        "-frames:v", str(padded_frames), "-r", str(round(fps)),
                        "-vsync", "cfr", "-c:v", "libx264", "-preset", "ultrafast",
                        "-crf", "0", "-pix_fmt", "yuv420p", str(prepared)],
                       check=True, capture_output=True, timeout=900)
        original_cwd = Path.cwd()
        os.chdir(wan)
        sys.path.insert(0, str(wan))
        sys.path.insert(0, str(root))
        try:
            upstream = wan / "infer_flashvsr_v1.1_tiny_long_video.py"
            spec = importlib.util.spec_from_file_location("ev_upstream_flashvsr", upstream)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            import torch
            pipe = module.init_pipeline()
            lq, target_h, target_w, model_frames, model_fps = module.prepare_input_tensor(
                str(prepared), scale=4.0, dtype=torch.bfloat16, device="cpu")
            if model_frames != padded_frames + 4 or model_fps != round(fps):
                raise RuntimeError("Upstream frame-window preparation did not preserve the padded sequence")
            video = pipe(prompt="", negative_prompt="", cfg_scale=1.0,
                         num_inference_steps=1, seed=0, LQ_video=lq,
                         num_frames=model_frames, height=target_h, width=target_w,
                         is_full_block=False, if_buffer=True,
                         topk_ratio=2.0 * 768 * 1280 / (target_h * target_w),
                         kv_ratio=3.0, local_range=11, color_fix=True)
            frames_out = module.tensor2video(video)
            module.save_video(frames_out, str(model_output), fps=round(fps), quality=6)
            del pipe, lq, video, frames_out
            torch.cuda.empty_cache()
        finally:
            os.chdir(original_cwd)
        generated = ffprobe(model_output)
        generated_video = [s for s in generated.get("streams", []) if s.get("codec_type") == "video"]
        if len(generated_video) != 1 or int(generated_video[0].get("nb_read_frames", 0)) != padded_frames:
            raise RuntimeError("FlashVSR output frame count differs from the padded input sequence")
        crop_filter = f"crop={width * 4}:{height * 4}:0:0"
        subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(model_output),
                        "-map", "0:v:0", "-vf", crop_filter, "-frames:v", str(frames),
                        "-r", str(round(fps)), "-fps_mode", "cfr", "-an",
                        "-c:v", "libx264", "-preset", "medium", "-crf", "16",
                        "-pix_fmt", "yuv420p", str(output)],
                       check=True, capture_output=True, timeout=1800)
    final = ffprobe(output)
    final_video = [s for s in final.get("streams", []) if s.get("codec_type") == "video"]
    if len(final_video) != 1:
        raise RuntimeError("FlashVSR output video stream is missing or ambiguous")
    result = final_video[0]
    if int(result.get("nb_read_frames", 0)) != frames:
        raise RuntimeError("FlashVSR output did not preserve the exact source frame count")
    if int(result.get("width", 0)) != width * 4 or int(result.get("height", 0)) != height * 4:
        raise RuntimeError("FlashVSR output dimensions do not match exact 4x source dimensions")
    print(json.dumps({"ok": True, "model": "FlashVSR-v1.1-tiny-long",
                      "frames": frames, "fps": fps,
                      "inputDimensions": {"width": width, "height": height},
                      "outputDimensions": {"width": width * 4, "height": height * 4},
                      "scale": 4, "temporalModel": True,
                      "license": "Apache-2.0"}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": type(exc).__name__,
                          "message": str(exc)[:1000]}), file=sys.stderr)
        raise
