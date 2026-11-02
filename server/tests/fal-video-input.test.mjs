import test from "node:test";
import assert from "node:assert/strict";
import { buildFalVideoPayload } from "../fal-video-gateway.mjs";
import { validateWorkflowGraph } from "../workflow-validation.mjs";

test("video payload rejects duration or aspect ratio that the selected model cannot honor",()=>{
 assert.throws(()=>buildFalVideoPayload({prompt:"A quiet cinematic river",duration:90,aspectRatio:"16:9"}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildFalVideoPayload({prompt:"A quiet cinematic river",duration:5,aspectRatio:"4:3"}),error=>error.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 const payload=buildFalVideoPayload({prompt:"  A quiet cinematic river  ",duration:30,aspectRatio:"16:9"});
 assert.equal(payload.prompt,"A quiet cinematic river");
 assert.equal(payload.duration,30);
 assert.equal(payload.aspect_ratio,"16:9");
 assert.equal(Object.hasOwn(payload,"image_url"),false);
});

test("reference image is attached only to an explicitly configured model input field",()=>{
 const dataUrl="data:image/png;base64,iVBORw0KGgo=";
 assert.throws(()=>buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:dataUrl}),error=>error.code==="VIDEO_GATEWAY_IMAGE_INPUT_UNCONFIGURED");
 const payload=buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:dataUrl,imageInputField:"image_url"});
 assert.equal(payload.image_url,dataUrl);
 assert.equal(payload.start_image_url,undefined);
});

test("unsupported input fields and malformed or oversized image data fail closed",()=>{
 const dataUrl="data:image/png;base64,iVBORw0KGgo=";
 assert.throws(()=>buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:dataUrl,imageInputField:"authorization"}),error=>error.code==="VIDEO_GATEWAY_IMAGE_INPUT_UNCONFIGURED");
 assert.throws(()=>buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:"https://example.com/image.png",imageInputField:"image_url"}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:"data:image/svg+xml;base64,PHN2Zz4=",imageInputField:"image_url"}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:"data:image/png;base64,"+"A".repeat(14*1024*1024),imageInputField:"image_url"}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
});

test("reference input field is restricted to documented adapter choices",()=>{
 for(const field of ["image_url","start_image_url","first_frame_image_url"]){
  const payload=buildFalVideoPayload({prompt:"A scene",referenceImageDataUrl:"data:image/webp;base64,UklGRg==",imageInputField:field});
  assert.equal(payload[field],"data:image/webp;base64,UklGRg==");
 }
});

test("workflow validation allows an uploaded media asset to connect to the video start-frame input",()=>{
 const graph={
  nodes:[
   {id:"reference",kind:"reference",label:"Reference asset",inputs:[],outputs:[{id:"media",type:"media"}],config:{}},
   {id:"video",kind:"video.generate",label:"Video generation",inputs:[
    {id:"prompt",type:"text",required:true},
    {id:"start-frame",type:"start-frame"},
    {id:"reference",type:"video",multiple:true}
   ],outputs:[{id:"video",type:"video"}],config:{prompt:"Animate the approved reference frame"}}
  ],
  edges:[{id:"reference-to-start-frame",sourceNodeId:"reference",sourcePortId:"media",targetNodeId:"video",targetPortId:"start-frame"}]
 };
 const result=validateWorkflowGraph(graph);
 assert.equal(result.valid,true,JSON.stringify(result.issues));
});
