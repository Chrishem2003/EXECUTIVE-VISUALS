import test from "node:test";
import assert from "node:assert/strict";
import { buildRunwayImagePayload, generateRunwayImage, preflightRunwayRouterImage, generateRunwayRouterImage } from "../runway-image-gateway.mjs";

const taskId="123e4567-e89b-42d3-a456-426614174000";
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const envKeys=["IMAGE_GATEWAY_ENABLED","IMAGE_GATEWAY_ALLOW_REMOTE","IMAGE_GATEWAY_TIMEOUT_MS","RUNWAY_API_KEY","RUNWAYML_API_SECRET","RUNWAY_IMAGE_ROUTER_ENABLED","RUNWAY_IMAGE_ROUTER_CONFIG"];
const snapshot=()=>Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const restore=values=>envKeys.forEach(key=>values[key]===undefined?delete process.env[key]:process.env[key]=values[key]);
const enable=()=>{process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAY_API_KEY="test-runway-key";process.env.IMAGE_GATEWAY_TIMEOUT_MS="10000";};

test("GPT Image 2.6 payload uses exact model options and supports bounded references",()=>{
 const reference="data:image/png;base64,iVBORw0KGgo=";
 const payload=buildRunwayImagePayload({model:"gpt_image_2_6_flare",prompt:"A premium product campaign",ratio:"1920:1088",quality:"high",reasoningEffort:"medium",background:"transparent",referenceImages:[reference]});
 assert.deepEqual(payload,{model:"gpt_image_2_6_flare",promptText:"A premium product campaign",ratio:"1920:1088",quality:"high",reasoningEffort:"medium",background:"transparent",outputCount:1,referenceImages:[{uri:reference}]});
});
test("GPT Image 2.6 payload rejects unsupported sizes, excessive prompt and multi-output until asset fan-out exists",()=>{
 assert.throws(()=>buildRunwayImagePayload({model:"gpt_image_2_6_flare",prompt:"x",ratio:"1600:900"}),e=>e.code==="IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
 assert.throws(()=>buildRunwayImagePayload({model:"gpt_image_2_6_flare",prompt:"x".repeat(32001)}),e=>e.code==="IMAGE_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayImagePayload({model:"gpt_image_2_6_flare",prompt:"x",outputCount:2}),e=>e.code==="IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
 assert.throws(()=>buildRunwayImagePayload({model:"gpt_image_2_6_flare",prompt:"x",referenceImages:Array(17).fill("data:image/png;base64,iVBORw0KGgo=")}),e=>e.code==="IMAGE_GATEWAY_INVALID_INPUT");
});
test("Runway image generation submits, polls and downloads only validated PNG output",async()=>{
 const previous=snapshot();enable();
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const target=String(url);calls.push({url:target,options});
  if(target==="https://api.dev.runwayml.com/v1/text_to_image"){
   assert.equal(options.headers.authorization,"Bearer test-runway-key");
   assert.equal(options.headers["X-Runway-Version"],"2024-11-06");
   const body=JSON.parse(options.body);
   assert.equal(body.model,"gpt_image_2_6_sunburst");
   assert.equal(body.promptText,"A clear product image");
   assert.equal(body.ratio,"auto");
   assert.equal(body.outputCount,1);
   return new Response(JSON.stringify({id:taskId,estimatedCost:{credits:19}}),{status:200});
  }
  if(target==="https://api.dev.runwayml.com/v1/tasks/"+taskId){
   return new Response(JSON.stringify({id:taskId,status:"SUCCEEDED",model:"gpt_image_2_6_sunburst",output:["https://images.cloudfront.net/result.png"],actualCost:{credits:17}}),{status:200});
  }
  if(target==="https://images.cloudfront.net/result.png")return new Response(png,{status:200,headers:{"content-type":"image/png"}});
  throw new Error("unexpected URL "+target);
 };
 try{
  const result=await generateRunwayImage({model:"gpt_image_2_6_sunburst",prompt:"A clear product image",fetchImpl,sleepImpl:async()=>{}});
  assert.equal(result.provider,"runway");assert.equal(result.model,"gpt_image_2_6_sunburst");assert.equal(result.taskId,taskId);
  assert.equal(result.estimatedCostCredits,19);assert.equal(result.outputFormat,"png");assert.deepEqual(result.buffer,png);
  assert.equal(calls.length,3);
 }finally{restore(previous);}
});
test("Runway image execution remains disabled without remote opt-in and server credentials",async()=>{
 const previous=snapshot();
 try{
  process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="false";process.env.RUNWAY_API_KEY="test";
  await assert.rejects(()=>generateRunwayImage({model:"gpt_image_2_6_flare",prompt:"test"}),e=>e.code==="IMAGE_GATEWAY_REMOTE_DISABLED");
  process.env.IMAGE_GATEWAY_ALLOW_REMOTE="true";delete process.env.RUNWAY_API_KEY;
  await assert.rejects(()=>generateRunwayImage({model:"gpt_image_2_6_flare",prompt:"test"}),e=>e.code==="IMAGE_GATEWAY_CONFIG_INVALID");
 }finally{restore(previous);}
});
test("Runway image task rejects untrusted output URLs",async()=>{
 const previous=snapshot();enable();
 const fetchImpl=async url=>String(url).endsWith("/text_to_image")
  ?new Response(JSON.stringify({id:taskId}),{status:200})
  :String(url).includes("/tasks/")
   ?new Response(JSON.stringify({status:"SUCCEEDED",output:["https://evil.example/output.png"]}),{status:200})
   :new Response("no",{status:500});
 try{
  await assert.rejects(()=>generateRunwayImage({model:"gpt_image_2_6_flare",prompt:"test",fetchImpl,sleepImpl:async()=>{}}),e=>e.code==="IMAGE_GATEWAY_INVALID_RESPONSE");
 }finally{restore(previous);}
});

test("Runway image Model Router preflight is a non-billable dry-run with validated route estimate",async()=>{
 const previous=snapshot();enable();process.env.RUNWAY_IMAGE_ROUTER_ENABLED="true";process.env.RUNWAY_IMAGE_ROUTER_CONFIG="campaign-images";
 let calls=0;
 const fetchImpl=async(url,options)=>{
  calls++;assert.equal(String(url),"https://api.dev.runwayml.com/v1/generate/image");
  assert.equal(options.headers["X-Runway-Version"],"2024-11-06");
  const body=JSON.parse(options.body);
  assert.equal(body.configId,"campaign-images");assert.equal(body.dryRun,true);
  assert.deepEqual(body.input,{promptText:"A premium campaign",referenceImages:[{uri:"data:image/png;base64,iVBORw0KGgo="}],outputCount:3,aspectRatio:"16:9",resolution:"2k"});
  return new Response(JSON.stringify({routing:{configId:"campaign-images",model:"gpt_image_2_6_flare",provider:"openai",estimatedCost:{credits:42}}}),{status:200});
 };
 try{
  const quote=await preflightRunwayRouterImage({prompt:"A premium campaign",aspectRatio:"16:9",resolution:"2k",referenceImages:["data:image/png;base64,iVBORw0KGgo="],outputCount:3,fetchImpl});
  assert.equal(quote.billable,false);assert.equal(quote.model,"gpt_image_2_6_flare");assert.equal(quote.estimatedCredits,42);assert.equal(quote.estimatedUsd,0.42);assert.equal(calls,1);
 }finally{restore(previous);}
});

test("Runway image Model Router submits, polls and ingests exactly the requested variations",async()=>{
 const previous=snapshot();enable();process.env.RUNWAY_IMAGE_ROUTER_ENABLED="true";process.env.RUNWAY_IMAGE_ROUTER_CONFIG="campaign-images";
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const target=String(url);calls.push(target);
  if(target==="https://api.dev.runwayml.com/v1/generate/image"){
   const body=JSON.parse(options.body);assert.equal(body.configId,"campaign-images");assert.equal(body.input.outputCount,2);assert.equal(body.dryRun,undefined);
   return new Response(JSON.stringify({id:taskId,routing:{configId:"campaign-images",model:"gpt_image_2_6_flare",provider:"openai",estimatedCost:{credits:30}},estimatedCost:{credits:30}}),{status:200});
  }
  if(target==="https://api.dev.runwayml.com/v1/tasks/"+taskId)return new Response(JSON.stringify({id:taskId,status:"SUCCEEDED",model:"gpt_image_2_6_flare",output:["https://images.cloudfront.net/one.png","https://images.cloudfront.net/two.png"],estimatedCost:{credits:30},cost:{credits:28}}),{status:200});
  if(target==="https://images.cloudfront.net/one.png"||target==="https://images.cloudfront.net/two.png")return new Response(png,{status:200,headers:{"content-type":"image/png"}});
  throw new Error("unexpected URL "+target);
 };
 try{
  const result=await generateRunwayRouterImage({prompt:"Two campaign variations",outputCount:2,fetchImpl,sleepImpl:async()=>{}});
  assert.equal(result.routeType,"runway-model-router");assert.equal(result.configId,"campaign-images");
  assert.equal(result.model,"gpt_image_2_6_flare");assert.equal(result.estimatedCostCredits,30);assert.equal(result.actualCostCredits,28);
  assert.equal(result.outputs.length,2);assert.deepEqual(result.outputs[0].buffer,png);assert.deepEqual(result.outputs[1].buffer,png);
  assert.equal(calls.length,4);
 }finally{restore(previous);}
});

