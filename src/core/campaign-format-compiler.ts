import { createTimelineVariant } from "./timeline-variants.ts";
import { validateTimeline, type EditorialTimeline } from "./timeline.ts";

export const CAMPAIGN_FORMATS = Object.freeze({
  landscape_16_9: Object.freeze({
    id: "landscape_16_9",
    label: "Landscape master",
    width: 1920,
    height: 1080,
    aspectRatio: "16:9",
    channelIntent: "YouTube, web video and landscape placements",
    safeArea: Object.freeze({ left: 6, right: 6, top: 10, bottom: 14 })
  }),
  vertical_9_16: Object.freeze({
    id: "vertical_9_16",
    label: "Vertical short-form",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    channelIntent: "TikTok, Reels, Shorts and vertical placements",
    safeArea: Object.freeze({ left: 8, right: 8, top: 14, bottom: 22 })
  }),
  square_1_1: Object.freeze({
    id: "square_1_1",
    label: "Square feed",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
    channelIntent: "Square social feed placements",
    safeArea: Object.freeze({ left: 7, right: 7, top: 10, bottom: 16 })
  }),
  portrait_4_5: Object.freeze({
    id: "portrait_4_5",
    label: "Portrait feed",
    width: 1080,
    height: 1350,
    aspectRatio: "4:5",
    channelIntent: "Portrait social feed placements",
    safeArea: Object.freeze({ left: 7, right: 7, top: 10, bottom: 18 })
  })
} as const);

export type CampaignFormatId = keyof typeof CAMPAIGN_FORMATS;
export interface CampaignFormatVariant {
  formatId: CampaignFormatId;
  label: string;
  timeline: EditorialTimeline;
  target: {
    width: number;
    height: number;
    aspectRatio: string;
    channelIntent: string;
    safeArea: { left: number; right: number; top: number; bottom: number };
  };
  reviewRequired: true;
  renderReady: false;
}
export interface CampaignDeliveryManifest {
  schemaVersion: 1;
  sourceTimelineId: string;
  sourceRevision: number;
  projectId: string;
  createdAt: string;
  totalVariants: number;
  totalSourceClips: number;
  status: "awaiting_reframe_review";
  variants: Array<{
    timelineId: string;
    formatId: CampaignFormatId;
    width: number;
    height: number;
    aspectRatio: string;
    reviewRequired: true;
    renderReady: false;
  }>;
}
export interface CompileCampaignFormatsOptions {
  sourceTimeline: EditorialTimeline;
  formats?: CampaignFormatId[];
  createdAt?: string;
  idFactory?: (formatId: CampaignFormatId, index: number) => string;
}

/**
 * Creates independent, lineage-linked timeline variants for common campaign
 * canvases. It never crops clips or claims an export is ready: each variant
 * carries explicit reframe and human-review requirements.
 */
export function compileCampaignFormatVariants({
  sourceTimeline,
  formats = Object.keys(CAMPAIGN_FORMATS) as CampaignFormatId[],
  createdAt = new Date().toISOString(),
  idFactory
}: CompileCampaignFormatsOptions): { variants: CampaignFormatVariant[]; manifest: CampaignDeliveryManifest } {
  if (!sourceTimeline || typeof sourceTimeline !== "object") {
    throw new Error("A source editorial timeline is required.");
  }
  const validation = validateTimeline(sourceTimeline);
  if (!validation.valid) {
    throw new Error("Cannot compile campaign formats from an invalid timeline: " + validation.issues[0].message);
  }
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Campaign format compilation time must be a valid timestamp.");
  if (!Array.isArray(formats) || formats.length < 1 || formats.length > 4) {
    throw new Error("Select between one and four campaign formats.");
  }
  if (new Set(formats).size !== formats.length) throw new Error("Campaign formats must be unique.");

  const makeId = idFactory ?? (() => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      throw new Error("A secure UUID generator must be supplied for this runtime.");
    }
    return globalThis.crypto.randomUUID();
  });
  const ids = new Set<string>();
  const variants = formats.map((formatId, index): CampaignFormatVariant => {
    const format = CAMPAIGN_FORMATS[formatId];
    if (!format) throw new Error("Unsupported campaign format: " + String(formatId));
    const id = makeId(formatId, index);
    if (typeof id !== "string" || !id.trim() || id === sourceTimeline.id || ids.has(id)) {
      throw new Error("Campaign format variants require unique, non-empty timeline IDs.");
    }
    ids.add(id);
    const timeline = createTimelineVariant(
      sourceTimeline,
      id,
      sourceTimeline.name + " — " + format.label,
      createdAt
    );
    timeline.width = format.width;
    timeline.height = format.height;
    timeline.metadata = {
      ...(timeline.metadata ?? {}),
      campaignDelivery: {
        schemaVersion: 1,
        formatId,
        label: format.label,
        channelIntent: format.channelIntent,
        aspectRatio: format.aspectRatio,
        safeAreaPercent: { ...format.safeArea },
        reframe: {
          status: "required",
          reason: "Canvas dimensions changed; clip framing, subject position and overlays require review."
        },
        review: { required: true, status: "pending" },
        export: { renderReady: false, status: "not_started" }
      }
    };
    const nextValidation = validateTimeline(timeline);
    if (!nextValidation.valid) {
      throw new Error("Compiled " + formatId + " timeline is invalid: " + nextValidation.issues[0].message);
    }
    return {
      formatId,
      label: format.label,
      timeline,
      target: {
        width: format.width,
        height: format.height,
        aspectRatio: format.aspectRatio,
        channelIntent: format.channelIntent,
        safeArea: { ...format.safeArea }
      },
      reviewRequired: true,
      renderReady: false
    };
  });

  const totalSourceClips = sourceTimeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  const manifest: CampaignDeliveryManifest = {
    schemaVersion: 1,
    sourceTimelineId: sourceTimeline.id,
    sourceRevision: sourceTimeline.revision,
    projectId: sourceTimeline.projectId,
    createdAt: new Date(createdAt).toISOString(),
    totalVariants: variants.length,
    totalSourceClips,
    status: "awaiting_reframe_review",
    variants: variants.map(variant => ({
      timelineId: variant.timeline.id,
      formatId: variant.formatId,
      width: variant.target.width,
      height: variant.target.height,
      aspectRatio: variant.target.aspectRatio,
      reviewRequired: true,
      renderReady: false
    }))
  };
  return { variants, manifest };
}
