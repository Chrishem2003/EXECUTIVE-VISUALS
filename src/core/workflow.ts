import type { Capability } from "./contracts";

export type MediaPortType =
  | "text" | "image" | "video" | "audio" | "mask" | "document"
  | "script" | "storyboard" | "character" | "voice" | "transcript"
  | "subtitle-file" | "asset" | "media" | "creative-set" | "any"
  | "identity-reference" | "style-reference" | "product-reference"
  | "start-frame" | "end-frame" | "keyframe" | "motion-reference"
  | "timeline" | "structured-data" | "3d-scene" | "mesh" | "camera-data"
  | "timecode" | "proxy" | "timeline-package";

export type WorkflowNodeKind =
  | "prompt" | "text" | "upload" | "reference" | "script" | "storyboard"
  | "image.generate" | "image.edit" | "image.upscale" | "image.remove-background"
  | "video.generate" | "video.extract-frame" | "video.stitch" | "video.add-audio"
  | "video.extract-audio" | "video.reframe"
  | "avatar.generate" | "voice.generate" | "voice.transcribe" | "voice.caption"
  | "voice.translate" | "voice.lipsync"
  | "llm.prompt" | "llm.analyze"
  | "utility.frame-extract" | "utility.video-stitch" | "utility.audio-add"
  | "utility.audio-extract" | "utility.reframe" | "utility.remove-background"
  | "utility.convert" | "utility.compress"
  | "media.process" | "media.upscale" | "media.denoise" | "media.interpolate"
  | "media.stabilize" | "media.remove-object" | "media.convert" | "media.compress"
  | "media.audio-extract" | "media.color-match" | "media.compare"
  | "campaign.create" | "approval" | "quality-check" | "timeline" | "export"
  | "connector" | "branch" | "merge" | "batch" | "subworkflow" | "knowledge.search";

export interface WorkflowPort {
  id: string;
  label: string;
  type: MediaPortType;
  required?: boolean;
  multiple?: boolean;
}

export type WorkflowCachePolicy = "default" | "bypass" | "reuse-only";
export interface WorkflowRetryPolicy {
  maxAttempts: number;
  retryableCodes?: string[];
  backoffMs?: number;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  capability?: Capability;
  label: string;
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
  config: Record<string, unknown>;
  position?: { x: number; y: number };
  /** A locked node reuses its frozen outputs on subsequent runs. */
  locked?: boolean;
  lockedOutputIds?: string[];
  providerId?: string;
  modelId?: string;
  capabilityVersion?: number;
  settingsRevision?: number;
  estimatedCost?: { amount: number; currency: string; unit?: string };
  cachePolicy?: WorkflowCachePolicy;
  retryPolicy?: WorkflowRetryPolicy;
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  label?: string;
  condition?: string;
}

export interface WorkflowGraph {
  id: string;
  projectId: string;
  revision: number;
  name?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt?: string;
  updatedAt?: string;
}

export type WorkflowIssueCode =
  | "duplicate_node" | "duplicate_edge" | "missing_source_node"
  | "missing_target_node" | "missing_source_port" | "missing_target_port"
  | "incompatible_port_types" | "duplicate_input_connection"
  | "required_input_unconnected" | "cycle_detected"
  | "invalid_execution_target" | "locked_node_missing_output";

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowValidation {
  valid: boolean;
  issues: WorkflowIssue[];
  executionOrder: string[];
}

export type WorkflowExecutionTarget =
  | { kind: "all" }
  | { kind: "node"; nodeId: string }
  | { kind: "subgraph"; nodeIds: string[] };

export interface WorkflowExecutionPlan {
  valid: boolean;
  target: WorkflowExecutionTarget;
  issues: WorkflowIssue[];
  includedNodeIds: string[];
  executionOrder: string[];
  runNodeIds: string[];
  reusedNodeIds: string[];
}

