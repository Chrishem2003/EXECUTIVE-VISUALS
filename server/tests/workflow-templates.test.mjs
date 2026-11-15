import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptionCaptionWorkflow, createVideoCaptionLocalizationWorkflow } from "../../src/core/workflow-templates.ts";
import { validateWorkflow, planWorkflowExecution } from "../../src/core/workflow.ts";

test("transcription and caption template is a valid connected graph with a human approval ancestor",()=>{
 const graph=createTranscriptionCaptionWorkflow({id:"workflow-template-1",projectId:"project-1"});
 const validation=validateWorkflow(graph);
 assert.equal(validation.valid,true,JSON.stringify(validation.issues));
 assert.equal(planWorkflowExecution(graph,{kind:"all"}).valid,true);
 assert.equal(graph.projectId,"project-1");
 assert.equal(graph.name,"Audio transcription and captions");
 assert.equal(graph.nodes.length,4);
 assert.equal(graph.edges.length,7);
 assert.ok(graph.edges.some(edge=>edge.sourcePortId==="words"&&edge.targetPortId==="words"));
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


test("video caption localization is a valid review-first graph with private source selection and two approval gates",()=>{
 const graph=createVideoCaptionLocalizationWorkflow({id:"workflow-localize-1",projectId:"project-1"});
 const validation=validateWorkflow(graph);
 assert.equal(validation.valid,true,JSON.stringify(validation.issues));
 assert.equal(planWorkflowExecution(graph,{kind:"all"}).valid,true);
 assert.equal(graph.name,"Review-first video caption localization");
 assert.equal(graph.nodes.length,8);
 assert.equal(graph.edges.length,12);
 const source=graph.nodes.find(node=>node.id==="source-video");
 assert.equal(source.config.assetId,"");
 assert.ok(source.outputs.some(port=>port.id==="media"&&port.type==="media"));
 const transcription=graph.nodes.find(node=>node.id==="transcribe-audio");
 const translation=graph.nodes.find(node=>node.id==="translate-captions");
 assert.ok(graph.edges.some(edge=>edge.sourceNodeId==="approve-transcription"&&edge.targetNodeId==="transcribe-audio"&&edge.targetPortId==="approval"));
 assert.ok(graph.edges.some(edge=>edge.sourceNodeId==="review-transcript"&&edge.targetNodeId==="translate-captions"&&edge.targetPortId==="approval"));
 assert.equal(translation.config.targetLanguage,"");
 assert.ok(graph.edges.some(edge=>edge.sourceNodeId==="create-captions"&&edge.targetNodeId==="export-captions"));
 assert.ok(transcription.inputs.some(port=>port.id==="approval"));
 assert.ok(transcription.outputs.some(port=>port.id==="words"&&port.type==="structured-data"));
});

test("video caption localization requires an explicit workflow ID",()=>{
 assert.throws(()=>createVideoCaptionLocalizationWorkflow({id:""}),/workflow ID/i);
});
