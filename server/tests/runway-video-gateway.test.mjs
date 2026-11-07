import test from "node:test";
import assert from "node:assert/strict";
import {buildRunwayVideoPayload,getRunwayVideoCapabilities,listRunwayVideoModels,generateRunwayVideo} from "../runway-video-gateway.mjs";

test("catalog contains only models with explicit text-to-video profiles",()=>{
 const models=listRunwayVideoModels();
 assert.ok(models.some(x=>x.id==="seedance2_5"));
 assert.ok(models.some(x=>x.id==="kling_4"));
 assert.ok(models.some(x=>x.id==="gen4.5"));
 assert.ok(!models.some(x=>x.id==="nano_banana_pro"));
});
test("Seedance 2.5 payload maps documented duration, ratio and resolution",()=>{
 assert.deepEqual(buildRunwayVideoPayload({model:"seedance2_5",prompt:"A coastal sunrise",durationSeconds:8,aspectRatio:"16:9",resolution:"720p"}),{
  model:"seedance2_5",promptText:"A coastal sunrise",ratio:"1280:720",duration:8,resolution:"720p"
 });
});
test("Kling 4 maps portrait 1080p dimensions",()=>{
 assert.deepEqual(buildRunwayVideoPayload({model:"kling_4",prompt:"A moving camera",durationSeconds:8,aspectRatio:"9:16",resolution:"1080p"}),{
  model:"kling_4",promptText:"A moving camera",ratio:"1080:1920",duration:8
 });
});
test("Gen-4.5 enforces its documented duration and aspect ratio limits",()=>{
 assert.throws(()=>buildRunwayVideoPayload({model:"gen4.5",prompt:"x",durationSeconds:12}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 assert.throws(()=>buildRunwayVideoPayload({model:"gen4.5",prompt:"x",durationSeconds:5,aspectRatio:"1:1"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
});
test("unsupported models and malformed prompts fail closed",()=>{
 assert.throws(()=>buildRunwayVideoPayload({model:"not-a-model",prompt:"x"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_MODEL");
 assert.throws(()=>buildRunwayVideoPayload({model:"seedance2_5",prompt:""}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
});
test("capabilities are model-specific and never claim reference inputs for text-only adapter",()=>{
 const caps=getRunwayVideoCapabilities("seedance2_5");
 assert.equal(caps.referenceImages,false);
 assert.equal(caps.startFrame,false);
 assert.equal(caps.maxDurationSeconds,30);
 assert.deepEqual(caps.resolutions,["provider_default","480p","720p","1080p"]);
});
test("remote execution stays disabled until explicit server opt-in",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="false";process.env.RUNWAYML_API_SECRET="test";
 await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A sunrise"}),e=>e.code==="VIDEO_GATEWAY_REMOTE_DISABLED");
 for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;
});
test("task polling downloads only bounded MP4 output from the documented CDN host",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET,timeout:process.env.VIDEO_GATEWAY_TIMEOUT_MS};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";process.env.VIDEO_GATEWAY_TIMEOUT_MS="10000";
 const mp4=Buffer.concat([Buffer.from("0000ftyp"),Buffer.alloc(16)]);
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const u=String(url);calls.push(u);
  if(u.endsWith("/text_to_video"))return new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000",estimatedCost:{credits:20}}),{status:200});
  if(u.includes("/tasks/"))return new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000",status:"SUCCEEDED",model:"seedance2_5",output:["https://cdn.example.cloudfront.net/output.mp4"]}),{status:200});
  if(u==="https://cdn.example.cloudfront.net/output.mp4")return new Response(mp4,{status:200,headers:{"content-type":"video/mp4"}});
  throw new Error("unexpected URL "+u);
 };
 const result=await generateRunwayVideo({model:"seedance2_5",prompt:"A sunrise",fetchImpl,sleepImpl:async()=>{}});
 assert.equal(result.provider,"runway");assert.equal(result.model,"seedance2_5");assert.equal(result.estimatedCostCredits,20);assert.equal(result.buffer.toString("ascii",4,8),"ftyp");
 assert.equal(calls.length,3);
 for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key,VIDEO_GATEWAY_TIMEOUT_MS:original.timeout}))if(v===undefined)delete process.env[k];else process.env[k]=v;
});
test("rejects a task output URL outside the provider CDN",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 const fetchImpl=async url=>String(url).endsWith("/text_to_video")
  ?new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000"}),{status:200})
  :String(url).includes("/tasks/")
   ?new Response(JSON.stringify({status:"SUCCEEDED",output:["https://evil.example/output.mp4"]}),{status:200})
   :new Response("no",{status:500});
 await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A sunrise",fetchImpl,sleepImpl:async()=>{}}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");
 for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;
});
