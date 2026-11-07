import test from "node:test";
import assert from "node:assert/strict";
import {buildRunwayVideoPayload,buildRunwayImageToVideoPayload,buildRunwayVideoToVideoPayload,uploadRunwayEphemeralAsset,getRunwayVideoCapabilities,listRunwayVideoModels,generateRunwayVideo,editRunwayVideo} from "../runway-video-gateway.mjs";

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
test("first-frame image-to-video payload uses the correct endpoint contract per model",()=>{
 const image="data:image/png;base64,iVBORw0KGgo=";
 const gen=buildRunwayImageToVideoPayload({model:"gen4.5",prompt:"A moving camera",promptImage:image,durationSeconds:5,aspectRatio:"16:9"});
 assert.equal(gen.promptImage,image);assert.equal(gen.ratio,"1280:720");
 const seedance=buildRunwayImageToVideoPayload({model:"seedance2_5",prompt:"A cinematic scene",promptImage:image,durationSeconds:5,aspectRatio:"9:16"});
 assert.equal(seedance.ratio,"480:854");
 const kling=buildRunwayImageToVideoPayload({model:"kling_4",prompt:"A cinematic scene",promptImage:image,durationSeconds:5,aspectRatio:"9:16"});
 assert.equal("ratio" in kling,false);
});
test("image-to-video rejects oversized or malformed frame data",()=>{
 assert.throws(()=>buildRunwayImageToVideoPayload({model:"seedance2_5",prompt:"A scene",promptImage:"https://example.com/frame.png"}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayImageToVideoPayload({model:"seedance2_5",prompt:"A scene",promptImage:"data:image/png;base64,"+"A".repeat(7*1024*1024)}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
});
test("capabilities are model-specific and declare only implemented first-frame reference inputs",()=>{
 const caps=getRunwayVideoCapabilities("seedance2_5");
 assert.equal(caps.referenceImages,true);
 assert.equal(caps.startFrame,true);
 assert.equal(caps.maxDurationSeconds,30);
 assert.deepEqual(caps.resolutions,["provider_default","480p","720p","1080p"]);
});
test("remote execution stays disabled until explicit server opt-in",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="false";process.env.RUNWAYML_API_SECRET="test";
 await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A sunrise"}),e=>e.code==="VIDEO_GATEWAY_REMOTE_DISABLED");
 for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;
});
test("image-to-video uses the Runway image endpoint with a validated first frame",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const u=String(url);calls.push({url:u,body:options.body?JSON.parse(options.body):null});
  if(u.endsWith("/image_to_video"))return new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000"}),{status:200});
  if(u.includes("/tasks/"))return new Response(JSON.stringify({status:"FAILED"}),{status:200});
  throw new Error("unexpected URL "+u);
 };
 await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A moving scene",durationSeconds:5,aspectRatio:"16:9",referenceImageDataUrl:"data:image/png;base64,iVBORw0KGgo=",fetchImpl,sleepImpl:async()=>{}}),e=>e.code==="VIDEO_GATEWAY_JOB_FAILED");
 assert.equal(calls[0].url,"https://api.dev.runwayml.com/v1/image_to_video");
 assert.equal(calls[0].body.promptImage,"data:image/png;base64,iVBORw0KGgo=");
 assert.equal(calls[0].body.model,"seedance2_5");
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


test("video-to-video builds a documented Aleph2 request with ordered guidance keyframes", () => {
 const payload=buildRunwayVideoToVideoPayload({
  model:"aleph2",videoUri:"runway://upload/source-video",
  prompt:"Replace the background with a forest; preserve the subject and camera movement.",
  keyframes:[{uri:"runway://upload/frame-1",at:0},{uri:"runway://upload/frame-2",at:4.5}]
 });
 assert.deepEqual(payload,{
  model:"aleph2",videoUri:"runway://upload/source-video",
  promptText:"Replace the background with a forest; preserve the subject and camera movement.",
  keyframes:[{uri:"runway://upload/frame-1",at:0},{uri:"runway://upload/frame-2",at:4.5}],
  outputFormat:"mp4"
 });
});

test("video-to-video fails closed on unverified models, unsafe inputs and unsupported output formats", () => {
 assert.throws(()=>buildRunwayVideoToVideoPayload({model:"kling_4",videoUri:"runway://upload/v",prompt:"Edit"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_MODEL");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"https://127.0.0.1/private.mp4",prompt:"Edit"}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"runway://upload/v",prompt:"Edit",keyframes:Array.from({length:6},(_,i)=>({uri:"runway://upload/f"+i,at:i}))}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"runway://upload/v",prompt:"Edit",keyframes:[{uri:"runway://upload/f1",at:4},{uri:"runway://upload/f2",at:3}]}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"runway://upload/v",prompt:"Edit",outputFormat:"prores"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
});

test("video-to-video submits only after both server-side gates and downloads a private-ingestion-ready MP4", async () => {
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET,timeout:process.env.VIDEO_GATEWAY_TIMEOUT_MS};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";process.env.VIDEO_GATEWAY_TIMEOUT_MS="10000";
 const mp4=Buffer.concat([Buffer.from("0000ftyp"),Buffer.alloc(16)]),calls=[];
 const fetchImpl=async(url,options={})=>{
  const u=String(url);calls.push({url:u,body:options.body?JSON.parse(options.body):null});
  if(u.endsWith("/video_to_video"))return new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000",estimatedCost:{credits:31}}),{status:200});
  if(u.includes("/tasks/"))return new Response(JSON.stringify({status:"SUCCEEDED",model:"aleph2",output:["https://cdn.example.cloudfront.net/edited.mp4"]}),{status:200});
  if(u==="https://cdn.example.cloudfront.net/edited.mp4")return new Response(mp4,{status:200,headers:{"content-type":"video/mp4"}});
  throw new Error("unexpected URL "+u);
 };
 try {
  const result=await editRunwayVideo({videoUri:"runway://upload/source",prompt:"Preserve the actor; change the background.",fetchImpl,sleepImpl:async()=>{}});
  assert.equal(result.operation,"video-to-video");assert.equal(result.sourceIsImmutable,true);
  assert.equal(result.estimatedCostCredits,31);assert.equal(result.buffer.toString("ascii",4,8),"ftyp");
  assert.equal(calls[0].url,"https://api.dev.runwayml.com/v1/video_to_video");
  assert.equal(calls[0].body.videoUri,"runway://upload/source");
 } finally {
  for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key,VIDEO_GATEWAY_TIMEOUT_MS:original.timeout}))if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});


test("ephemeral upload validates the media and follows Runway's signed multipart upload flow", async () => {
 const original=process.env.RUNWAYML_API_SECRET;
 process.env.RUNWAYML_API_SECRET="test";
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const u=String(url);calls.push({url:u,options});
  if(u.endsWith("/uploads"))return new Response(JSON.stringify({
   uploadUrl:"https://uploads.runway.example/signed",
   fields:{key:"ephemeral/object",policy:"signed-policy"},
   runwayUri:"runway://ephemeral/source-video"
  }),{status:200});
  if(u==="https://uploads.runway.example/signed")return new Response(null,{status:204});
  throw new Error("unexpected URL "+u);
 };
 try {
  const result=await uploadRunwayEphemeralAsset({
   buffer:Buffer.alloc(512),filename:"source.mp4",mimeType:"video/mp4",fetchImpl
  });
  assert.equal(result.runwayUri,"runway://ephemeral/source-video");
  assert.equal(result.expiresInHours,24);
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.body,JSON.stringify({filename:"source.mp4",type:"ephemeral"}));
  assert.equal(calls[1].options.body instanceof FormData,true);
  assert.equal(calls[1].options.body.get("key"),"ephemeral/object");
  assert.equal(calls[1].options.body.get("file").size,512);
 } finally {
  if(original===undefined)delete process.env.RUNWAYML_API_SECRET;else process.env.RUNWAYML_API_SECRET=original;
 }
});

test("ephemeral upload rejects invalid media before making provider requests", async () => {
 let calls=0;
 await assert.rejects(()=>uploadRunwayEphemeralAsset({
  buffer:Buffer.alloc(511),filename:"source.mp4",mimeType:"video/mp4",
  fetchImpl:async()=>{calls++;throw new Error("must not be called");}
 }),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 await assert.rejects(()=>uploadRunwayEphemeralAsset({
  buffer:Buffer.alloc(512),filename:"source.exe",mimeType:"video/mp4",
  fetchImpl:async()=>{calls++;throw new Error("must not be called");}
 }),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.equal(calls,0);
});
