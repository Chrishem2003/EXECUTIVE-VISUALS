import test from "node:test";
import assert from "node:assert/strict";
import { createLumaWorkflowQuoteAdapter } from "../luma-workflow-quote-adapter.mjs";

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
test("Luma workflow quote rejects missing rates and invalid prepared requests",async()=>{
 assert.throws(()=>createLumaWorkflowQuoteAdapter({client:{prepareInput(){return{};}},usdPerCredit:""}),error=>error.code==="LUMA_BILLING_RATE_REQUIRED");
 const adapter=createLumaWorkflowQuoteAdapter({client:{prepareInput(){return{};}},usdPerCredit:"0.003"});
 await assert.rejects(adapter.prepareInput({provider:"runway",model:"model-router"},{job:{owner_id:ownerId}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE");
 await assert.rejects(adapter.preflight({model:"wrong",type:"video",video:{duration:"5s",resolution:"720p"}}),error=>error.code==="VIDEO_WORKFLOW_QUOTE_INVALID");
});
