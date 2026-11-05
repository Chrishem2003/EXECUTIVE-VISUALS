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
