const TOTAL_DURATIONS = new Set([5, 10, 15]);
const RATIOS = new Set(["1280:720", "720:1280", "960:960", "1920:1080", "1080:1920", "1440:1440"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, code = "RUNWAY_RECIPE_INVALID_INPUT") =>
  Object.assign(new Error(message), { code });

function resolutionTier(ratio) {
  return ["1920:1080", "1080:1920", "1440:1440"].includes(ratio) ? "1080p" : "720p";
}

/**
 * Plans a pinned Runway Multi-Shot Video Recipe request. This function never
 * calls Runway; first-frame media is resolved from the private asset library.
 */
export async function buildRunwayMultiShotRecipePayload({
  mode, prompt, shots, version = "2026-06", duration = 10,
  ratio = "1280:720", audio = true, firstFrameAssetId,
  projectId, getAuthorizedAssetContext, resolvePrivateAsset
} = {}) {
  if (!["auto", "custom"].includes(mode)) throw fail("Multi-Shot Video mode must be auto or custom.");
  if (!["2026-06", "unsafe-latest"].includes(version)) {
    throw fail("Unsupported Multi-Shot Video recipe version.");
  }
  if (!TOTAL_DURATIONS.has(duration)) throw fail("Multi-Shot Video duration must be 5, 10 or 15 seconds.");
  if (!RATIOS.has(ratio)) throw fail("Multi-Shot Video ratio is unsupported.");
  if (typeof audio !== "boolean") throw fail("Multi-Shot Video audio must be a boolean.");

  const payload = { version, mode, duration, ratio, audio };
  if (mode === "auto") {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2500) {
      throw fail("Auto mode requires a story prompt of 1–2,500 characters.");
    }
    if (shots !== undefined) throw fail("Auto mode does not accept a custom shot list.");
    payload.prompt = prompt.trim();
  } else {
    if (!Array.isArray(shots) || shots.length < 3 || shots.length > 5) {
      throw fail("Custom mode requires three to five ordered shots.");
    }
    if (prompt !== undefined) throw fail("Custom mode uses shot prompts instead of a story prompt.");
    let sum = 0;
    payload.shots = shots.map((shot, index) => {
      if (!shot || typeof shot.prompt !== "string" ||
          shot.prompt.trim().length < 3 || shot.prompt.length > 512 ||
          !Number.isInteger(shot.duration) || shot.duration < 1 || shot.duration > 15) {
        throw fail("Shot " + (index + 1) + " requires a 3–512 character prompt and a 1–15 second duration.");
      }
      sum += shot.duration;
      return { prompt: shot.prompt.trim(), duration: shot.duration };
    });
    if (sum !== duration) {
      throw fail("Custom shot durations must sum exactly to the requested total duration.", "RUNWAY_RECIPE_SHOT_DURATION_MISMATCH");
    }
  }

  if (firstFrameAssetId !== undefined) {
    if (typeof firstFrameAssetId !== "string" || !UUID.test(firstFrameAssetId)) {
      throw fail("First-frame asset ID must be a valid private asset UUID.");
    }
    if (typeof projectId !== "string" || !UUID.test(projectId) ||
        typeof getAuthorizedAssetContext !== "function" ||
        typeof resolvePrivateAsset !== "function") {
      throw fail("First-frame input requires authenticated project access and private asset resolution.", "RUNWAY_RECIPE_ASSET_GATES_MISSING");
    }
    let scope;
    try { scope = await getAuthorizedAssetContext({ projectId }); }
    catch { throw fail("The active user is not authorized for this recipe project.", "RUNWAY_RECIPE_ASSET_FORBIDDEN"); }
    if (!scope || typeof scope.ownerId !== "string" || !UUID.test(scope.ownerId) || scope.projectId !== projectId) {
      throw fail("Authenticated recipe project scope is invalid.", "RUNWAY_RECIPE_ASSET_FORBIDDEN");
    }
    let resolved;
    try {
      resolved = await resolvePrivateAsset({
        assetId: firstFrameAssetId, ownerId: scope.ownerId,
        projectId: scope.projectId, mediaType: "image"
      });
    } catch {
      throw fail("Private first-frame image could not be resolved.", "RUNWAY_RECIPE_ASSET_UNAVAILABLE");
    }
    if (typeof resolved?.uri !== "string" ||
        !(resolved.uri.startsWith("https://") || resolved.uri.startsWith("runway://") ||
          resolved.uri.startsWith("data:image/")) ||
        !(resolved.mediaType === "image" ||
          (typeof resolved.mediaType === "string" && resolved.mediaType.startsWith("image/")))) {
      throw fail("Resolved first-frame asset must be an authorized image with a valid URI.", "RUNWAY_RECIPE_ASSET_INVALID");
    }
    payload.firstFrame = { uri: resolved.uri };
  }

  const tier = resolutionTier(ratio);
  const creditsPerSecond = tier === "1080p" ? 17 : 13;
  return Object.freeze({
    payload: Object.freeze(payload),
    estimate: Object.freeze({
      resolutionTier: tier,
      creditsPerSecond,
      estimatedCredits: duration * creditsPerSecond,
      pricingSource: "https://docs.dev.runwayml.com/guides/pricing/",
      pricingVersion: version
    })
  });
}
