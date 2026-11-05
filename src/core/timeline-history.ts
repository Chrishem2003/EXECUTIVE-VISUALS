import {
  validateTimeline,
  type EditorialTimeline,
  type TimelineClip,
  type TimelineMarker,
  type TimelineTrack
} from "./timeline.ts";

type ClipLocation = { trackId: string; clip: TimelineClip } | null;
type TimelineSettings = Pick<EditorialTimeline, "name" | "width" | "height" | "pixelAspectRatio" | "frameRate" | "metadata">;
type TrackValue = {
  id: string;
  name: string;
  kind: TimelineTrack["kind"];
  enabled: boolean;
  locked: boolean;
  index: number;
};
type EntityChange =
  | { entity: "track"; id: string; before: TrackValue | null; after: TrackValue | null }
  | { entity: "clip"; id: string; before: ClipLocation; after: ClipLocation }
  | { entity: "marker"; id: string; before: TimelineMarker | null; after: TimelineMarker | null }
  | { entity: "settings"; id: "timeline-settings"; before: TimelineSettings; after: TimelineSettings };

export interface TimelineHistoryOperation {
  schemaVersion: 1;
  id: string;
  label: string;
  origin: "local" | "remote" | "system";
  createdAt: string;
  baseRevision: number;
  changes: EntityChange[];
}

export interface TimelineHistory {
  undo: TimelineHistoryOperation[];
  redo: TimelineHistoryOperation[];
  limit: number;
}

export function createTimelineHistory(limit = 100): TimelineHistory {
  return { undo: [], redo: [], limit: Math.max(1, Math.min(500, Math.floor(limit) || 100)) };
}

const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const seconds = (value: { value: number; rate: number }) => value.value / value.rate;

function trackValue(track: TimelineTrack, index: number): TrackValue {
  return { id: track.id, name: track.name, kind: track.kind, enabled: track.enabled, locked: track.locked, index };
}

function trackMap(timeline: EditorialTimeline): Map<string, TrackValue> {
  return new Map(timeline.tracks.map((track, index) => [track.id, trackValue(track, index)]));
}

function clipMap(timeline: EditorialTimeline): Map<string, Exclude<ClipLocation, null>> {
  const result = new Map<string, Exclude<ClipLocation, null>>();
  for (const track of timeline.tracks) for (const clip of track.clips) result.set(clip.id, { trackId: track.id, clip: clone(clip) });
  return result;
}

function markerMap(timeline: EditorialTimeline): Map<string, TimelineMarker> {
  return new Map(timeline.markers.map(marker => [marker.id, clone(marker)]));
}

function validateEditableTimeline(timeline: EditorialTimeline): void {
  const result = validateTimeline(timeline);
  if (!result.valid) throw new Error(result.issues[0]?.message || "Timeline validation failed.");
}

