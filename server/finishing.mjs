import { invalid, normalizeParams } from "./studio-schema.mjs";

/**
 * Local finishing operations. Each one is a pure FFmpeg argument builder, so the
 * server can validate and run them without any provider, and the browser draws
 * its forms from the same specs (they ship in /api/studio/capabilities).
 */

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];

export const FINISHING_OPERATIONS = {
  "media.speed": {
    label: "Speed change",
    description: "Slow down or speed up video or audio. Audio pitch is preserved.",
    media: ["video", "audio"],
    params: [{ key: "factor", label: "Speed (1 = normal)", type: "number", min: 0.25, max: 4, default: 1.5 }]
  },
  "media.fade": {
    label: "Fade in / out",
    description: "Fade picture and sound at the start and end of a clip.",
    media: ["video"],
    params: [
      { key: "fadeIn", label: "Fade in (seconds)", type: "number", min: 0, max: 10, default: 1 },
      { key: "fadeOut", label: "Fade out (seconds)", type: "number", min: 0, max: 10, default: 1 }
    ]
  },
  "media.motion": {
    label: "Still to video (camera move)",
    description: "Turn a still image into a clip with a smooth push-in, pull-out or pan.",
    media: ["image"],
    params: [
      { key: "preset", label: "Camera move", type: "select", options: ["zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down"], default: "zoom-in" },
      { key: "seconds", label: "Length (seconds)", type: "number", min: 2, max: 30, default: 6 },
      { key: "intensity", label: "Move amount", type: "range", min: 5, max: 50, integer: true, default: 25 },
      { key: "aspect", label: "Frame", type: "select", options: ["16:9", "9:16", "1:1"], default: "16:9" },
      { key: "fps", label: "Frame rate", type: "select", options: [24, 25, 30], default: 30 }
    ]
  },
  "media.silence-trim": {
    label: "Trim silence",
    description: "Remove leading and long internal silences from spoken audio.",
    media: ["audio"],
    params: [
      { key: "thresholdDb", label: "Silence below (dB)", type: "number", min: -70, max: -20, default: -45 },
      { key: "minSilence", label: "Shortest silence to cut (s)", type: "number", min: 0.2, max: 5, default: 0.6 }
    ]
  },
  "media.mux": {
    label: "Add or replace audio",
    description: "Lay narration or music on a video. Music can duck under existing speech.",
    media: ["video"],
    secondary: { field: "audioAssetId", label: "Audio to add", accepts: ["audio"] },
    params: [
      { key: "mode", label: "Mode", type: "select", options: ["replace", "mix-with-ducking"], default: "replace" },
      { key: "gainDb", label: "Added audio level (dB)", type: "number", min: -60, max: 12, default: 0 },
      { key: "loopAudio", label: "Loop the audio to fill the video", type: "boolean", default: false }
    ]
  },
  "media.brand": {
    label: "Logo overlay",
    description: "Place your own logo in a corner of a video.",
    media: ["video"],
    secondary: { field: "logoAssetId", label: "Logo image", accepts: ["image"] },
    params: [
      { key: "position", label: "Corner", type: "select", options: CORNERS, default: "bottom-right" },
      { key: "widthPercent", label: "Logo width (% of frame)", type: "number", min: 5, max: 50, default: 15 },
      { key: "opacity", label: "Opacity", type: "number", min: 0.1, max: 1, default: 0.9 },
      { key: "margin", label: "Margin (px)", type: "number", min: 0, max: 200, default: 24, integer: true }
    ]
  }
};

export const FINISHING_JOBS = new Set(Object.keys(FINISHING_OPERATIONS));
export const isFinishingJob = type => FINISHING_JOBS.has(type);
export const secondaryField = type => FINISHING_OPERATIONS[type]?.secondary || null;

/** The factor-based upscale reuses the existing media.upscale job; it is listed here so the browser builds its form from the server. */
const LOCAL_UPSCALE = {
  id: "media.upscale",
  label: "Upscale (local, by factor)",
  description: "Enlarge video or stills with Lanczos scaling. Optional clean-up first and gentle sharpening. Not a neural upscale; use your gateway for that.",
  media: ["video", "image"],
  params: [
    { key: "scale", label: "Enlarge by", type: "select", options: [2, 3, 4], default: 2 },
    { key: "sharpen", label: "Sharpen", type: "range", min: 0, max: 100, integer: true, default: 25 },
    { key: "cleanFirst", label: "Reduce compression noise first", type: "boolean", default: false }
  ]
};