export type WorkflowRunStatus =
  | "draft" | "validated" | "awaiting_approval" | "queued" | "submitted"
  | "processing" | "reviewing" | "completed" | "partial" | "failed"
  | "cancelled" | "blocked" | "needs_input" | "expired";

export interface WorkflowRunSnapshot {
  id: string;
  workflowId: string;
  workflowRevision: number;
  snapshotHash: string;
  target: WorkflowExecutionTarget;
  executionOrder: string[];
  approvedAt?: string;
  approvedBy?: string;
  budgetCeiling?: { amount: number; currency: string };
  createdAt: string;
}

export interface WorkflowNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  status: "pending" | "queued" | "processing" | "completed" | "reused"
    | "failed" | "cancelled" | "blocked" | "needs_input";
  attempt: number;
  cacheHit: boolean;
  inputAssetIds: string[];
  outputAssetIds: string[];
  providerJobId?: string;
  error?: { code: string; message: string; retryable: boolean };
}

const mediaTypes = new Set<MediaPortType>([
  "image", "video", "audio", "mask", "asset", "media", "identity-reference",
  "style-reference", "product-reference", "start-frame", "end-frame", "keyframe",
  "motion-reference", "proxy", "3d-scene", "mesh", "timeline-package"
]);

const compatible = (source: MediaPortType, target: MediaPortType): boolean =>
  source === target || source === "any" || target === "any" ||
  (target === "media" && mediaTypes.has(source)) ||
  (target === "asset" && mediaTypes.has(source)) ||
  (target === "start-frame" && (source === "image" || source === "asset" || source === "media")) ||
  (target === "image" && (source === "asset" || source === "media"));

export function validateWorkflow(graph: WorkflowGraph): WorkflowValidation {
  const issues: WorkflowIssue[] = [];
  const nodes = new Map<string, WorkflowNode>();
  const edges = new Set<string>();
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const connectedInputs = new Set<string>();

  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      issues.push({ code: "duplicate_node", nodeId: node.id, message: `Duplicate node id: ${node.id}` });
      continue;
    }
    nodes.set(node.id, node);
    incoming.set(node.id, new Set());
    outgoing.set(node.id, new Set());
  }

  for (const edge of graph.edges) {
    if (edges.has(edge.id)) {
      issues.push({ code: "duplicate_edge", edgeId: edge.id, message: `Duplicate edge id: ${edge.id}` });
      continue;
    }
    edges.add(edge.id);
    const source = nodes.get(edge.sourceNodeId);
    const target = nodes.get(edge.targetNodeId);
    if (!source) {
      issues.push({ code: "missing_source_node", edgeId: edge.id, message: `Source node not found: ${edge.sourceNodeId}` });
      continue;
    }
    if (!target) {
      issues.push({ code: "missing_target_node", edgeId: edge.id, message: `Target node not found: ${edge.targetNodeId}` });
      continue;
    }
    const sourcePort = source.outputs.find(port => port.id === edge.sourcePortId);
    const targetPort = target.inputs.find(port => port.id === edge.targetPortId);
    if (!sourcePort) {
      issues.push({ code: "missing_source_port", edgeId: edge.id, nodeId: source.id, message: `Output port not found: ${edge.sourcePortId}` });
      continue;
    }
    if (!targetPort) {
      issues.push({ code: "missing_target_port", edgeId: edge.id, nodeId: target.id, message: `Input port not found: ${edge.targetPortId}` });
      continue;
    }
    if (!compatible(sourcePort.type, targetPort.type)) {
      issues.push({ code: "incompatible_port_types", edgeId: edge.id, nodeId: target.id, message: `Cannot connect ${sourcePort.type} to ${targetPort.type}` });
      continue;
    }
    const inputKey = `${target.id}:${targetPort.id}`;
    if (!targetPort.multiple && connectedInputs.has(inputKey)) {
      issues.push({ code: "duplicate_input_connection", edgeId: edge.id, nodeId: target.id, message: `Input ${targetPort.id} accepts one connection` });
      continue;
    }
    connectedInputs.add(inputKey);
    outgoing.get(source.id)?.add(target.id);
    incoming.get(target.id)?.add(source.id);
  }

  for (const node of nodes.values()) {
    for (const port of node.inputs) {
      if (port.required && !connectedInputs.has(`${node.id}:${port.id}`) && !(port.id in node.config)) {
        issues.push({ code: "required_input_unconnected", nodeId: node.id, message: `Required input is not connected or configured: ${port.id}` });
      }
    }
  }

  const indegree = new Map<string, number>();
  for (const [id, parents] of incoming) indegree.set(id, parents.size);
  const ready = [...nodes.keys()].filter(id => indegree.get(id) === 0);
  const executionOrder: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    executionOrder.push(id);
    for (const child of outgoing.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }

  if (executionOrder.length !== nodes.size) {
    issues.push({ code: "cycle_detected", message: "Workflow graph contains a dependency cycle." });
  }
  return { valid: issues.length === 0, issues, executionOrder };
}