/** Build a compact, entity-level operation. No whole-timeline snapshots are stored in history. */
export function createTimelineHistoryOperation(
  before: EditorialTimeline,
  after: EditorialTimeline,
  options: { label: string; origin?: "local" | "remote" | "system"; id?: string; createdAt?: string } 
): TimelineHistoryOperation | null {
  if (before.id !== after.id || before.projectId !== after.projectId) {
    throw new Error("A history operation cannot change timeline or project identity.");
  }
  validateEditableTimeline(before);
  validateEditableTimeline(after);

  const beforeTracks = trackMap(before), afterTracks = trackMap(after);
  const beforeClips = clipMap(before), afterClips = clipMap(after);
  const beforeMarkers = markerMap(before), afterMarkers = markerMap(after);
  const trackAdds: EntityChange[] = [], trackUpdates: EntityChange[] = [];
  const clipChanges: EntityChange[] = [], markerChanges: EntityChange[] = [], trackRemoves: EntityChange[] = [];

  for (const id of new Set([...beforeTracks.keys(), ...afterTracks.keys()])) {
    const a = beforeTracks.get(id) || null, b = afterTracks.get(id) || null;
    if (same(a, b)) continue;
    const change: EntityChange = { entity: "track", id, before: a ? clone(a) : null, after: b ? clone(b) : null };
    if (!a && b) trackAdds.push(change);
    else if (a && !b) trackRemoves.push(change);
    else trackUpdates.push(change);
  }
  for (const id of new Set([...beforeClips.keys(), ...afterClips.keys()])) {
    const a = beforeClips.get(id) || null, b = afterClips.get(id) || null;
    if (!same(a, b)) clipChanges.push({ entity: "clip", id, before: a ? clone(a) : null, after: b ? clone(b) : null });
  }
  for (const id of new Set([...beforeMarkers.keys(), ...afterMarkers.keys()])) {
    const a = beforeMarkers.get(id) || null, b = afterMarkers.get(id) || null;
    if (!same(a, b)) markerChanges.push({ entity: "marker", id, before: a ? clone(a) : null, after: b ? clone(b) : null });
  }

  const settingsBefore: TimelineSettings = { name: before.name, width: before.width, height: before.height, pixelAspectRatio: before.pixelAspectRatio, frameRate: clone(before.frameRate), metadata: clone(before.metadata) };
  const settingsAfter: TimelineSettings = { name: after.name, width: after.width, height: after.height, pixelAspectRatio: after.pixelAspectRatio, frameRate: clone(after.frameRate), metadata: clone(after.metadata) };
  const settingsChanges: EntityChange[] = same(settingsBefore, settingsAfter) ? [] : [{ entity: "settings", id: "timeline-settings", before: settingsBefore, after: settingsAfter }];
  const changes = [...settingsChanges, ...trackAdds, ...trackUpdates, ...clipChanges, ...markerChanges, ...trackRemoves];
  if (!changes.length) return null;
  const label = String(options.label || "Edit timeline").trim().slice(0, 120) || "Edit timeline";
  return {
    schemaVersion: 1,
    id: options.id || crypto.randomUUID(),
    label,
    origin: options.origin || "local",
    createdAt: options.createdAt || new Date().toISOString(),
    baseRevision: before.revision,
    changes
  };
}

function inverse(change: EntityChange): EntityChange {
  return { ...change, before: clone(change.after), after: clone(change.before) } as EntityChange;
}

function assertExpected(actual: unknown, expected: unknown, label: string): void {
  if (!same(actual, expected)) throw new Error("Timeline history conflict: " + label + " changed since this operation was recorded.");
}

function applyTrackChanges(timeline: EditorialTimeline, changes: EntityChange[]): { timeline: EditorialTimeline; removeIds: string[] } {
  const trackChanges = changes.filter((change): change is Extract<EntityChange, { entity: "track" }> => change.entity === "track");
  const current = new Map(timeline.tracks.map((track, index) => [track.id, { track, index }]));
  const desired = new Map<string, { track: TimelineTrack; index: number }>();
  for (const [id, value] of current) desired.set(id, { track: value.track, index: value.index });
  const removeIds: string[] = [];

  for (const change of trackChanges) {
    const found = current.get(change.id);
    const actual = found ? trackValue(found.track, found.index) : null;
    assertExpected(actual, change.before, "Track " + change.id);
    if (change.after === null) {
      if (!found) throw new Error("Timeline history conflict: track no longer exists.");
      removeIds.push(change.id);
      continue;
    }
    desired.set(change.id, {
      track: {
        id: change.after.id,
        name: change.after.name,
        kind: change.after.kind,
        enabled: change.after.enabled,
        locked: change.after.locked,
        clips: found ? found.track.clips : []
      },
      index: change.after.index
    });
  }

  const tracks = [...desired.entries()]
    .filter(([id]) => !removeIds.includes(id))
    .sort((a, b) => a[1].index - b[1].index)
    .map(([, value]) => value.track);
  // Removed tracks remain temporarily so clip removals can be applied before deletion.
  for (const id of removeIds) {
    const found = current.get(id);
    if (found && !tracks.some(track => track.id === id)) tracks.splice(Math.max(0, Math.min(found.index, tracks.length)), 0, found.track);
  }
  return { timeline: { ...timeline, tracks }, removeIds };
}

