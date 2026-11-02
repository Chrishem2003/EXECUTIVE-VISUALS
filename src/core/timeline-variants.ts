import { seconds, validateTimeline, type EditorialTimeline } from "./timeline";

export interface TimelineVariantChange {
  kind: "added" | "removed" | "changed";
  clipId: string;
  clipName: string;
  fields: string[];
}
export interface TimelineVariantComparison {
  baseId: string;
  candidateId: string;
  addedClips: number;
  removedClips: number;
  changedClips: number;
  addedMarkers: number;
  removedMarkers: number;
  changedMarkers: number;
  trackCountDelta: number;
  changes: TimelineVariantChange[];
  summary: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stable = (value: unknown) => JSON.stringify(value ?? null);
const close = (a: number, b: number) => Math.abs(a - b) <= 0.000001;
const clipMap = (timeline: EditorialTimeline) => new Map(timeline.tracks.flatMap(track => track.clips.map(clip => [clip.id, { clip, trackId: track.id }] as const)));
const markerMap = (timeline: EditorialTimeline) => new Map(timeline.markers.map(marker => [marker.id, marker]));

export function createTimelineVariant(source: EditorialTimeline, id: string, name: string, createdAt = new Date().toISOString()): EditorialTimeline {
  if (typeof id !== "string" || !id.trim() || id === source.id) throw new Error("A new, distinct timeline ID is required.");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 160) throw new Error("Variant name must contain 1–160 characters.");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Variant creation time must be a valid timestamp.");
  const validation = validateTimeline(source);
  if (!validation.valid) throw new Error("Cannot create a variant from an invalid timeline: " + validation.issues[0].message);
  const previous = object(source.metadata) ? source.metadata : {};
  const rootId = typeof previous.variantOf === "string" && previous.variantOf ? previous.variantOf : source.id;
  const clone = structuredClone(source);
  return {
    ...clone,
    id: id.trim(),
    name: name.trim(),
    revision: 1,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
    metadata: {
      ...previous,
      variantOf: rootId,
      variantParentId: source.id,
      variantCreatedAt: new Date(createdAt).toISOString(),
    },
  };
}

export function compareTimelineVariants(base: EditorialTimeline, candidate: EditorialTimeline): TimelineVariantComparison {
  for (const [label, timeline] of [["base", base], ["candidate", candidate]] as const) {
    const validation = validateTimeline(timeline);
    if (!validation.valid) throw new Error("Cannot compare an invalid " + label + " timeline: " + validation.issues[0].message);
  }
  const before = clipMap(base), after = clipMap(candidate);
  const changes: TimelineVariantChange[] = [];
  let addedClips = 0, removedClips = 0, changedClips = 0;
  for (const [id, current] of after) {
    const previous = before.get(id);
    if (!previous) {
      addedClips++;
      changes.push({ kind: "added", clipId: id, clipName: current.clip.name, fields: ["new clip"] });
      continue;
    }
    const fields: string[] = [];
    const a = previous.clip, b = current.clip;
    if (previous.trackId !== current.trackId) fields.push("track");
    if (a.name !== b.name) fields.push("name");
    if (a.assetId !== b.assetId) fields.push("source asset");
    if (!close(seconds(a.timelineStart), seconds(b.timelineStart))) fields.push("timeline position");
    if (!close(seconds(a.duration), seconds(b.duration))) fields.push("duration");
    if (!close(seconds(a.sourceRange.start), seconds(b.sourceRange.start)) || !close(seconds(a.sourceRange.duration), seconds(b.sourceRange.duration))) fields.push("source trim");
    if (a.enabled !== b.enabled) fields.push("enabled state");
    if ((a.gainDb ?? 0) !== (b.gainDb ?? 0)) fields.push("audio gain");
    if ((a.speed ?? 1) !== (b.speed ?? 1)) fields.push("speed");
    const aTrace = object(a.metadata) ? a.metadata.creativeTrace : null;
    const bTrace = object(b.metadata) ? b.metadata.creativeTrace : null;
    if (stable(aTrace) !== stable(bTrace)) fields.push("creative intent");
    if (fields.length) {
      changedClips++;
      changes.push({ kind: "changed", clipId: id, clipName: b.name, fields });
    }
  }
  for (const [id, previous] of before) {
    if (!after.has(id)) {
      removedClips++;
      changes.push({ kind: "removed", clipId: id, clipName: previous.clip.name, fields: ["removed clip"] });
    }
  }
  const beforeMarkers = markerMap(base), afterMarkers = markerMap(candidate);
  let addedMarkers = 0, removedMarkers = 0, changedMarkers = 0;
  for (const [id, marker] of afterMarkers) {
    const previous = beforeMarkers.get(id);
    if (!previous) addedMarkers++;
    else if (previous.name !== marker.name || previous.note !== marker.note || !close(seconds(previous.start), seconds(marker.start))) changedMarkers++;
  }
  for (const id of beforeMarkers.keys()) if (!afterMarkers.has(id)) removedMarkers++;
  const trackCountDelta = candidate.tracks.length - base.tracks.length;
  const total = addedClips + removedClips + changedClips + addedMarkers + removedMarkers + changedMarkers + Math.abs(trackCountDelta);
  return {
    baseId: base.id, candidateId: candidate.id,
    addedClips, removedClips, changedClips,
    addedMarkers, removedMarkers, changedMarkers, trackCountDelta, changes,
    summary: total === 0 ? "No editorial differences detected." : [
      addedClips ? addedClips + " clip(s) added" : "",
      removedClips ? removedClips + " clip(s) removed" : "",
      changedClips ? changedClips + " clip(s) changed" : "",
      addedMarkers ? addedMarkers + " marker(s) added" : "",
      removedMarkers ? removedMarkers + " marker(s) removed" : "",
      changedMarkers ? changedMarkers + " marker(s) changed" : "",
      trackCountDelta ? Math.abs(trackCountDelta) + " track(s) " + (trackCountDelta > 0 ? "added" : "removed") : "",
    ].filter(Boolean).join(" · "),
  };
}
