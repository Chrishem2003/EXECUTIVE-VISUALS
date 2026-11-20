import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { getVideoWorkflowOperationOptions } from "../../src/core/video-workflow-operations.mjs";

test("Seedance 2.5 exposes generation, video transformation and draft enhancement", () => {
  assert.deepEqual(getVideoWorkflowOperationOptions("runway", "seedance2_5").map(option => option.id), [
    "generate", "video-to-video", "draft-enhancement"
  ]);
});

test("Seedance enhancement is a stable operation option with a clear 1080p label", () => {
  const option = getVideoWorkflowOperationOptions("runway", "seedance2_5").find(value => value.id === "draft-enhancement");
  assert.deepEqual(option, { id: "draft-enhancement", label: "Enhance completed draft to 1080p" });
});

test("supported video-to-video models expose only operations they support", () => {
  for (const model of ["kling_4", "kling_4_flash", "gemini_omni_flash_1.2"]) {
    assert.deepEqual(getVideoWorkflowOperationOptions("runway", model).map(option => option.id), ["generate", "video-to-video"]);
  }
  assert.deepEqual(getVideoWorkflowOperationOptions("runway", "gen4.5").map(option => option.id), ["generate"]);
});

test("Luma operations and unknown providers remain separate from Runway draft enhancement", () => {
  assert.deepEqual(getVideoWorkflowOperationOptions("luma", "ray-3.2").map(option => option.id), ["generate", "edit", "reframe"]);
  assert.deepEqual(getVideoWorkflowOperationOptions("other", "seedance2_5").map(option => option.id), ["generate"]);
});

test("operation option objects are fresh so UI mutation cannot alter future menus", () => {
  const first = getVideoWorkflowOperationOptions("runway", "seedance2_5");
  first[2].label = "mutated";
  const second = getVideoWorkflowOperationOptions("runway", "seedance2_5");
  assert.equal(second[2].label, "Enhance completed draft to 1080p");
});

test("workflow editor uses the shared operation policy and reveals the draft source field dynamically", () => {
  const ui = readFileSync(new URL("../../src/platform/workflow-workspace.ts", import.meta.url), "utf8");
  assert.match(ui, /getVideoWorkflowOperationOptions\(provider,model\)/);
  assert.match(ui, /getVideoWorkflowOperationOptions\(provider,modelValue\)/);
  assert.match(ui, /data-wf-draft-enhancement/);
  assert.match(ui, /draftPanel\.hidden=activeOperation!=="draft-enhancement"/);
  assert.match(ui, /draftInput\.disabled=activeOperation!=="draft-enhancement"/);
});


test("Runway Model Router exposes text, first-frame and source-video operations",()=>{
  assert.deepEqual(getVideoWorkflowOperationOptions("runway","model-router").map(option=>option.id),[
    "text-to-video","image-to-video","video-to-video"
  ]);
});


test("workflow editor enables first-frame and source-video input for Runway Model Router",()=>{
  const ui=readFileSync(new URL("../../src/platform/workflow-workspace.ts",import.meta.url),"utf8");
  assert.match(ui,/routerRunway&&operation==="image-to-video"/);
  assert.match(ui,/routerRunway&&activeOperation==="image-to-video"/);
  assert.match(ui,/Choose a private first-frame image from this project/);
  assert.match(ui,/routerRunway&&activeOperation==="video-to-video"/);
  assert.match(ui,/routerRunway&&operation==="video-to-video"/);
});
