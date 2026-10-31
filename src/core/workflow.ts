import type { Capability } from "./contracts";

export type MediaPortType =
  | "text" | "image" | "video" | "audio" | "mask" | "document"
  | "script" | "storyboard" | "character" | "voice" | "transcript"
  | "subtitle-file" | "asset" | "media" | "creative-set" | "any";

export type WorkflowNodeKind =
  | "prompt" | "text" | "upload" | "reference" | "script" | "storyboard"
  | "image.generate" | "image.edit" | "video.generate" | "avatar.generate"
  | "voice.generate" | "voice.transcribe" | "voice.translate" | "voice.lipsync"
  | "media.process" | "campaign.create" | "approval" | "quality-check"
  | "timeline" | "export" | "connector";

export interface WorkflowPort {
  id: string;
  label: string;
  type: MediaPortType;
  required?: boolean;
  multiple?: boolean;
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
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
}

export interface WorkflowGraph {
  id: string;
  projectId: string;
  revision: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type WorkflowIssueCode =
  | "duplicate_node" | "duplicate_edge" | "missing_source_node"
  | "missing_target_node" | "missing_source_port" | "missing_target_port"
  | "incompatible_port_types" | "duplicate_input_connection"
  | "required_input_unconnected" | "cycle_detected";

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

const compatible = (source: MediaPortType, target: MediaPortType): boolean =>
  source === target || source === "any" || target === "any" ||
  (source === "image" && target === "media") ||
  (source === "video" && target === "media") ||
  (source === "audio" && target === "media") ||
  (source === "asset" && target === "media");

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
      if (port.required && !port.multiple && !connectedInputs.has(`${node.id}:${port.id}`) && !(port.id in node.config)) {
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

export function createEmptyWorkflow(projectId: string, id: string): WorkflowGraph {
  return { id, projectId, revision: 1, nodes: [], edges: [] };
}
