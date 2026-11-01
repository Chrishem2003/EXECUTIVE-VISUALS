import { gatewayConfig, submitAndCollect } from "../gateway-core.mjs";

export const PREFIX = "TRANSFORM";
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
const prompt = { key: "prompt", label: "Describe the change", type: "text", required: true, max: 500 };

/** Video-to-video and image-to-video operations offered by the transform engine. */
export const TRANSFORM_OPERATIONS = {
  extend: {
    label: "Extend a clip",
    description: "Continue a shot forward in time, keeping subject, style and camera.",
    media: ["video"],
    params: [
      { key: "seconds", label: "Extra seconds", type: "select", options: [2, 4, 6, 8], default: 4 },
      { key: "prompt", label: "What happens next (optional)", type: "text", max: 500 }
    ]
  },
  restyle: {
    label: "Restyle footage",
    description: "Re-render a clip in a new visual style while keeping the motion.",
    media: ["video"],
    params: [prompt, { key: "strength", label: "Style strength", type: "range", min: 0, max: 100, integer: true, default: 55 }]
  },
  "camera-move": {
    label: "Add a camera move",
    description: "Animate a still image or reframe a shot with a virtual camera.",
    media: ["image", "video"],
    params: [
      { key: "move", label: "Camera move", type: "select", options: ["push-in", "pull-out", "orbit-left", "orbit-right", "crane-up", "crane-down", "handheld"], default: "push-in" },
      { key: "seconds", label: "Length (seconds)", type: "select", options: [3, 5, 8], default: 5 },
      { key: "prompt", label: "Scene note (optional)", type: "text", max: 500 }
    ]
  },
  "remove-object": {
    label: "Remove an object",
    description: "Erase something from a shot and fill in the background.",
    media: ["image", "video"],
    params: [{ key: "object", label: "What to remove", type: "text", required: true, max: 200 }]
  },
  "change-weather": {
    label: "Change time or weather",
    description: "Turn day into dusk, add rain or snow, and keep the scene consistent.",
    media: ["image", "video"],
    params: [{ key: "scene", label: "New conditions", type: "select", options: ["golden-hour", "night", "overcast", "rain", "snow", "fog"], default: "golden-hour" }]
  }
};

/**
 * Contract: POST {base}/transform as multipart/form-data with fields `model`,
 * `operation`, `params` (JSON) and `file`. The reply is the new media, a result
 * URL, inline base64, or a job id polled at {base}/jobs/{id}.
 */
export async function runTransform({ operation, params, blob, name, signal, onProgress, onReady }) {
  if (!TRANSFORM_OPERATIONS[operation]) throw new Error(`Unknown transform operation: ${operation}`);
  const cfg = gatewayConfig(PREFIX, "transform gateway");
  onReady?.(cfg); // usage reservation happens here: after config checks, before any network call
  const form = new FormData();
  form.set("model", cfg.model);
  form.set("operation", operation);
  form.set("params", JSON.stringify(params));
  form.set("file", blob, name);
  return submitAndCollect(cfg, { path: "transform", body: form, signal, onProgress, maxBytes: MAX_OUTPUT_BYTES, statusPath: "jobs/{id}" });
}
