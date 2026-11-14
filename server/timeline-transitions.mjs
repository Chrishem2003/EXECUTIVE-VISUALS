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
