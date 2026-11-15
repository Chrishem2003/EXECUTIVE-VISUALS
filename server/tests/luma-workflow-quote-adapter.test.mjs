import test from "node:test";
import assert from "node:assert/strict";
import { createLumaWorkflowQuoteAdapter } from "../luma-workflow-quote-adapter.mjs";
import { estimateLumaRay32Cost } from "../luma-video-pricing.mjs";

const assetId="123e4567-e89b-42d3-a456-426614174000";
const ownerId="223e4567-e89b-42d3-a456-426614174000";

test("Luma workflow quote validates private first-frame input and returns a non-billable account-rate estimate",async()=>{
 let preparedInput;
 const adapter=createLumaWorkflowQuoteAdapter({
  client:{prepareInput(input){preparedInput=input;return{model:"ray-3.2",type:"video",video:{resolution:input.resolution,duration:input.durationSeconds+"s",start_frame:input.startFrame}};}},
  usdPerCredit:"0.003",now:()=>new Date("2026-11-15T12:00:00.000Z")
 });
 const prepared=await adapter.prepareInput({
  provider:"luma",model:"ray-3.2",prompt:"A cinematic scene",durationSeconds:5,
  resolution:"720p",aspectRatio:"16:9",startFrameAssetId:assetId
 },{job:{owner_id:ownerId}});
 assert.equal(prepared.video.start_frame.file_id,assetId);
 assert.equal(preparedInput.user_id,ownerId);
 const quote=await adapter.preflight(prepared);
 assert.equal(quote.provider,"luma");
 assert.equal(quote.model,"ray-3.2");
 assert.equal(quote.estimatedCredits,100);
 assert.equal(quote.estimatedUsd,0.3);
 assert.equal(quote.currency,"USD");
 assert.equal(quote.billable,false);
 assert.equal(quote.configId,"luma-ray32");
 assert.equal(quote.pricingSource,"luma_ray32_published_credits_contract_rate");
 assert.match(quote.pricingUrl,/lumalabs\.ai/);
});

test("Luma workflow quote maps private indexed keyframe assets to provider references",async()=>{
 let received;
 const adapter=createLumaWorkflowQuoteAdapter({
  client:{prepareInput(input){received=input;return{model:"ray-3.2",type:"video",video:{resolution:input.resolution,duration:input.durationSeconds+"s",keyframes:input.keyframes,keyframe_indexes:input.keyframeIndexes}};}},
  usdPerCredit:"0.003",now:()=>new Date("2026-11-15T12:00:00.000Z")
 });
 const prepared=await adapter.prepareInput({
  provider:"luma",model:"ray-3.2",prompt:"A continuous cinematic shot",durationSeconds:10,
  resolution:"720p",aspectRatio:"16:9",keyframeAssetIds:[assetId,"423e4567-e89b-42d3-a456-426614174000"],keyframeIndexes:[0,120]
 },{job:{owner_id:ownerId}});
 assert.deepEqual(received.keyframes,[{file_id:assetId},{file_id:"423e4567-e89b-42d3-a456-426614174000"}]);
 assert.deepEqual(prepared.video.keyframe_indexes,[0,120]);
 const quote=await adapter.preflight(prepared);
 assert.equal(quote.estimatedCredits,300);
 assert.equal(quote.estimatedUsd,0.9);
});
test("Luma source-video edit and reframe quotes use operation-specific pricing and private file references",async()=>{
 const seen=[];
 const adapter=createLumaWorkflowQuoteAdapter({
  client:{prepareInput(input){seen.push(input);return{model:"ray-3.2",type:input.operation==="edit"?"video_edit":"video_reframe",video:{resolution:input.resolution}};}},
  usdPerCredit:"0.003",now:()=>new Date("2026-11-15T12:00:00.000Z")
 });
 const edit=await adapter.prepareInput({
  provider:"luma",model:"ray-3.2",operation:"edit",prompt:"Replace the background",durationSeconds:5,
  resolution:"720p",aspectRatio:"16:9",editStrength:"reimagine_2",sourceVideoAssetId:assetId
 },{job:{owner_id:ownerId}});
 assert.deepEqual(seen[0].sourceVideo,{file_id:assetId});
 assert.equal(seen[0].editStrength,"reimagine_2");
 const editQuote=await adapter.preflight(edit);
 assert.equal(editQuote.estimatedCredits,estimateLumaRay32Cost({operation:"video_edit",resolution:"720p",durationSeconds:5}).credits);
 const reframe=await adapter.prepareInput({
  provider:"luma",model:"ray-3.2",operation:"reframe",prompt:"Recompose vertically",durationSeconds:13,
  resolution:"540p",aspectRatio:"9:16",sourcePosition:{x_norm:0,y_norm:0,w_norm:1,h_norm:1},sourceVideoAssetId:assetId
 },{job:{owner_id:ownerId}});
 assert.deepEqual(seen[1].sourceVideo,{file_id:assetId});
 const reframeQuote=await adapter.preflight(reframe,{sourceMetadata:{durationSeconds:12.4}});
 assert.equal(reframeQuote.estimatedCredits,estimateLumaRay32Cost({operation:"video_reframe",resolution:"540p",durationSeconds:13}).credits);
 assert.equal(reframeQuote.billable,false);
});
test("Luma workflow quote rejects missing rates and invalid prepared requests",async()=>{
 assert.throws(()=>createLumaWorkflowQuoteAdapter({client:{prepareInput(){return{};}},usdPerCredit:""}),error=>error.code==="LUMA_BILLING_RATE_REQUIRED");
 const adapter=createLumaWorkflowQuoteAdapter({client:{prepareInput(){return{};}},usdPerCredit:"0.003"});
 await assert.rejects(adapter.prepareInput({provider:"runway",model:"model-router"},{job:{owner_id:ownerId}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE");
 await assert.rejects(adapter.preflight({model:"wrong",type:"video",video:{duration:"5s",resolution:"720p"}}),error=>error.code==="VIDEO_WORKFLOW_QUOTE_INVALID");
});
