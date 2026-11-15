/**
 * Build bounded FFmpeg clip-edge fades. Metadata is untrusted input, so each
 * fade is clamped to the clip duration and the two fades cannot overlap.
 */
export function buildClipFadeFilters(clip, duration, kind = "video") {
  const length = Number(duration);
  if (!Number.isFinite(length) || length <= 0) return [];
  if (kind !== "video" && kind !== "audio") throw new Error("Unsupported clip fade media kind.");
  const metadata = clip?.metadata && typeof clip.metadata === "object" ? clip.metadata : {};
  const read = key => {
    const value = Number(metadata[key]);
    return Number.isFinite(value) ? Math.max(0, Math.min(length, value)) : 0;
  };
  const fadeIn = read("fadeInSeconds");
  const fadeOut = Math.min(read("fadeOutSeconds"), Math.max(0, length - fadeIn));
  const filters = [];
  if (kind === "video") {
    if (fadeIn > 0) filters.push("fade=t=in:st=0:d=" + fadeIn.toFixed(6));
    if (fadeOut > 0) filters.push("fade=t=out:st=" + Math.max(0, length - fadeOut).toFixed(6) + ":d=" + fadeOut.toFixed(6));
  } else {
    if (fadeIn > 0) filters.push("afade=t=in:st=0:d=" + fadeIn.toFixed(6));
    if (fadeOut > 0) filters.push("afade=t=out:st=" + Math.max(0, length - fadeOut).toFixed(6) + ":d=" + fadeOut.toFixed(6));
  }
  return filters;
}

/**
 * Join normalized primary-video segments, using a frame-accurate xfade for
 * explicitly overlapping adjacent clips and concat for hard cuts/gaps.
 * Each segment is already normalized to the timeline size, frame rate and
 * pixel format by the caller.
 */
export function buildVideoSequenceGraph(segments, fps) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("A video sequence requires at least one normalized segment.");
  }
  const frameRate = Number(fps);
  if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 240) {
    throw new Error("Video transition frame rate must be positive and supported.");
  }
  let current = String(segments[0]?.label || "");
  let duration = Number(segments[0]?.duration);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(current) || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video sequence segments require safe labels and positive durations.");
  }
  const filters = [];
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const next = segments[index];
    const nextLabel = "vseq" + index;
    const nextDuration = Number(next?.duration);
    const nextInput = String(next?.label || "");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(nextInput) || !Number.isFinite(nextDuration) || nextDuration <= 0) {
      throw new Error("Video sequence segments require safe labels and positive durations.");
    }
    if (previous?.transitionToNext?.type === "crossfade") {
      const frames = Number(previous.transitionToNext.fadeFrames);
      const fade = frames / frameRate;
      if (!Number.isSafeInteger(frames) || frames < 1 || fade > duration || fade > nextDuration) {
        throw new Error("Video crossfade length must fit both adjacent clips.");
      }
      filters.push(`[${current}][${nextInput}]xfade=transition=fade:duration=${fade.toFixed(6)}:offset=${Math.max(0, duration - fade).toFixed(6)}[${nextLabel}]`);
      duration += nextDuration - fade;
    } else {
      filters.push(`[${current}][${nextInput}]concat=n=2:v=1:a=0[${nextLabel}]`);
      duration += nextDuration;
    }
    current = nextLabel;
  }
  return { filter: filters.join(";"), label: current, duration };
}
