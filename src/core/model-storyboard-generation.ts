export type ModelStoryboardGenerationInput = {
  id: string;
  aspectRatio: string;
  targetDurationSeconds: number;
  scenes: Array<{ shots: Array<{
    id: string;
    action?: string;
    visualPrompt?: string;
    motionPrompt?: string;
    framing?: string;
    angle?: string;
    movement?: string;
    lighting?: string;
    continuityIn?: string;
    continuityOut?: string;
    durationSeconds: number;
  }> }>;
};

export type ModelStoryboardGenerationOptions = {
  provider: string;
  model: string;
  resolution: string;
};

export type VideoGenerationShot = {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  audioMode: "none";
  referenceImageCount: 0;
};

/**
 * Convert a reviewed model storyboard into the exact, non-billable video
 * preflight contract. This creates no jobs and never calls a provider.
 */
export function buildModelStoryboardGenerationShots(
  storyboard: ModelStoryboardGenerationInput,
  options: ModelStoryboardGenerationOptions
): VideoGenerationShot[] {
  if (!storyboard || typeof storyboard !== "object" || !Array.isArray(storyboard.scenes)) {
    throw new Error("Generate and review a model storyboard before preparing video generation.");
  }
  if (typeof options?.provider !== "string" || !options.provider.trim() ||
      typeof options?.model !== "string" || !options.model.trim()) {
    throw new Error("A configured video provider and exact model are required.");
  }
  if (typeof options.resolution !== "string" || !options.resolution.trim()) {
    throw new Error("A supported output resolution is required.");
  }
  const sourceShots = storyboard.scenes.flatMap(scene => Array.isArray(scene?.shots) ? scene.shots : []);
  if (sourceShots.length < 1 || sourceShots.length > 12) {
    throw new Error("Video generation supports 1–12 reviewed storyboard shots per approved production. Split larger storyboards into smaller segments.");
  }
  if (sourceShots.some(shot => !shot || !Number.isInteger(shot.durationSeconds) || shot.durationSeconds < 1 || shot.durationSeconds > 60)) {
    throw new Error("Every planned shot must have a whole-number duration between 1 and 60 seconds.");
  }
  const totalDurationSeconds = sourceShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  if (!Number.isInteger(storyboard.targetDurationSeconds) || storyboard.targetDurationSeconds < 1) {
    throw new Error("The storyboard must retain a valid target runtime.");
  }
  const tolerance = Math.max(2, Math.round(storyboard.targetDurationSeconds * 0.05));
  if (Math.abs(totalDurationSeconds - storyboard.targetDurationSeconds) > tolerance) {
    throw new Error("Reviewed shot durations total " + totalDurationSeconds + " seconds, outside the target runtime of " + storyboard.targetDurationSeconds + " seconds. Rebalance the shots before generation.");
  }
  const ids = new Set<string>();
  return sourceShots.map((shot, index) => {
    if (!shot || typeof shot.id !== "string" || !shot.id.trim() || ids.has(shot.id)) {
      throw new Error("Every planned shot must have a unique, non-empty source ID.");
    }
    ids.add(shot.id);
    if (!Number.isInteger(shot.durationSeconds) || shot.durationSeconds < 1 || shot.durationSeconds > 60) {
      throw new Error("Shot " + (index + 1) + " must have a whole-number duration between 1 and 60 seconds.");
    }
    const prompt = [
      shot.action && "ACTION: " + shot.action,
      shot.visualPrompt && "VISUAL: " + shot.visualPrompt,
      shot.motionPrompt && "MOTION: " + shot.motionPrompt,
      shot.framing && "FRAMING: " + shot.framing,
      shot.angle && "CAMERA ANGLE: " + shot.angle,
      shot.movement && "CAMERA MOVEMENT: " + shot.movement,
      shot.lighting && "LIGHTING: " + shot.lighting,
      shot.continuityIn && "CONTINUITY IN: " + shot.continuityIn,
      shot.continuityOut && "CONTINUITY OUT: " + shot.continuityOut
    ].filter(Boolean).join("\n\n").trim();
    if (!prompt || prompt.length > 12000) {
      throw new Error("Shot " + (index + 1) + " needs a non-empty generation prompt no longer than 12,000 characters.");
    }
    return {
      id: shot.id,
      provider: options.provider,
      model: options.model,
      prompt,
      durationSeconds: shot.durationSeconds,
      aspectRatio: storyboard.aspectRatio,
      resolution: options.resolution,
      audioMode: "none",
      referenceImageCount: 0
    };
  });
}
