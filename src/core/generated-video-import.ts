export interface GeneratedVideoAsset {
  id: string;
  name: string;
  mediaType: string;
  projectId?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export function selectLatestGeneratedVideoAsset(
  assets: readonly GeneratedVideoAsset[],
  projectId: string
): GeneratedVideoAsset | null {
  return assets
    .filter(asset =>
      asset.projectId === projectId &&
      typeof asset.id === "string" && asset.id.length > 0 &&
      typeof asset.mediaType === "string" && asset.mediaType.startsWith("video/") &&
      asset.metadata?.source === "video-generation" &&
      asset.metadata?.validated === true
    )
    .slice()
    .sort((a, b) => {
      const left = Date.parse(a.createdAt || "");
      const right = Date.parse(b.createdAt || "");
      const leftTime = Number.isFinite(left) ? left : 0;
      const rightTime = Number.isFinite(right) ? right : 0;
      return rightTime - leftTime || a.id.localeCompare(b.id);
    })[0] || null;
}

export function generatedVideoDurationSeconds(
  asset: GeneratedVideoAsset,
  fallbackSeconds = 5
): number {
  const validation = asset.metadata?.validation;
  const duration = validation && typeof validation === "object" && !Array.isArray(validation)
    ? Number((validation as Record<string, unknown>).durationSeconds)
    : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : fallbackSeconds;
}

export function generatedVideoAlreadyOnTimeline(
  timeline: { tracks: Array<{ clips: Array<{ assetId: string }> }> },
  assetId: string
): boolean {
  return timeline.tracks.some(track => track.clips.some(clip => clip.assetId === assetId));
}
