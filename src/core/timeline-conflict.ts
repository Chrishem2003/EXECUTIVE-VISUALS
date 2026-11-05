export interface CloudTimelineDraftContext {
  hasConflict: boolean;
  timelineId: string | null | undefined;
  timelineProjectId: string | null | undefined;
  selectedProjectId: string | null | undefined;
}

/** Keep the in-memory draft authoritative until the user explicitly resolves its conflict. */
export function shouldPreserveCloudTimelineDraft(context: CloudTimelineDraftContext): boolean {
  return context.hasConflict &&
    typeof context.timelineId === "string" && context.timelineId.length > 0 &&
    typeof context.timelineProjectId === "string" && context.timelineProjectId.length > 0 &&
    context.timelineProjectId === context.selectedProjectId;
}

export interface CloudTimelineSnapshot<TTimeline> {
  id: string;
  projectId?: string | null;
  revision: number;
  timeline: TTimeline;
}

export interface CloudTimelineRefreshResult<TTimeline> {
  timeline: TTimeline | null;
  serverRevision: number;
  preservedLocalDraft: boolean;
}

/**
 * Resolve a cloud refresh without replacing a conflicted local draft.
 * The stale revision is deliberately retained until the user chooses recovery.
 */
export function resolveCloudTimelineRefresh<TTimeline extends { id: string; projectId?: string | null }>(
  context: CloudTimelineDraftContext,
  currentTimeline: TTimeline | null,
  currentServerRevision: number,
  serverTimelines: readonly CloudTimelineSnapshot<TTimeline>[]
): CloudTimelineRefreshResult<TTimeline> {
  if (currentTimeline && shouldPreserveCloudTimelineDraft(context)) {
    return {
      timeline: currentTimeline,
      serverRevision: currentServerRevision,
      preservedLocalDraft: true
    };
  }

  const saved = currentTimeline
    ? serverTimelines.find(item => item.id === currentTimeline.id)
    : undefined;
  const selected = saved || serverTimelines[0];

  return {
    timeline: selected?.timeline || null,
    serverRevision: selected?.revision || 0,
    preservedLocalDraft: false
  };
}