export function finishingCatalog() {
  return [...Object.entries(FINISHING_OPERATIONS).map(([id, op]) => ({ id, ...op })), LOCAL_UPSCALE];
}

/** Pull the facts the builders need out of ffprobe JSON. */
export function parseFacts(probe = {}) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find(s => s.codec_type === "video");
  const duration = Number(probe.format?.duration) || Number(video?.duration) || Number(streams.find(s => s.codec_type === "audio")?.duration) || 0;
  return {
    durationSeconds: duration,
    hasAudio: streams.some(s => s.codec_type === "audio"),
    hasVideo: Boolean(video),
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0
  };
}

const evenInt = value => Math.max(2, Math.round(value / 2) * 2);
const baseName = name => (String(name || "media").includes(".") ? String(name).slice(0, String(name).lastIndexOf(".")) : String(name || "media"));

/** Chain atempo stages (each limited to 0.5 to 2) for any factor between 0.25 and 4. */
export function atempoChain(factor) {
  const stages = [];
  let rest = factor;
  while (rest > 2) { stages.push(2); rest /= 2; }
  while (rest < 0.5) { stages.push(0.5); rest /= 0.5; }
  stages.push(Number(rest.toFixed(6)));
  return stages.map(stage => `atempo=${stage}`).join(",");
}

const VIDEO_OUT = outputPath => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath];

function motionExpressions(preset, amount, frames) {
  const progress = `on/${frames}`;
  const centreX = "iw/2-(iw/zoom/2)";
  const centreY = "ih/2-(ih/zoom/2)";
  switch (preset) {
    case "zoom-in": return { z: `1+${amount}*${progress}`, x: centreX, y: centreY };
    case "zoom-out": return { z: `1+${amount}-${amount}*${progress}`, x: centreX, y: centreY };
    case "pan-left": return { z: `1+${amount}`, x: `(iw-iw/zoom)*(1-${progress})`, y: centreY };
    case "pan-right": return { z: `1+${amount}`, x: `(iw-iw/zoom)*${progress}`, y: centreY };
    case "pan-up": return { z: `1+${amount}`, x: centreX, y: `(ih-ih/zoom)*(1-${progress})` };
    default: return { z: `1+${amount}`, x: centreX, y: `(ih-ih/zoom)*${progress}` };
  }
}

/**
 * Returns { args, ext, mime, suffix } for one finishing job. `kind` is the
 * primary source's media kind (image, video or audio) and `facts` come from ffprobe.
 */
