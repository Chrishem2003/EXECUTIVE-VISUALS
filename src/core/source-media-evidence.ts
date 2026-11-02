import type { EditorialTimeline } from "./timeline.ts";

export type SourceMediaStatus = "passed" | "review" | "blocked" | "not_run";
export interface SourceMediaAsset {
  id: string;
  name?: string;
  mediaType?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}
export interface SourceMediaEvidence {
  status: SourceMediaStatus;
  summary: string;
  evidenceRef: string;
  findings: Array<{ code: string; detail: string; clipId?: string; assetId?: string }>;
  counts: { referenced: number; probed: number; missing: number; invalid: number };
}
type Probe = { format?: { duration?: string | number }; streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string | number }> };
const seconds = (time: { value: number; rate: number }) => time.value / time.rate;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function assessSourceMediaEvidence(timeline: EditorialTimeline | null, assets: SourceMediaAsset[] = []): SourceMediaEvidence {
  const findings: SourceMediaEvidence["findings"] = [];
  if (!timeline || !timeline.tracks.some(track => track.clips.length)) {
    return { status: "not_run", summary: "No source clips are available to assess.", evidenceRef: "source-media:none", findings, counts: { referenced: 0, probed: 0, missing: 0, invalid: 0 } };
  }
  const library = new Map(assets.map(asset => [asset.id, asset]));
  const referenced = new Map<string, { clipId: string; trackKind: string; sourceEnd: number }[]>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    const rows = referenced.get(clip.assetId) || [];
    rows.push({ clipId: clip.id, trackKind: track.kind, sourceEnd: seconds(clip.sourceRange.start) + seconds(clip.sourceRange.duration) });
    referenced.set(clip.assetId, rows);
  }
  let probed = 0, missing = 0, invalid = 0, pending = 0;
  for (const [assetId, uses] of referenced) {
    const asset = library.get(assetId);
    if (!asset) {
      missing++;
      for (const use of uses) findings.push({ code: "SOURCE_ASSET_MISSING", detail: "Referenced media is not present in the current project asset library.", clipId: use.clipId, assetId });
      continue;
    }
    const probeValue = asset.metadata?.probe;
    if (!isObject(probeValue)) {
      pending++;
      findings.push({ code: "SOURCE_PROBE_NOT_RUN", detail: "Run the media probe before this source can pass integrity checks.", clipId: uses[0].clipId, assetId });
      continue;
    }
    const probe = probeValue as Probe;
    const duration = Number(probe.format?.duration);
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    if (!Number.isFinite(duration) || duration <= 0 || !streams.length) {
      invalid++;
      findings.push({ code: "SOURCE_PROBE_INVALID", detail: "Probe evidence is present but has no valid positive duration or readable streams.", clipId: uses[0].clipId, assetId });
      continue;
    }
    probed++;
    for (const use of uses) {
      const expected = use.trackKind === "video" || use.trackKind === "overlay" ? "video" : use.trackKind === "audio" ? "audio" : null;
      if (expected && !streams.some(stream => stream.codec_type === expected)) {
        invalid++;
        findings.push({ code: "SOURCE_STREAM_MISMATCH", detail: "The source has no " + expected + " stream required by this timeline track.", clipId: use.clipId, assetId });
      }
      if (Number.isFinite(use.sourceEnd) && use.sourceEnd > duration + 0.05) {
        invalid++;
        findings.push({ code: "SOURCE_RANGE_OUT_OF_BOUNDS", detail: "The selected source range ends at " + use.sourceEnd.toFixed(3) + "s, beyond the probed duration of " + duration.toFixed(3) + "s.", clipId: use.clipId, assetId });
      }
    }
  }
  const counts = { referenced: referenced.size, probed, missing, invalid, pending };
  const status: SourceMediaStatus = missing || invalid ? "blocked" : pending ? "not_run" : "passed";
  const summary = status === "blocked"
    ? missing + " missing source(s) and " + invalid + " invalid source check(s) need correction."
    : pending
      ? probed + " of " + referenced.size + " source(s) have probe evidence; " + pending + " remain unprobed."
      : "All " + referenced.size + " referenced source(s) have valid probe, stream-type and source-range evidence.";
  const fingerprint = [...referenced.keys()].sort().join(",").slice(0, 160);
  return { status, summary, evidenceRef: "source-media:probe:" + fingerprint, findings, counts };
}
