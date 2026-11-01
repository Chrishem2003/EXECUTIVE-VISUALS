import { gatewayConfig, submitAndCollect } from "../gateway-core.mjs";

export const PREFIX = "LIPSYNC";
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

export const LIPSYNC_PARAMS = [
  { key: "precision", label: "Sync precision", type: "select", options: ["balanced", "precise"], default: "balanced" },
  { key: "face", label: "Which face", type: "select", options: ["auto", "largest"], default: "auto" },
  { key: "keepOriginalAudio", label: "Keep original audio under the new track", type: "boolean", default: false }
];

/**
 * Contract: POST {base}/lipsync as multipart/form-data with fields `model`,
 * `params` (JSON), `video` and `audio`. The reply is the synced video, a result
 * URL, inline base64, or a job id polled at {base}/jobs/{id}.
 */
export async function runLipsync({ params, video, audio, signal, onProgress, onReady }) {
  const cfg = gatewayConfig(PREFIX, "lip-sync gateway");
  onReady?.(cfg); // usage reservation happens here: after config checks, before any network call
  const form = new FormData();
  form.set("model", cfg.model);
  form.set("params", JSON.stringify(params));
  form.set("video", video.blob, video.name);
  form.set("audio", audio.blob, audio.name);
  return submitAndCollect(cfg, { path: "lipsync", body: form, signal, onProgress, maxBytes: MAX_OUTPUT_BYTES, statusPath: "jobs/{id}" });
}
