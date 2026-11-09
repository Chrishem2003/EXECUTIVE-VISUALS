import type { EditorialTimeline, TimelineClip, TimelineTrack } from "./timeline.ts";

export interface TimelinePlaybackItem {
  clipId: string;
  trackId: string;
  trackKind: TimelineTrack["kind"];
  trackIndex: number;
  assetId: string;
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  mediaTimeSeconds: number;
  gainDb: number;
  speed: number;
}

export interface TimelinePlaybackFrame {
  playheadSeconds: number;
  durationSeconds: number;
  active: TimelinePlaybackItem[];
  activeVideo: TimelinePlaybackItem[];
  activeAudio: TimelinePlaybackItem[];
  activeImages: TimelinePlaybackItem[];
}

const positive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

export function timelineDurationSeconds(timeline: EditorialTimeline): number {
  return Math.max(0, ...timeline.tracks.flatMap(track =>
    track.clips.map(clip => clip.timelineStart.value / clip.timelineStart.rate + clip.duration.value / clip.duration.rate)
  ));
}

export function frameToTimelineSeconds(frame: number, timeline: EditorialTimeline): number {
  const rate = positive(timeline.frameRate.numerator / timeline.frameRate.denominator, 24);
  return Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0)) / rate;
}

export function timelineSecondsToFrame(seconds: number, timeline: EditorialTimeline): number {
  const rate = positive(timeline.frameRate.numerator / timeline.frameRate.denominator, 24);
  return Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * rate));
}

export function clampTimelineFrame(frame: number, timeline: EditorialTimeline): number {
  return Math.min(timelineSecondsToFrame(timelineDurationSeconds(timeline), timeline), Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0)));
}

export function timelineClipMediaTimeSeconds(clip: TimelineClip, timelineSeconds: number): number {
  const start = clip.timelineStart.value / clip.timelineStart.rate;
  const sourceStart = clip.sourceRange.start.value / clip.sourceRange.start.rate;
  const sourceDuration = clip.sourceRange.duration.value / clip.sourceRange.duration.rate;
  const speed = positive(clip.speed ?? 1, 1);
  const elapsed = Math.max(0, timelineSeconds - start);
  const mediaOffset = Math.min(sourceDuration, elapsed * speed);
  return sourceStart + mediaOffset;
}

export function getTimelinePlaybackFrame(timeline: EditorialTimeline, playheadSeconds: number): TimelinePlaybackFrame {
  const durationSeconds = timelineDurationSeconds(timeline);
  const safeTime = Math.min(durationSeconds, Math.max(0, Number.isFinite(playheadSeconds) ? playheadSeconds : 0));
  const active: TimelinePlaybackItem[] = [];

  timeline.tracks.forEach((track, trackIndex) => {
    if (!track.enabled || track.kind === "caption") return;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      const start = clip.timelineStart.value / clip.timelineStart.rate;
      const end = start + clip.duration.value / clip.duration.rate;
      if (safeTime < start || safeTime >= end) continue;
      active.push({
        clipId: clip.id,
        trackId: track.id,
        trackKind: track.kind,
        trackIndex,
        assetId: clip.assetId,
        timelineStartSeconds: start,
        timelineEndSeconds: end,
        mediaTimeSeconds: timelineClipMediaTimeSeconds(clip, safeTime),
        gainDb: Math.max(-60, Math.min(24, Number.isFinite(clip.gainDb) ? clip.gainDb! : 0)),
        speed: positive(clip.speed ?? 1, 1),
      });
    }
  });

  active.sort((a, b) => a.trackIndex - b.trackIndex || a.timelineStartSeconds - b.timelineStartSeconds);
  return {
    playheadSeconds: safeTime,
    durationSeconds,
    active,
    activeVideo: active.filter(item => item.trackKind === "video"),
    activeAudio: active.filter(item => item.trackKind === "audio"),
    activeImages: active.filter(item => item.trackKind === "overlay"),
  };
}