test("Runway image Model Router rejects unsupported ratios, malformed quote and wrong output cardinality",async()=>{
 const previous=snapshot();enable();process.env.RUNWAY_IMAGE_ROUTER_ENABLED="true";process.env.RUNWAY_IMAGE_ROUTER_CONFIG="campaign-images";
 try{
  await assert.rejects(()=>preflightRunwayRouterImage({prompt:"test",aspectRatio:"30:17",fetchImpl:async()=>new Response("{}")}),e=>e.code==="IMAGE_GATEWAY_UNSUPPORTED_CAPABILITY");
  await assert.rejects(()=>preflightRunwayRouterImage({prompt:"test",fetchImpl:async()=>new Response(JSON.stringify({routing:{configId:"wrong",model:"x",provider:"x",estimatedCost:{credits:2}}}))}),e=>e.code==="RUNWAY_ROUTER_DRY_RUN_INVALID");
  await assert.rejects(()=>generateRunwayRouterImage({prompt:"test",outputCount:2,fetchImpl:async()=>new Response(JSON.stringify({id:taskId,routing:{configId:"campaign-images",model:"x",provider:"x",estimatedCost:{credits:2}},estimatedCost:{credits:2}}))}),e=>e.code==="IMAGE_GATEWAY_INVALID_RESPONSE");
 }finally{restore(previous);}
});

