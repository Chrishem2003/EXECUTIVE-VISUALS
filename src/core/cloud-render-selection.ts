export interface CloudRenderSelectionJob {
  id: string;
  status: string;
  input?: { timelineId?: string; timelineRevision?: number };
  output?: { outputAsset?: { id?: string; name?: string } };
}

export interface CloudRenderSelectionAsset {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface CloudRenderSelection {
  jobId: string;
  jobStatus: string;
  outputAssetId: string;
  outputName: string;
  outputUrl: string;
}

/**
 * Resolve render state only from the currently selected timeline and revision.
 * Always returns a complete state object so callers cannot accidentally retain
 * a preview URL or output from a previously selected project/timeline.
 */
export function resolveCloudRenderSelection({
  timelineId,
  timelineRevision,
  jobs,
  assets,
}: {
  timelineId: string | null | undefined;
  timelineRevision: number;
  jobs: readonly CloudRenderSelectionJob[];
  assets: readonly CloudRenderSelectionAsset[];
}): CloudRenderSelection {
  const empty: CloudRenderSelection = {
    jobId: "",
    jobStatus: "",
    outputAssetId: "",
    outputName: "",
    outputUrl: "",
  };
  if (!timelineId || !Number.isSafeInteger(timelineRevision) || timelineRevision < 1) return empty;

  // The API returns newest-first history. Keep its newest job for status display,
  // but never treat a successful render from another revision as this revision's master.
  const activeJob = jobs.find((job) => job.input?.timelineId === timelineId);
  const verifiedMaster = assets.find((asset) =>
    asset.metadata?.operation === "timeline.render" &&
    asset.metadata?.timelineId === timelineId &&
    Number(asset.metadata?.timelineRevision) === timelineRevision
  );
  const completedOutput =
    activeJob?.status === "succeeded" &&
    Number(activeJob.input?.timelineRevision) === timelineRevision
      ? activeJob.output?.outputAsset
      : undefined;
  const output = verifiedMaster ?? (completedOutput?.id ? completedOutput : undefined);

  return {
    jobId: activeJob?.id || "",
    jobStatus: activeJob?.status || "",
    outputAssetId: output?.id || "",
    outputName: output?.name || verifiedMaster?.name || (output?.id ? "Verified cloud master" : ""),
    outputUrl: "",
  };
}
