import test from "node:test";
import assert from "node:assert/strict";
import { hasApprovedAncestor } from "../workflow-executor.mjs";
import { buildMediaOperationArgs } from "../media.mjs";
import { validateWorkflowGraph } from "../workflow-validation.mjs";

const graph = {
  nodes: [
    { id: "video-source", kind: "upload", inputs: [], outputs: [{ id: "video", type: "video" }], config: {} },
    { id: "audio-source", kind: "upload", inputs: [], outputs: [{ id: "audio", type: "audio" }], config: {} },
    { id: "rights-approval", kind: "approval", inputs: [{ id: "input", type: "any", required: true }], outputs: [{ id: "approved", type: "structured-data" }], config: {} },
    {
      id: "replace-soundtrack",
      kind: "video.replace-audio",
      inputs: [
        { id: "video", type: "video", required: true },
        { id: "audio", type: "audio", required: true },
        { id: "approval", type: "any", required: true }
      ],
      outputs: [{ id: "video", type: "video" }, { id: "asset", type: "asset" }],
      config: { sourceRightsConfirmed: true }
    }
  ],
  edges: [
    { id: "video-to-approval", sourceNodeId: "video-source", sourcePortId: "video", targetNodeId: "rights-approval", targetPortId: "input" },
    { id: "video-to-replace", sourceNodeId: "video-source", sourcePortId: "video", targetNodeId: "replace-soundtrack", targetPortId: "video" },
    { id: "audio-to-replace", sourceNodeId: "audio-source", sourcePortId: "audio", targetNodeId: "replace-soundtrack", targetPortId: "audio" },
    { id: "approval-to-replace", sourceNodeId: "rights-approval", sourcePortId: "approved", targetNodeId: "replace-soundtrack", targetPortId: "approval" }
  ]
};

test("soundtrack replacement workflow exposes typed video/audio inputs and a required approval edge", () => {
  assert.equal(validateWorkflowGraph(graph).valid, true);
});

test("soundtrack replacement cannot run without a completed approved ancestor", () => {
  assert.equal(hasApprovedAncestor(graph, "replace-soundtrack", new Map()), false);
  assert.equal(hasApprovedAncestor(graph, "replace-soundtrack", new Map([["rights-approval", { approved: false }]])), false);
  assert.equal(hasApprovedAncestor(graph, "replace-soundtrack", new Map([["rights-approval", { approved: true }]])), true);
});

test("soundtrack replacement maps the original picture and replacement audio without re-encoding video", () => {
  const args = buildMediaOperationArgs({
    jobType: "media.audio_replace",
    input: { replacementAudioPath: "/private/derived/dub.mp3" },
    sourcePath: "/private/source/original.mp4",
    outputPath: "/private/derived/localized.mp4"
  });
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-movflags")), [
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest"
  ]);
  assert.equal(args.at(-1), "/private/derived/localized.mp4");
});