/**
 * Plan a full graph, one node, or a selected subgraph without executing anything.
 * For targeted runs, locked ancestors with saved outputs are reused and their
 * upstream dependencies are not rerun. For full runs, all nodes remain visible
 * in the plan but locked nodes are reused rather than executed.
 */
export function planWorkflowExecution(
  graph: WorkflowGraph,
  target: WorkflowExecutionTarget = { kind: "all" }
): WorkflowExecutionPlan {
  const validation = validateWorkflow(graph);
  const issues = [...validation.issues];
  const nodeMap = new Map(graph.nodes.map(node => [node.id, node]));
  const parents = new Map<string, Set<string>>();
  for (const node of graph.nodes) parents.set(node.id, new Set());
  for (const edge of graph.edges) parents.get(edge.targetNodeId)?.add(edge.sourceNodeId);

  let requested = new Set<string>();
  if (target.kind === "all") {
    requested = new Set(graph.nodes.map(node => node.id));
  } else {
    const ids = target.kind === "node" ? [target.nodeId] : target.nodeIds;
    if (ids.length === 0) {
      issues.push({ code: "invalid_execution_target", message: "At least one node must be selected." });
    }
    for (const id of ids) {
      if (!nodeMap.has(id)) {
        issues.push({ code: "invalid_execution_target", nodeId: id, message: `Selected node does not exist: ${id}` });
      } else {
        requested.add(id);
      }
    }
  }

  const included = new Set<string>();
  const visit = (id: string): void => {
    if (included.has(id)) return;
    included.add(id);
    const node = nodeMap.get(id);
    if (node?.locked && (node.lockedOutputIds?.length ?? 0) > 0) return;
    for (const parent of parents.get(id) ?? []) visit(parent);
  };
  if (target.kind === "all") {
    for (const id of requested) included.add(id);
  } else {
    for (const id of requested) visit(id);
  }

  const executionOrder = validation.executionOrder.filter(id => included.has(id));
  const reusedNodeIds: string[] = [];
  const runNodeIds: string[] = [];
  for (const id of executionOrder) {
    const node = nodeMap.get(id);
    if (!node) continue;
    if (node.locked) {
      if ((node.lockedOutputIds?.length ?? 0) === 0) {
        issues.push({ code: "locked_node_missing_output", nodeId: id, message: `Locked node has no saved output to reuse: ${id}` });
      } else {
        reusedNodeIds.push(id);
      }
    } else {
      runNodeIds.push(id);
    }
  }

  return {
    valid: issues.length === 0,
    target,
    issues,
    includedNodeIds: executionOrder,
    executionOrder,
    runNodeIds,
    reusedNodeIds
  };
}

export function createEmptyWorkflow(projectId: string, id: string): WorkflowGraph {
  return { id, projectId, revision: 1, nodes: [], edges: [] };
}
