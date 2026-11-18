import test from "node:test";
import assert from "node:assert/strict";
import { getVideoWorkflowModelOptions, isVideoWorkflowModelReleaseBlocked } from "../../src/core/video-workflow-model-policy.mjs";

test("cloud workflow model picker only offers models that pass the current release gate", () => {
  const ids = getVideoWorkflowModelOptions("runway").map(option => option.id);
  assert.deepEqual(ids, ["model-router", "gen4.5", "seedance2_5", "kling_4", "kling3.0_standard", "kling3.0_pro", "kling3.0_4k"]);
  assert.equal(ids.includes("kling_4_flash"), false);
  assert.equal(ids.includes("gemini_omni_flash_1.2"), false);
});

test("legacy saved blocked model remains visible but cannot be selected", () => {
  for (const model of ["kling_4_flash", "gemini_omni_flash_1.2"]) {
    assert.equal(isVideoWorkflowModelReleaseBlocked(model), true);
    const option = getVideoWorkflowModelOptions("runway", model).find(item => item.id === model);
    assert.ok(option);
    assert.equal(option.disabled, true);
    assert.match(option.label, /unavailable \(release gate\)/);
  }
});

test("Luma model selection is not polluted by Runway release-gated models", () => {
  assert.deepEqual(getVideoWorkflowModelOptions("luma"), [{ id: "ray-3.2", label: "Luma Ray 3.2", disabled: false }]);
});
