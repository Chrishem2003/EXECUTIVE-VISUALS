import test from "node:test";
import assert from "node:assert/strict";
import { resolveCloudRenderSelection } from "../../src/core/cloud-render-selection.ts";

const timelineId = "timeline-current";
const otherTimelineId = "timeline-other";
const assetId = "asset-current";

test("selects a verified master for the exact selected timeline revision", () => {
  const result = resolveCloudRenderSelection({
    timelineId,
    timelineRevision: 4,
    jobs: [{ id: "job-4", status: "succeeded", input: { timelineId, timelineRevision: 4 }, output: { outputAsset: { id: "job-output" } } }],
    assets: [{ id: assetId, name: "Master r4.mp4", metadata: { operation: "timeline.render", timelineId, timelineRevision: 4 } }],
  });
  assert.deepEqual(result, {
    jobId: "job-4",
    jobStatus: "succeeded",
    outputAssetId: assetId,
    outputName: "Master r4.mp4",
    outputUrl: "",
  });
});

test("does not retain a previous output when the latest successful job has no output asset", () => {
  const result = resolveCloudRenderSelection({
    timelineId,
    timelineRevision: 4,
    jobs: [{ id: "job-4", status: "succeeded", input: { timelineId, timelineRevision: 4 }, output: {} }],
    assets: [],
  });
  assert.equal(result.jobId, "job-4");
  assert.equal(result.jobStatus, "succeeded");
  assert.equal(result.outputAssetId, "");
  assert.equal(result.outputName, "");
  assert.equal(result.outputUrl, "");
});

test("does not expose a completed output from an older timeline revision", () => {
  const result = resolveCloudRenderSelection({
    timelineId,
    timelineRevision: 5,
    jobs: [{ id: "job-4", status: "succeeded", input: { timelineId, timelineRevision: 4 }, output: { outputAsset: { id: "old-master", name: "Old master" } } }],
    assets: [{ id: "old-master", name: "Old master", metadata: { operation: "timeline.render", timelineId, timelineRevision: 4 } }],
  });
  assert.equal(result.jobId, "job-4");
  assert.equal(result.outputAssetId, "");
  assert.equal(result.outputName, "");
  assert.equal(result.outputUrl, "");
});

test("does not leak render state from a different selected timeline or project", () => {
  const result = resolveCloudRenderSelection({
    timelineId,
    timelineRevision: 1,
    jobs: [{ id: "other-job", status: "succeeded", input: { timelineId: otherTimelineId, timelineRevision: 1 }, output: { outputAsset: { id: "other-master" } } }],
    assets: [{ id: "other-master", name: "Other project master", metadata: { operation: "timeline.render", timelineId: otherTimelineId, timelineRevision: 1 } }],
  });
  assert.deepEqual(result, { jobId: "", jobStatus: "", outputAssetId: "", outputName: "", outputUrl: "" });
});

test("clears all render state when there is no selected timeline or valid revision", () => {
  for (const input of [
    { timelineId: "", timelineRevision: 1 },
    { timelineId, timelineRevision: 0 },
    { timelineId, timelineRevision: Number.NaN },
  ]) {
    assert.deepEqual(resolveCloudRenderSelection({ ...input, jobs: [], assets: [] }), {
      jobId: "", jobStatus: "", outputAssetId: "", outputName: "", outputUrl: "",
    });
  }
});