function applyEntityChange(timeline: EditorialTimeline, change: Exclude<EntityChange, { entity: "track" }>): EditorialTimeline {
  if (change.entity === "settings") {
    const actual: TimelineSettings = { name: timeline.name, width: timeline.width, height: timeline.height, pixelAspectRatio: timeline.pixelAspectRatio, frameRate: clone(timeline.frameRate), metadata: clone(timeline.metadata) };
    assertExpected(actual, change.before, "Timeline settings");
    return { ...timeline, ...clone(change.after) };
  }
  if (change.entity === "clip") {
    let current: Exclude<ClipLocation, null> | null = null;
    for (const track of timeline.tracks) {
      const clip = track.clips.find(item => item.id === change.id);
      if (clip) { current = { trackId: track.id, clip: clone(clip) }; break; }
    }
    assertExpected(current, change.before, "Clip " + change.id);
    const tracks = timeline.tracks.map(track => ({ ...track, clips: track.clips.filter(clip => clip.id !== change.id) }));
    if (change.after) {
      const destination = tracks.find(track => track.id === change.after!.trackId);
      if (!destination) throw new Error("Timeline history conflict: destination track no longer exists.");
      if (destination.locked) throw new Error("Cannot restore a clip to a locked track.");
      const clips = [...destination.clips, clone(change.after.clip)].sort((a, b) => seconds(a.timelineStart) - seconds(b.timelineStart));
      const destinationIndex = tracks.findIndex(track => track.id === destination.id);
      tracks[destinationIndex] = { ...destination, clips };
    }
    return { ...timeline, tracks };
  }

  const markerIndex = timeline.markers.findIndex(marker => marker.id === change.id);
  const current = markerIndex < 0 ? null : clone(timeline.markers[markerIndex]);
  assertExpected(current, change.before, "Marker " + change.id);
  const markers = [...timeline.markers];
  if (change.after === null) {
    if (markerIndex >= 0) markers.splice(markerIndex, 1);
  } else if (markerIndex < 0) {
    markers.push(clone(change.after));
  } else {
    markers[markerIndex] = clone(change.after);
  }
  markers.sort((a, b) => seconds(a.start) - seconds(b.start));
  return { ...timeline, markers };
}

/** Apply a validated operation or its inverse, rejecting stale or conflicting entity state. */
export function applyTimelineHistoryOperation(
  timeline: EditorialTimeline,
  operation: TimelineHistoryOperation,
  direction: "forward" | "undo" = "forward"
): EditorialTimeline {
  if (!operation || operation.schemaVersion !== 1 || !Array.isArray(operation.changes) || !operation.changes.length) {
    throw new Error("Timeline history operation is invalid.");
  }
  const changes = direction === "undo" ? [...operation.changes].reverse().map(inverse) : operation.changes;
  const trackResult = applyTrackChanges(timeline, changes);
  let next = trackResult.timeline;
  for (const change of changes) {
    if (change.entity !== "track") next = applyEntityChange(next, change);
  }
  for (const id of trackResult.removeIds) {
    const track = next.tracks.find(item => item.id === id);
    if (track?.clips.length) throw new Error("Cannot remove a track while it still contains clips.");
    next = { ...next, tracks: next.tracks.filter(item => item.id !== id) };
  }
  next = { ...next, revision: timeline.revision + 1, updatedAt: new Date().toISOString() };
  validateEditableTimeline(next);
  return next;
}

export function recordTimelineHistory(history: TimelineHistory, operation: TimelineHistoryOperation): TimelineHistory {
  if (operation.origin !== "local") return history;
  return {
    ...history,
    undo: [...history.undo, clone(operation)].slice(-history.limit),
    redo: []
  };
}

export function undoTimelineHistory(
  history: TimelineHistory,
  timeline: EditorialTimeline
): { timeline: EditorialTimeline; history: TimelineHistory; operation: TimelineHistoryOperation } | null {
  const operation = history.undo[history.undo.length - 1];
  if (!operation) return null;
  const nextTimeline = applyTimelineHistoryOperation(timeline, operation, "undo");
  return {
    timeline: nextTimeline,
    history: { ...history, undo: history.undo.slice(0, -1), redo: [...history.redo, operation] },
    operation
  };
}

export function redoTimelineHistory(
  history: TimelineHistory,
  timeline: EditorialTimeline
): { timeline: EditorialTimeline; history: TimelineHistory; operation: TimelineHistoryOperation } | null {
  const operation = history.redo[history.redo.length - 1];
  if (!operation) return null;
  const nextTimeline = applyTimelineHistoryOperation(timeline, operation, "forward");
  return {
    timeline: nextTimeline,
    history: { ...history, undo: [...history.undo, operation].slice(-history.limit), redo: history.redo.slice(0, -1) },
    operation
  };
}
