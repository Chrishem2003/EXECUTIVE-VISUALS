import assert from "node:assert/strict";
import { templates, instantiateTemplate, palette } from "../src/core/workflow-palette.ts";
import { validateWorkflow } from "../src/core/workflow.ts";
import { validateWorkflowGraph } from "../server/workflow-validation.mjs";

let counter = 0;
const newId = () => `id-${++counter}`;

for (const key of Object.keys(templates)) {
  const { nodes, edges } = instantiateTemplate(key, 30, newId);
  const graph = { id: `template-${key}`, projectId: "project-test", revision: 1, nodes, edges };

  const client = validateWorkflow(graph);
  assert.equal(client.valid, true, `${key}: browser validation failed: ${JSON.stringify(client.issues)}`);
  const server = validateWorkflowGraph(graph);
  assert.equal(server.valid, true, `${key}: server validation failed: ${JSON.stringify(server.issues)}`);

  assert.equal(nodes.length, templates[key].nodes.length, `${key}: node count`);
  assert.equal(edges.length, templates[key].edges.length, `${key}: edge count`);
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length, `${key}: node ids are unique`);
  for (const node of nodes) assert.ok(node.position && node.position.y >= 30, `${key}: ${node.label} has a position`);
}

// Every palette node must declare typed ports, so the canvas can always connect it.
for (const [key, spec] of Object.entries(palette)) {
  assert.ok(spec.kind && spec.label, `${key}: kind and label`);
  assert.ok([...spec.inputs, ...spec.outputs].every(port => port.id && port.type), `${key}: ports are typed`);
}

assert.throws(() => instantiateTemplate("no-such-template"), /Unknown workflow template/);
console.log(`Verified ${Object.keys(templates).length} workflow templates against both validators and ${Object.keys(palette).length} palette nodes.`);
