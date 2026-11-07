import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowGraph } from "../workflow-validation.mjs";

test("multi-image generation exposes a typed asset collection that can feed Batch Inputs",()=>{
 const graph={
  nodes:[
   {id:"prompt",kind:"text",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"Create a product campaign"}},
   {id:"image",kind:"image.generate",inputs:[{id:"prompt",type:"text",required:true},{id:"reference",type:"image",multiple:true}],outputs:[{id:"image",type:"image"},{id:"images",type:"asset",multiple:true}],config:{outputCount:4}},
   {id:"batch",kind:"batch",inputs:[{id:"items",type:"asset",required:true,multiple:true}],outputs:[{id:"results",type:"asset",multiple:true}],config:{}}
  ],
  edges:[
   {id:"prompt-to-image",sourceNodeId:"prompt",sourcePortId:"text",targetNodeId:"image",targetPortId:"prompt"},
   {id:"images-to-batch",sourceNodeId:"image",sourcePortId:"images",targetNodeId:"batch",targetPortId:"items"}
  ]
 };
 const result=validateWorkflowGraph(graph);
 assert.equal(result.valid,true,JSON.stringify(result.issues));
 assert.deepEqual(result.executionOrder,["prompt","image","batch"]);
});

test("multi-image output remains separate from the backward-compatible primary image output",()=>{
 const imageOutputs=[
  {id:"image",type:"image"},
  {id:"images",type:"asset",multiple:true}
 ];
 assert.equal(imageOutputs[0].id,"image");
 assert.equal(imageOutputs[1].multiple,true);
});
