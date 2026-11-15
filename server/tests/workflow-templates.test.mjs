import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptionCaptionWorkflow } from "../../src/core/workflow-templates.ts";
import { validateWorkflow, planWorkflowExecution } from "../../src/core/workflow.ts";

test("transcription and caption template is a valid connected graph with a human approval ancestor",()=>{
 const graph=createTranscriptionCaptionWorkflow({id:"workflow-template-1",projectId:"project-1"});
 const validation=validateWorkflow(graph);
 assert.equal(validation.valid,true,JSON.stringify(validation.issues));
 assert.equal(planWorkflowExecution(graph,{kind:"all"}).valid,true);
 assert.equal(graph.projectId,"project-1");
 assert.equal(graph.name,"Audio transcription and captions");
 assert.equal(graph.nodes.length,4);
 assert.equal(graph.edges.length,6);
 const source=graph.nodes.find(node=>node.id==="source-audio");
 assert.equal(source.config.assetId,"");
 assert.ok(source.outputs.some(port=>port.id==="audio"&&port.type==="audio"));
 const approval=graph.nodes.find(node=>node.id==="human-review");
 assert.equal(approval.kind,"approval");
 const transcribe=graph.nodes.find(node=>node.id==="transcribe-audio");
 assert.ok(transcribe.inputs.some(port=>port.id==="approval"));
 assert.ok(graph.edges.some(edge=>edge.sourceNodeId==="human-review"&&edge.targetNodeId==="transcribe-audio"));
});

test("template requires an explicit workflow ID and never selects an arbitrary source asset",()=>{
 assert.throws(()=>createTranscriptionCaptionWorkflow({id:""}),/workflow ID/i);
 const graph=createTranscriptionCaptionWorkflow({id:"workflow-template-2"});
 assert.equal(graph.nodes.find(node=>node.id==="source-audio").config.assetId,"");
});
