import assert from "node:assert/strict";
import { validateWorkflow, planWorkflowExecution } from "../src/core/workflow.ts";

const port = (id, type, required = true, multiple = false) => ({ id, label: id, type, required, multiple });
const node = (id, kind, inputs, outputs, extra = {}) => ({
  id, kind, label: id, inputs, outputs, config: {}, ...extra
});
const graph = {
  id: "workflow-test",
  projectId: "project-test",
  revision: 1,
  nodes: [
    node("brief", "text", [], [port("text", "text")]),
    node("image", "image.generate", [port("prompt", "text")], [port("image", "image")]),
    node("video", "video.generate", [port("image", "image")], [port("video", "video")]),
    node("audio", "voice.generate", [port("script", "text")], [port("audio", "audio")])
  ],
  edges: [
    { id: "e1", sourceNodeId: "brief", sourcePortId: "text", targetNodeId: "image", targetPortId: "prompt" },
    { id: "e2", sourceNodeId: "image", sourcePortId: "image", targetNodeId: "video", targetPortId: "image" },
    { id: "e3", sourceNodeId: "brief", sourcePortId: "text", targetNodeId: "audio", targetPortId: "script" }
  ]
};

assert.equal(validateWorkflow(graph).valid, true, "valid graph should pass validation");
const nodePlan = planWorkflowExecution(graph, { kind: "node", nodeId: "video" });
assert.equal(nodePlan.valid, true);
assert.deepEqual(nodePlan.includedNodeIds, ["brief", "image", "video"], "single-node execution includes only upstream dependencies");
assert.equal(nodePlan.includedNodeIds.includes("audio"), false, "unrelated sibling branch is not rerun");

const lockedGraph = structuredClone(graph);
lockedGraph.nodes.find(item => item.id === "image").locked = true;
lockedGraph.nodes.find(item => item.id === "image").lockedOutputIds = ["asset-image-1"];
const lockedPlan = planWorkflowExecution(lockedGraph, { kind: "node", nodeId: "video" });
assert.equal(lockedPlan.valid, true);
assert.deepEqual(lockedPlan.includedNodeIds, ["image", "video"], "locked upstream output cuts off upstream reruns");
assert.deepEqual(lockedPlan.runNodeIds, ["video"]);
assert.deepEqual(lockedPlan.reusedNodeIds, ["image"]);

const allPlan = planWorkflowExecution(lockedGraph);
assert.equal(allPlan.valid, true);
assert.deepEqual(allPlan.reusedNodeIds, ["image"], "full run also reuses locked output");
assert.equal(allPlan.runNodeIds.includes("brief"), true, "full run retains unrelated graph nodes");

const missingLockedOutput = structuredClone(lockedGraph);
missingLockedOutput.nodes.find(item => item.id === "image").lockedOutputIds = [];
const lockedError = planWorkflowExecution(missingLockedOutput, { kind: "node", nodeId: "video" });
assert.equal(lockedError.valid, false);
assert.equal(lockedError.issues.some(issue => issue.code === "locked_node_missing_output"), true);

const missingMultiInput = {
  ...graph,
  nodes: [node("multi", "image.edit", [port("references", "image", true, true)], [port("image", "image")])],
  edges: []
};
assert.equal(validateWorkflow(missingMultiInput).issues.some(issue => issue.code === "required_input_unconnected"), true,
  "required multi-input ports still need at least one source");

const cycleGraph = {
  ...graph,
  nodes: [
    node("a", "text", [port("feedback", "text", false)], [port("out", "text")]),
    node("b", "llm.prompt", [port("in", "text")], [port("out", "text")])
  ],
  edges: [
    { id: "ab", sourceNodeId: "a", sourcePortId: "out", targetNodeId: "b", targetPortId: "in" },
    { id: "ba", sourceNodeId: "b", sourcePortId: "out", targetNodeId: "a", targetPortId: "feedback" }
  ]
};
assert.equal(validateWorkflow(cycleGraph).issues.some(issue => issue.code === "cycle_detected"), true);

const invalidTarget = planWorkflowExecution(graph, { kind: "node", nodeId: "missing" });
assert.equal(invalidTarget.valid, false);
assert.equal(invalidTarget.issues.some(issue => issue.code === "invalid_execution_target"), true);

console.log("Workflow engine checks passed: validation, targeted runs, sibling isolation, locked outputs, required multi-inputs, cycles and invalid targets.");
