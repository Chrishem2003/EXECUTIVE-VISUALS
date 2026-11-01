import { gatewayConfig, submitAndCollect } from "../gateway-core.mjs";

export const PREFIX = "AVATAR";
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

export const AVATAR_PARAMS = [
  { key: "script", label: "Script (or attach narration audio)", type: "text", max: 4000 },
  { key: "aspectRatio", label: "Aspect ratio", type: "select", options: ["16:9", "9:16", "1:1"], default: "16:9" },
  { key: "resolution", label: "Resolution", type: "select", options: ["720p", "1080p"], default: "1080p" },
  { key: "background", label: "Background", type: "select", options: ["studio", "solid-light", "solid-dark", "transparent"], default: "studio" },
  { key: "captions", label: "Burn in captions", type: "boolean", default: false }
];

/**
 * Contract: POST {base}/avatar/videos (JSON). `avatar` is the provider reference
 * of a consent-verified avatar profile. Narration is either `script` (spoken with
 * `voice`) or `audio` (a data URI). The reply is the video, a result URL, inline
 * base64, or a job id polled at {base}/avatar/videos/{id}.
 */
export async function runAvatar({ avatarRef, voiceRef, params, audio, signal, onProgress, onReady }) {
  const cfg = gatewayConfig(PREFIX, "avatar gateway");
  onReady?.(cfg); // usage reservation happens here: after config checks, before any network call
  const body = {
    model: cfg.model,
    avatar: avatarRef,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolution,
    background: params.background,
    captions: Boolean(params.captions)
  };
  if (audio) body.audio = audio;
  else body.script = params.script;
  if (voiceRef && !audio) body.voice = voiceRef;
  return submitAndCollect(cfg, {
    path: "avatar/videos",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    onProgress,
    maxBytes: MAX_OUTPUT_BYTES,
    statusPath: "avatar/videos/{id}"
  });
}
