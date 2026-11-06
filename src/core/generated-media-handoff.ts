import type { EditorialTimeline, TimelineClip, TrackKind } from "./timeline";

export type GeneratedMediaKind = "video" | "audio" | "image";

/**
 * A server-verified, project-scoped receipt for generated media.
 * Provider URLs and storage paths are deliberately not part of this contract.
 */
export interface GeneratedMediaReceipt {
  projectId: string;
  jobId: string;
  assetId: string;
  mediaType: string;
  kind: GeneratedMediaKind;
  durationSeconds?: number;
  verified: boolean;
  readable: boolean;
  sha256?: string;
}

export interface GeneratedMediaHandoffInput {
  timeline: EditorialTimeline;
  receipt: GeneratedMediaReceipt;
  targetTrackId: string;
  playheadSeconds: number;
  expectedRevision: number;
  clipId: string;
  clipName?: string;
}

export interface GeneratedMediaHandoff {
  trackId: string;
  expectedRevision: number;
  clip: TimelineClip;
}

export class GeneratedMediaHandoffError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GeneratedMediaHandoffError";
  }
}

const reject = (code: string, message: string): never => {
  throw new GeneratedMediaHandoffError(code, message);
};

function compatible(kind: GeneratedMediaKind, trackKind: TrackKind): boolean {
  if (kind === "audio") return trackKind === "audio";
  if (kind === "video") return trackKind === "video" || trackKind === "overlay";
  return trackKind === "video" || trackKind === "overlay";
}

/**
 * Validate and prepare a timeline insertion. This is intentionally a pure
 * preflight: it neither persists a timeline nor dispatches a generation job.
 * The caller must still save through the authenticated, revision-checked API.
 */
export function prepareGeneratedMediaHandoff(input: GeneratedMediaHandoffInput): GeneratedMediaHandoff {
  const { timeline, receipt } = input;
  if (!input || !timeline || !receipt) reject("HANDOFF_INVALID_INPUT", "A timeline and verified media receipt are required.");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    reject("HANDOFF_INVALID_REVISION", "An expected timeline revision is required.");
  }
  if (input.expectedRevision !== timeline.revision) {
    reject("HANDOFF_STALE_REVISION", "The timeline changed. Reload it before inserting generated media.");
  }
  if (typeof input.playheadSeconds !== "number" || !Number.isFinite(input.playheadSeconds) || input.playheadSeconds < 0) {
    reject("HANDOFF_INVALID_PLAYHEAD", "The playhead position must be a finite, non-negative time.");
  }
  if (!receipt.projectId || receipt.projectId !== timeline.projectId) {
    reject("HANDOFF_PROJECT_MISMATCH", "Generated media must belong to the active project.");
  }
  if (!receipt.jobId || !receipt.assetId || !receipt.mediaType) {
    reject("HANDOFF_INVALID_RECEIPT", "The media receipt is missing its job, asset or media type.");
  }
  if (!receipt.verified || !receipt.readable) {
    reject("HANDOFF_ASSET_NOT_READY", "The generated asset must be verified and readable before it can enter the timeline.");
  }
  if (!["video", "audio", "image"].includes(receipt.kind)) {
    reject("HANDOFF_UNSUPPORTED_MEDIA", "This generated media type cannot be inserted into the timeline.");
  }
  const prefix = receipt.mediaType.split("/")[0]?.toLowerCase();
  if ((receipt.kind === "video" && prefix !== "video") ||
      (receipt.kind === "audio" && prefix !== "audio") ||
      (receipt.kind === "image" && prefix !== "image")) {
    reject("HANDOFF_MEDIA_TYPE_MISMATCH", "The receipt's media kind does not match its verified media type.");
  }
  if (receipt.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(receipt.sha256)) {
    reject("HANDOFF_INVALID_CHECKSUM", "The media checksum must be a 64-character SHA-256 digest.");
  }
  if (!input.clipId || input.clipId.trim().length === 0) {
    reject("HANDOFF_INVALID_CLIP_ID", "A stable clip ID is required.");
  }
  if (!Number.isFinite(receipt.durationSeconds) || (receipt.durationSeconds ?? 0) <= 0) {
    reject("HANDOFF_INVALID_DURATION", "A verified positive duration is required before insertion.");
  }

  const track = timeline.tracks.find((item) => item.id === input.targetTrackId);
  if (!track) throw new GeneratedMediaHandoffError("HANDOFF_TRACK_NOT_FOUND", "Choose an existing timeline track.");
  if (track.locked) reject("HANDOFF_TRACK_LOCKED", "The target track is locked.");
  if (!compatible(receipt.kind, track.kind)) {
    reject("HANDOFF_TRACK_INCOMPATIBLE", "The target track cannot contain this media type.");
  }
  if (track.clips.some((item) => item.id === input.clipId)) {
    reject("HANDOFF_DUPLICATE_CLIP", "This clip ID already exists in the target track.");
  }

  const fps = timeline.frameRate.numerator / timeline.frameRate.denominator;
  if (!Number.isFinite(fps) || fps <= 0) reject("HANDOFF_INVALID_TIMELINE_RATE", "The timeline frame rate is invalid.");
  const timelineStartFrame = Math.round(input.playheadSeconds * fps);
  const sourceTimebase = 1000;
  const sourceDurationTicks = Math.round((receipt.durationSeconds as number) * sourceTimebase);
  if (sourceDurationTicks <= 0) reject("HANDOFF_INVALID_DURATION", "The media duration is too short for the supported timebase.");

  const clip: TimelineClip = {
    id: input.clipId,
    assetId: receipt.assetId,
    name: input.clipName?.trim() || `Generated ${receipt.kind}`,
    sourceRange: {
      start: { value: 0, rate: sourceTimebase },
      duration: { value: sourceDurationTicks, rate: sourceTimebase },
    },
    timelineStart: { value: timelineStartFrame, rate: fps },
    duration: { value: sourceDurationTicks, rate: sourceTimebase },
    enabled: true,
    metadata: {
      origin: "generated-media-handoff",
      generationJobId: receipt.jobId,
      verifiedSha256: receipt.sha256,
      sourceProjectId: receipt.projectId,
    },
  };

  // Do not permit silent overlap replacement. Timeline insertion remains an
  // explicit user action and the normal timeline validator is the final gate.
  const start = timelineStartFrame / fps;
  const end = start + sourceDurationTicks / sourceTimebase;
  for (const existing of track.clips) {
    const existingStart = existing.timelineStart.value / existing.timelineStart.rate;
    const existingEnd = existingStart + existing.duration.value / existing.duration.rate;
    if (start < existingEnd - 1e-6 && end > existingStart + 1e-6) {
      reject("HANDOFF_OVERLAP", "The insertion overlaps an existing clip. Choose an empty position or another track.");
    }
  }

  return { trackId: track.id, expectedRevision: input.expectedRevision, clip };
}
