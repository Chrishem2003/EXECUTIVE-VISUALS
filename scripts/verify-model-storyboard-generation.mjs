import test from "node:test";
import assert from "node:assert/strict";
import { buildModelStoryboardGenerationShots } from "../src/core/model-storyboard-generation.ts";

const storyboard = {
  id: "board-1",
  aspectRatio: "9:16",
  scenes: [{ shots: [{
    id: "shot-1", action: "A craftsperson shapes a clay vessel",
    visualPrompt: "Warm documentary close-up", motionPrompt: "Slow lateral camera move",
    framing: "Close-up", angle: "Eye level", movement: "Slow track",
    lighting: "Soft window light", continuityIn: "Hands enter frame",
    continuityOut: "Vessel turns toward camera", durationSeconds: 8
  }] }]
};

test("maps reviewed model storyboard shots into a non-billable preflight contract", () => {
  const [shot] = buildModelStoryboardGenerationShots(storyboard, {
    provider: "runway", model: "seedance2_5", resolution: "720p"
  });
  assert.equal(shot.id, "shot-1");
  assert.equal(shot.provider, "runway");
  assert.equal(shot.model, "seedance2_5");
  assert.equal(shot.durationSeconds, 8);
  assert.equal(shot.aspectRatio, "9:16");
  assert.equal(shot.audioMode, "none");
  assert.equal(shot.referenceImageCount, 0);
  assert.match(shot.prompt, /ACTION: A craftsperson/);
  assert.match(shot.prompt, /MOTION: Slow lateral/);
});

test("rejects empty, oversized, duplicate and invalid storyboard shot sets", () => {
  assert.throws(() => buildModelStoryboardGenerationShots({ ...storyboard, scenes: [] }, {
    provider: "runway", model: "seedance2_5", resolution: "720p"
  }), /1–12/);
  assert.throws(() => buildModelStoryboardGenerationShots({ ...storyboard, scenes: [{ shots: Array.from({ length: 13 }, (_, i) => ({ ...storyboard.scenes[0].shots[0], id: "s-" + i })) }] }, {
    provider: "runway", model: "seedance2_5", resolution: "720p"
  }), /1–12/);
  assert.throws(() => buildModelStoryboardGenerationShots({ ...storyboard, scenes: [{ shots: [{ ...storyboard.scenes[0].shots[0], id: "" }] }] }, {
    provider: "runway", model: "seedance2_5", resolution: "720p"
  }), /unique/);
  assert.throws(() => buildModelStoryboardGenerationShots({ ...storyboard, scenes: [{ shots: [{ ...storyboard.scenes[0].shots[0], durationSeconds: 0 }] }] }, {
    provider: "runway", model: "seedance2_5", resolution: "720p"
  }), /duration/);
  assert.throws(() => buildModelStoryboardGenerationShots({ ...storyboard, scenes: [{ shots: [{ ...storyboard.scenes[0].shots[0], action: "", visualPrompt: "", motionPrompt: "", framing: "", angle: "", movement: "", lighting: "", continuityIn: "", continuityOut: "" }] }] }, {
    provider: "runway", model: "seedance2_5", resolution: "720p"
  }), /non-empty generation prompt/);
});

test("requires an exact configured provider, model and resolution", () => {
  assert.throws(() => buildModelStoryboardGenerationShots(storyboard, { provider: "", model: "seedance2_5", resolution: "720p" }), /provider and exact model/);
  assert.throws(() => buildModelStoryboardGenerationShots(storyboard, { provider: "runway", model: "", resolution: "720p" }), /provider and exact model/);
  assert.throws(() => buildModelStoryboardGenerationShots(storyboard, { provider: "runway", model: "seedance2_5", resolution: "" }), /resolution/);
});
