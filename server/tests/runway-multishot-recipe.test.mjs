import test from "node:test";
import assert from "node:assert/strict";
import { buildRunwayMultiShotRecipePayload } from "../runway-multishot-recipe.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "44444444-4444-4444-8444-444444444444";

test("auto mode validates story prompt and pins the recipe version", async () => {
  const result = await buildRunwayMultiShotRecipePayload({
    mode: "auto", prompt: "A premium product is revealed at sunrise",
    duration: 10, ratio: "1280:720"
  });
  assert.deepEqual(result.payload, {
    version: "2026-06", mode: "auto", duration: 10,
    ratio: "1280:720", audio: true,
    prompt: "A premium product is revealed at sunrise"
  });
  assert.deepEqual(result.estimate, {
    resolutionTier: "720p", creditsPerSecond: 13,
    estimatedCredits: 130,
    pricingSource: "https://docs.dev.runwayml.com/guides/pricing/",
    pricingVersion: "2026-06"
  });
});

test("custom mode requires three to five shots whose durations sum to the total", async () => {
  const result = await buildRunwayMultiShotRecipePayload({
    mode: "custom", duration: 10, ratio: "1920:1080",
    shots: [
      { prompt: "Wide establishing shot of the product", duration: 3 },
      { prompt: "Close-up of the product detail", duration: 3 },
      { prompt: "Hero shot with a smooth camera move", duration: 4 }
    ]
  });
  assert.equal(result.payload.shots.length, 3);
  assert.equal(result.estimate.resolutionTier, "1080p");
  assert.equal(result.estimate.estimatedCredits, 170);
  assert.equal(result.payload.shots.reduce((sum, shot) => sum + shot.duration, 0), 10);
});

test("multi-shot recipe rejects invalid modes, versions, ratios, prompts and shot totals", async () => {
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({ mode: "other", prompt: "x" }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({ mode: "auto", prompt: " " }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({ mode: "auto", prompt: "x".repeat(2501) }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({ mode: "auto", prompt: "story", version: "unsafe" }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({ mode: "auto", prompt: "story", ratio: "21:9" }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({ mode: "auto", prompt: "story", duration: 8 }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "auto", prompt: "story", shots: []
  }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "custom", duration: 10,
    shots: [{ prompt: "one", duration: 5 }, { prompt: "two", duration: 5 }]
  }));
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "custom", duration: 10,
    shots: [
      { prompt: "first shot", duration: 3 },
      { prompt: "second shot", duration: 3 },
      { prompt: "third shot", duration: 3 }
    ]
  }), error => error.code === "RUNWAY_RECIPE_SHOT_DURATION_MISMATCH");
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "custom", duration: 5,
    shots: [
      { prompt: "first shot", duration: 1 },
      { prompt: "second shot", duration: 2 },
      { prompt: "third shot", duration: 2 }
    ]
  }));
});

test("first-frame media resolves through authenticated private project scope", async () => {
  const calls = [];
  const result = await buildRunwayMultiShotRecipePayload({
    mode: "auto", prompt: "A cinematic reveal", firstFrameAssetId: assetId,
    projectId,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId }),
    resolvePrivateAsset: async args => {
      calls.push(args);
      return { uri: "https://private.example.com/first-frame.png" };
    }
  });
  assert.deepEqual(result.payload.firstFrame, { uri: "https://private.example.com/first-frame.png" });
  assert.deepEqual(calls, [{ assetId, ownerId, projectId, mediaType: "image" }]);
});

test("first-frame media fails closed without project authorization or valid private URI", async () => {
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "auto", prompt: "A cinematic reveal", firstFrameAssetId: assetId,
    projectId, resolvePrivateAsset: async () => ({ uri: "https://private.example.com/image.png" })
  }), error => error.code === "RUNWAY_RECIPE_ASSET_GATES_MISSING");
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "auto", prompt: "A cinematic reveal", firstFrameAssetId: assetId,
    projectId,
    getAuthorizedAssetContext: async () => { throw new Error("denied"); },
    resolvePrivateAsset: async () => ({ uri: "https://private.example.com/image.png" })
  }), error => error.code === "RUNWAY_RECIPE_ASSET_FORBIDDEN");
  await assert.rejects(() => buildRunwayMultiShotRecipePayload({
    mode: "auto", prompt: "A cinematic reveal", firstFrameAssetId: assetId,
    projectId,
    getAuthorizedAssetContext: async () => ({ ownerId, projectId }),
    resolvePrivateAsset: async () => ({ uri: "https://private.example.com/video.mp4" })
  }), error => error.code === "RUNWAY_RECIPE_ASSET_INVALID");
});