export function buildFinishingArgs({ jobType, input = {}, sourcePath, secondaryPath = null, outputBase, kind, facts }) {
  const spec = FINISHING_OPERATIONS[jobType];
  if (!spec) throw invalid("Unsupported finishing operation.", "INVALID_MEDIA_OPTIONS");
  const bad = message => invalid(message, "INVALID_MEDIA_OPTIONS");
  if (!spec.media.includes(kind)) throw invalid(`${spec.label} needs ${spec.media.join(" or ")} media.`, "UNSUPPORTED_MEDIA_TYPE");
  let p;
  try { p = normalizeParams(spec.params, input); } catch (error) { throw bad(error.message); }
  const out = ext => `${outputBase}.${ext}`;
  const base = ["-hide_banner", "-y", "-i", sourcePath];

  if (jobType === "media.speed") {
    const audioFilter = atempoChain(p.factor);
    if (kind === "audio") return { args: [...base, "-vn", "-af", audioFilter, "-c:a", "pcm_s16le", "-ar", "48000", out("wav")], ext: "wav", mime: "audio/wav", suffix: "speed" };
    const args = [...base, "-filter:v", `setpts=PTS/${p.factor}`];
    if (facts.hasAudio) args.push("-filter:a", audioFilter, "-c:a", "aac", "-b:a", "192k");
    else args.push("-an");
    return { args: [...args, ...VIDEO_OUT(out("mp4"))], ext: "mp4", mime: "video/mp4", suffix: "speed" };
  }

  if (jobType === "media.fade") {
    if (p.fadeIn <= 0 && p.fadeOut <= 0) throw bad("Set a fade in or a fade out.");
    const total = facts.durationSeconds;
    if (!(total > 0) || p.fadeIn + p.fadeOut > total) throw bad("The fades are longer than the clip.");
    const video = [];
    const audio = [];
    if (p.fadeIn > 0) { video.push(`fade=t=in:st=0:d=${p.fadeIn}`); audio.push(`afade=t=in:st=0:d=${p.fadeIn}`); }
    if (p.fadeOut > 0) { const start = (total - p.fadeOut).toFixed(3); video.push(`fade=t=out:st=${start}:d=${p.fadeOut}`); audio.push(`afade=t=out:st=${start}:d=${p.fadeOut}`); }
    const args = [...base, "-vf", video.join(",")];
    if (facts.hasAudio) args.push("-af", audio.join(","), "-c:a", "aac", "-b:a", "192k");
    else args.push("-an");
    return { args: [...args, ...VIDEO_OUT(out("mp4"))], ext: "mp4", mime: "video/mp4", suffix: "fade" };
  }

  if (jobType === "media.motion") {
    const [aw, ah] = p.aspect.split(":").map(Number);
    const width = p.aspect === "9:16" ? 720 : p.aspect === "1:1" ? 1080 : 1280;
    const height = evenInt(width * ah / aw);
    const frames = Math.round(p.seconds * p.fps);
    const e = motionExpressions(p.preset, (p.intensity / 100).toFixed(4), frames);
    const filter = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},setsar=1,zoompan=z='${e.z}':x='${e.x}':y='${e.y}':d=${frames}:s=${width}x${height}:fps=${p.fps},format=yuv420p`;
    return { args: ["-hide_banner", "-y", "-i", sourcePath, "-vf", filter, "-frames:v", String(frames), "-an", ...VIDEO_OUT(out("mp4"))], ext: "mp4", mime: "video/mp4", suffix: p.preset };
  }

  if (jobType === "media.silence-trim") {
    const t = `${p.thresholdDb}dB`;
    const filter = `silenceremove=start_periods=1:start_duration=0:start_threshold=${t}:stop_periods=-1:stop_duration=${p.minSilence}:stop_threshold=${t}:detection=peak`;
    return { args: [...base, "-vn", "-af", filter, "-c:a", "pcm_s16le", "-ar", "48000", out("wav")], ext: "wav", mime: "audio/wav", suffix: "trimmed" };
  }

  if (jobType === "media.mux") {
    if (!secondaryPath) throw bad("Choose the audio to add.");
    if (!facts.hasVideo) throw bad("The source has no video stream.");
    const lead = p.loopAudio ? ["-stream_loop", "-1", "-i", secondaryPath] : ["-i", secondaryPath];
    const gain = `volume=${p.gainDb}dB`;
    const mixing = p.mode === "mix-with-ducking" && facts.hasAudio;
    const graph = mixing
      ? `[1:a]${gain},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[music];[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=2[speech][key];[music][key]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=400[ducked];[speech][ducked]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[aout]`
      : `[1:a]${gain},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${p.loopAudio ? "" : ",apad"}[aout]`;
    return {
      args: ["-hide_banner", "-y", "-i", sourcePath, ...lead, "-filter_complex", graph, "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out("mp4")],
      ext: "mp4", mime: "video/mp4", suffix: mixing ? "mixed" : "audio"
    };
  }

  // media.brand
  if (!secondaryPath) throw bad("Choose the logo image.");
  if (!(facts.width > 0)) throw bad("The source has no video stream.");
  const logoWidth = evenInt(facts.width * p.widthPercent / 100);
  const m = p.margin;
  const x = p.position.endsWith("left") ? `${m}` : `main_w-overlay_w-${m}`;
  const y = p.position.startsWith("top") ? `${m}` : `main_h-overlay_h-${m}`;
  const graph = `[1:v]scale=${logoWidth}:-1,format=rgba,colorchannelmixer=aa=${p.opacity}[logo];[0:v][logo]overlay=${x}:${y}:format=auto,format=yuv420p[v]`;
  return {
    args: ["-hide_banner", "-y", "-i", sourcePath, "-i", secondaryPath, "-filter_complex", graph, "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "copy", "-movflags", "+faststart", out("mp4")],
    ext: "mp4", mime: "video/mp4", suffix: "branded"
  };
}

export const finishingOutputName = (sourceName, suffix, ext) => `${baseName(sourceName)}-${suffix}.${ext}`;
