import test from "node:test";
import assert from "node:assert/strict";
import {planEnhancementRecipe} from "../enhancement-recipes.mjs";

test("plans an ordered, approval-gated video enhancement recipe without executing it",()=>{
 const plan=planEnhancementRecipe({
  name:"Documentary master",
  sourceAsset:{id:"asset-1",media_type:"video/mp4",sha256:"a".repeat(64)},
  steps:[
   {operation:"media.denoise",parameters:{luma:4,chroma:2,secret:"must-not-leak"}},
   {operation:"media.color",parameters:{brightness:0.05,contrast:1.1,saturation:1.2}},
   {operation:"media.upscale",parameters:{width:3840,height:2160,algorithm:"lanczos",sharpness:0.2}}
  ]
 });
 assert.equal(plan.schemaVersion,1);
 assert.equal(plan.source.assetId,"asset-1");
 assert.deepEqual(plan.steps.map(x=>x.operation),["media.denoise","media.color","media.upscale"]);
 assert.equal(plan.steps[0].parameters.secret,undefined);
 assert.equal(plan.steps[2].method,"deterministic-resampling");
 assert.equal(plan.execution.mode,"dry-run");
 assert.equal(plan.execution.requiresApproval,true);
 assert.equal(plan.steps.every(x=>x.requiresApproval),true);
});

test("rejects recipes with unsupported operations, invalid options and incompatible media",()=>{
 const video={id:"video",media_type:"video/mp4"};
 assert.throws(()=>planEnhancementRecipe({sourceAsset:video,steps:[{operation:"media.ai-upscale"}]}),e=>e.code==="RECIPE_OPERATION_UNSUPPORTED");
 assert.throws(()=>planEnhancementRecipe({sourceAsset:video,steps:[{operation:"media.upscale",parameters:{width:9000}}]}),e=>e.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>planEnhancementRecipe({sourceAsset:{id:"audio",media_type:"audio/wav"},steps:[{operation:"media.color"}]}),e=>e.code==="RECIPE_MEDIA_TYPE_MISMATCH");
 assert.throws(()=>planEnhancementRecipe({sourceAsset:video,steps:[]}),e=>e.code==="RECIPE_STEP_LIMIT");
 assert.throws(()=>planEnhancementRecipe({sourceAsset:video,steps:Array.from({length:13},()=>({operation:"media.color"}))}),e=>e.code==="RECIPE_STEP_LIMIT");
});

test("plans audio cleanup only for audio assets",()=>{
 const plan=planEnhancementRecipe({sourceAsset:{id:"audio",media_type:"audio/wav"},steps:[{operation:"media.audio-clean",parameters:{noiseFloor:-30,targetLufs:-18}}]});
 assert.equal(plan.steps[0].method,"classical-audio-filtering");
 assert.deepEqual(plan.steps[0].parameters,{noiseFloor:-30,targetLufs:-18});
});
