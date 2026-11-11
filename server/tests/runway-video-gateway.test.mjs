import test from "node:test";
import assert from "node:assert/strict";
import {buildRunwayVideoPayload,buildRunwayImageToVideoPayload,buildRunwayVideoToVideoPayload,uploadRunwayEphemeralAsset,getRunwayVideoCapabilities,listRunwayVideoModels,generateRunwayVideo,editRunwayVideo,submitRunwayVideoTask,getRunwayVideoTask,downloadRunwayVideoTaskOutput} from "../runway-video-gateway.mjs";

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
  keyframes:[{uri:"runway://upload/frame-1",at:0},{uri:"runway://upload/frame-2",at:0.15}]
 });
 assert.deepEqual(payload,{
  model:"aleph2",videoUri:"runway://upload/source-video",
  promptText:"Replace the background with a forest; preserve the subject and camera movement.",
  keyframes:[{uri:"runway://upload/frame-1",at:0},{uri:"runway://upload/frame-2",at:0.15}],
  outputFormat:"mp4"
 });
});

test("video-to-video fails closed on unverified models, unsafe inputs and unsupported output formats", () => {
 assert.throws(()=>buildRunwayVideoToVideoPayload({model:"kling_4",videoUri:"runway://upload/v",prompt:"Edit"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_MODEL");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"https://127.0.0.1/private.mp4",prompt:"Edit"}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"runway://upload/v",prompt:"Edit",keyframes:Array.from({length:6},(_,i)=>({uri:"runway://upload/f"+i,at:i}))}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"runway://upload/v",prompt:"Edit",keyframes:[{uri:"runway://upload/f1",at:0.8},{uri:"runway://upload/f2",at:0.6}]}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildRunwayVideoToVideoPayload({videoUri:"runway://upload/v",prompt:"Edit",keyframes:[{uri:"runway://upload/f1",at:1.01}]}),e=>e.code==="VIDEO_GATEWAY_INVALID_INPUT");
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

test("durable task submission sends exactly one POST and returns the provider task identity without polling",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 const calls=[];
 const fetchImpl=async(url,options={})=>{calls.push({url:String(url),method:options.method});return new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000",estimatedCost:{credits:24}}),{status:200});};
 try{
  const task=await submitRunwayVideoTask({model:"seedance2_5",prompt:"A quiet sunrise",durationSeconds:5,fetchImpl});
  assert.equal(task.taskId,"123e4567-e89b-42d3-a456-426614174000");
  assert.equal(task.status,"PENDING");assert.equal(task.estimatedCostCredits,24);
  assert.equal(calls.length,1);assert.equal(calls[0].method,"POST");
 }finally{
  for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});
test("ambiguous provider submission is marked unknown and is never automatically repeated",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 let calls=0;
 const fetchImpl=async()=>{calls++;throw new Error("connection reset after request write");};
 try{
  await assert.rejects(()=>submitRunwayVideoTask({model:"seedance2_5",prompt:"A sunrise",fetchImpl}),e=>e.code==="VIDEO_GATEWAY_SUBMISSION_UNKNOWN");
  assert.equal(calls,1);
 }finally{
  for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});
test("existing provider task can be polled independently without creating a new task",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 const calls=[];
 const fetchImpl=async(url,options={})=>{calls.push({url:String(url),method:options.method||"GET"});return new Response(JSON.stringify({id:"123e4567-e89b-42d3-a456-426614174000",status:"RUNNING",model:"seedance2_5",output:null}),{status:200});};
 try{
  const task=await getRunwayVideoTask({taskId:"123e4567-e89b-42d3-a456-426614174000",fetchImpl});
  assert.equal(task.status,"RUNNING");assert.equal(task.outputUrl,null);
  assert.equal(calls.length,1);assert.equal(calls[0].method,"GET");assert.ok(calls[0].url.endsWith("/tasks/123e4567-e89b-42d3-a456-426614174000"));
 }finally{
  for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
});
test("completed provider task output is bounded and MP4-validated by the separate downloader",async()=>{
 const mp4=Buffer.concat([Buffer.from("0000ftyp"),Buffer.alloc(16)]);
 const buffer=await downloadRunwayVideoTaskOutput({outputUrl:"https://cdn.example.cloudfront.net/result.mp4",fetchImpl:async()=>new Response(mp4,{status:200})});
 assert.equal(buffer.toString("ascii",4,8),"ftyp");
});


test("Runway API JSON responses are streamed with a hard 2 MiB cap",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 const fetchImpl=async()=>new Response("x".repeat(2*1024*1024+1),{status:200});
 try{await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A test scene",fetchImpl}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");}
 finally{for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});


test("Runway rejects response bodies without a readable stream instead of buffering them",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 let textRead=false;
 const fetchImpl=async()=>({status:200,ok:true,headers:new Headers(),body:null,text:async()=>{textRead=true;return "{}";}});
 try{await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A test scene",fetchImpl}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(textRead,false);}
 finally{for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});


test("Runway cancels a response body immediately when declared JSON size exceeds the cap",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";let cancelled=false;
 const fetchImpl=async()=>({status:200,ok:true,headers:new Headers({"content-length":String(2*1024*1024+1)}),body:{cancel:async()=>{cancelled=true;}}});
 try{await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A test scene",fetchImpl}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(cancelled,true);}
 finally{for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test("Runway cancels oversized generated-video downloads from Content-Length before reading",async()=>{
 let cancelled=false;
 await assert.rejects(()=>downloadRunwayVideoTaskOutput({
  outputUrl:"https://cdn.example.cloudfront.net/oversized.mp4",
  fetchImpl:async()=>({ok:true,status:200,headers:new Headers({"content-length":String(250*1024*1024+1)}),body:{cancel:async()=>{cancelled=true;}}})
 }),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");
 assert.equal(cancelled,true);
});

test("Runway generated-media downloads explicitly reject HTTP redirects",async()=>{
 let options;
 const bytes=Buffer.concat([Buffer.from("0000ftyp"),Buffer.alloc(16)]);
 const result=await downloadRunwayVideoTaskOutput({
  outputUrl:"https://cdn.example.cloudfront.net/redirect-check.mp4",
  fetchImpl:async(_url,init)=>{options=init;return new Response(bytes,{status:200});}
 });
 assert.equal(result.toString("ascii",4,8),"ftyp");
 assert.equal(options.redirect,"error");
});

test("Runway cancels non-success API response bodies before parsing",async()=>{
 const original={enabled:process.env.VIDEO_GATEWAY_ENABLED,remote:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.VIDEO_GATEWAY_ENABLED="true";process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 let cancelled=false;
 const fetchImpl=async()=>({status:429,ok:false,headers:new Headers(),body:{cancel:async()=>{cancelled=true;}},});
 try{await assert.rejects(()=>generateRunwayVideo({model:"seedance2_5",prompt:"A test scene",fetchImpl}),e=>e.code==="VIDEO_GATEWAY_RATE_LIMITED");assert.equal(cancelled,true);}
 finally{for(const [k,v] of Object.entries({VIDEO_GATEWAY_ENABLED:original.enabled,VIDEO_GATEWAY_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test("image-to-video applies model-specific resolution support without inventing ratios",()=>{
 const image="data:image/png;base64,iVBORw0KGgo=";
 assert.throws(()=>buildRunwayImageToVideoPayload({model:"gen4.5",prompt:"A moving camera",promptImage:image,durationSeconds:5,aspectRatio:"16:9",resolution:"1080p"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 const kling720=buildRunwayImageToVideoPayload({model:"kling_4",prompt:"A cinematic scene",promptImage:image,durationSeconds:5,aspectRatio:"9:16",resolution:"720p"});
 assert.equal(kling720.ratio,"auto_720p");assert.equal("resolution" in kling720,false);
 const kling1080=buildRunwayImageToVideoPayload({model:"kling_4",prompt:"A cinematic scene",promptImage:image,durationSeconds:5,aspectRatio:"16:9",resolution:"1080p"});
 assert.equal(kling1080.ratio,"auto_1080p");assert.equal("resolution" in kling1080,false);
 assert.throws(()=>buildRunwayImageToVideoPayload({model:"kling3.0_pro",prompt:"A cinematic scene",promptImage:image,durationSeconds:5,aspectRatio:"16:9",resolution:"1080p"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
});

test("Kling 4 Flash exposes documented text and image generation limits",()=>{
 const model=listRunwayVideoModels().find(x=>x.id==="kling_4_flash");
 assert.ok(model);assert.equal(model.minDurationSeconds,3);assert.equal(model.maxDurationSeconds,20);
 assert.deepEqual(model.resolutions,["provider_default","720p"]);
 assert.deepEqual(buildRunwayVideoPayload({model:"kling_4_flash",prompt:"A test scene",durationSeconds:20,aspectRatio:"21:9"}),{
  model:"kling_4_flash",promptText:"A test scene",ratio:"1464:628",duration:20
 });
 assert.throws(()=>buildRunwayVideoPayload({model:"kling_4_flash",prompt:"A test scene",durationSeconds:21}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 assert.throws(()=>buildRunwayVideoPayload({model:"kling_4_flash",prompt:"A test scene",durationSeconds:5,resolution:"1080p"}),e=>e.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
});
test("Kling 4 Flash image-to-video uses the documented 720p auto ratio",()=>{
 const image="data:image/png;base64,iVBORw0KGgo=";
 const payload=buildRunwayImageToVideoPayload({model:"kling_4_flash",prompt:"A test scene",promptImage:image,durationSeconds:5,resolution:"720p"});
 assert.equal(payload.ratio,"auto_720p");assert.equal("resolution" in payload,false);
});
