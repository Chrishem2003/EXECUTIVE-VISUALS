import { gatewayConfig, submitAndCollect } from "../gateway-core.mjs";

export const PREFIX = "ENHANCE";
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
const strength = { key: "strength", label: "Strength", type: "range", min: 0, max: 100, integer: true, default: 50 };

/** Restoration and repair operations offered by the enhancement engine. */
export const ENHANCE_OPERATIONS = {
  upscale: {
    label: "Upscale",
    description: "Increase resolution while preserving detail.",
    media: ["image", "video"],
    params: [{ key: "scale", label: "Scale", type: "select", options: [2, 4], default: 2 }]
  },
  enhance: {
    label: "Enhance quality",
    description: "Sharpen blurry or low-quality footage and photos.",
    media: ["image", "video"],
    params: [
      { key: "mode", label: "Scene type", type: "select", options: ["general", "portrait", "low-light", "old-footage", "animation"], default: "general" },
      strength
    ]
  },
  denoise: {
    label: "Denoise",
    description: "Reduce grain and compression noise.",
    media: ["image", "video"],
    params: [strength]
  },
  restore: {
    label: "Restore",
    description: "Repair faded, scratched or damaged media.",
    media: ["image", "video"],
    params: [{ key: "faceRestore", label: "Restore faces", type: "boolean", default: true }]
  },
  stabilize: {
    label: "Stabilize",
    description: "Reduce camera shake.",
    media: ["video"],
    params: [{ key: "smoothing", label: "Smoothing", type: "range", min: 0, max: 100, integer: true, default: 50 }]
  },
  interpolate: {
    label: "Frame interpolation",
    description: "Create in-between frames for smoother motion.",
    media: ["video"],
    params: [{ key: "targetFps", label: "Target frame rate", type: "select", options: [30, 48, 60], default: 60 }]
  },
  "remove-watermark": {
    label: "Remove watermark",
    description: "Remove a logo or watermark. Only for media you own or are licensed to modify.",
    media: ["image", "video"],
    requiresRights: true,
    params: [{ key: "region", label: "Watermark position", type: "select", options: ["auto", "top-left", "top-right", "bottom-left", "bottom-right"], default: "auto" }]
  },
  "remove-background": {
    label: "Remove background",
    description: "Cut out the subject.",
    media: ["image"],
    params: [{ key: "background", label: "Replace with", type: "select", options: ["transparent", "white", "black"], default: "transparent" }]
  }
};

/**
 * Contract: POST {base}/enhance as multipart/form-data with fields
 * `model`, `operation`, `params` (JSON) and `file`. The reply is the processed
 * file, a result URL, inline base64, or a job id polled at {base}/jobs/{id}.
 */
export async function runEnhance({ operation, params, blob, name, signal, onProgress, onReady }) {
  if (!ENHANCE_OPERATIONS[operation]) throw new Error(`Unknown enhancement operation: ${operation}`);
  const cfg = gatewayConfig(PREFIX, "enhancement gateway");
  onReady?.(cfg); // usage reservation happens here: after config checks, before any network call
  const form = new FormData();
  form.set("model", cfg.model);
  form.set("operation", operation);
  form.set("params", JSON.stringify(params));
  form.set("file", blob, name);
  return submitAndCollect(cfg, { path: "enhance", body: form, signal, onProgress, maxBytes: MAX_OUTPUT_BYTES, statusPath: "jobs/{id}" });
}
