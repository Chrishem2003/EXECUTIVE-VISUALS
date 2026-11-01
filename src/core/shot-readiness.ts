import type { EpisodeShotPackage, EpisodeShotPackageItem } from "./series-production";

export type DeclaredShotCapabilities = {
  aspectRatios?: string[];
  resolutions?: string[];
  frameRates?: number[];
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxReferenceImages?: number;
  negativePrompt?: boolean;
};
export type ShotCapabilityStatus = "ready" | "blocked" | "unverified";
export type ShotCapabilityResult = {
  shotId: string;
  sequence: number;
  status: ShotCapabilityStatus;
  supported: string[];
  unsupported: string[];
  unverified: string[];
  durationSeconds: number;
  referenceCount: number;
};
export type ShotReadinessReport = {
  schemaVersion: 1;
  provider: string;
  model: string;
  status: ShotCapabilityStatus;
  readyShots: number;
  blockedShots: number;
  unverifiedShots: number;
  totalShots: number;
  shots: ShotCapabilityResult[];
  policy: { providerSubmitted: false; pricesEstimated: false; capabilitySource: "explicit-declaration-only" };
};

function resolutionAliases(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "4k" || normalized === "uhd") return ["2160p", "4k", "uhd"];
  if (normalized === "qhd") return ["1440p", "qhd"];
  return [normalized];
}

/** Preflight only: evaluates explicit model declarations and never submits a generation request. */
export function assessEpisodeShotReadiness(
  shotPackage: EpisodeShotPackage,
  selection: { provider: string; model: string; capabilities?: DeclaredShotCapabilities },
): ShotReadinessReport {
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!provider || !model) throw new Error("A provider and model label are required for readiness assessment.");
  const capabilities = selection.capabilities;
  const shots: ShotCapabilityResult[] = shotPackage.shots.map((shot: EpisodeShotPackageItem) => {
    const supported: string[] = [];
    const unsupported: string[] = [];
    const unverified: string[] = [];
    const check = (label: string, declared: boolean | undefined) => {
      if (declared === true) supported.push(label);
      else if (declared === false) unsupported.push(label);
      else unverified.push(label);
    };
    const ratioList = capabilities?.aspectRatios;
    check("aspectRatio:" + shot.aspectRatio, ratioList === undefined ? undefined : ratioList.includes(shot.aspectRatio));
    const requestedResolution = resolutionAliases(shot.resolution);
    const resolutionList = capabilities?.resolutions;
    check("resolution:" + shot.resolution, resolutionList === undefined ? undefined : resolutionList.some(value => requestedResolution.includes(value.trim().toLowerCase())));
    const frameRates = capabilities?.frameRates;
    check("frameRate:" + shot.frameRate, frameRates === undefined ? undefined : frameRates.includes(shot.frameRate));
    const minDuration = capabilities?.minDurationSeconds;
    const maxDuration = capabilities?.maxDurationSeconds;
    const durationOk = minDuration === undefined && maxDuration === undefined
      ? undefined
      : shot.durationSeconds >= (minDuration ?? 1) && shot.durationSeconds <= (maxDuration ?? 180);
    check("duration:" + shot.durationSeconds + "s", durationOk);
    if (shot.negativePrompt.trim()) check("negativePrompt", capabilities?.negativePrompt);
    if (shot.referenceAssetIds.length) {
      const max = capabilities?.maxReferenceImages;
      check("referenceImages:" + shot.referenceAssetIds.length, max === undefined ? undefined : shot.referenceAssetIds.length <= max);
    }
    const status: ShotCapabilityStatus = unsupported.length ? "blocked" : unverified.length ? "unverified" : "ready";
    return { shotId: shot.shotId, sequence: shot.sequence, status, supported, unsupported, unverified, durationSeconds: shot.durationSeconds, referenceCount: shot.referenceAssetIds.length };
  });
  const readyShots = shots.filter(shot => shot.status === "ready").length;
  const blockedShots = shots.filter(shot => shot.status === "blocked").length;
  const unverifiedShots = shots.filter(shot => shot.status === "unverified").length;
  const status: ShotCapabilityStatus = blockedShots ? "blocked" : unverifiedShots ? "unverified" : "ready";
  return {
    schemaVersion: 1, provider, model, status, readyShots, blockedShots, unverifiedShots, totalShots: shots.length, shots,
    policy: { providerSubmitted: false, pricesEstimated: false, capabilitySource: "explicit-declaration-only" },
  };
}
