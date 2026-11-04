import test from "node:test";
import assert from "node:assert/strict";
import {buildRunwayTextVideoPayload,buildRunwayImageVideoPayload,createRunwayVideoAdapter,RUNWAY_MIN_POLL_INTERVAL_MS} from "../runway-video-gateway.mjs";
const enabled={RUNWAY_VIDEO_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_API_KEY:"test-key",RUNWAY_VIDEO_MODEL:"gen4.5"};
function json(status,body){return {status,ok:status>=200&&status<300,text:async()=>JSON.stringify(body)}}
const id="17f20503-6c24-4c16-946b-35dbbce2af2f";
test("Runway text-video payload validates Gen-4.5 bounds without coercion",()=>{
 assert.deepEqual(buildRunwayTextVideoPayload({prompt:"A quiet sunrise",duration:5,ratio:"1280:720",seed:7}),{model:"gen4.5",promptText:"A quiet sunrise",ratio:"1280:720",duration:5,seed:7});
 for(const input of [{prompt:" "},{prompt:"x".repeat(1001)},{prompt:"ok",duration:1},{prompt:"ok",duration:11},{prompt:"ok",ratio:"16:9"},{prompt:"ok",seed:-1},{prompt:"ok",seed:4294967296}]){
  assert.throws(()=>buildRunwayTextVideoPayload(input));
 }
});
test("Runway adapter is disabled and remote opt-in is mandatory by default",async()=>{
 const calls=[],fetchImpl=async(...args)=>{calls.push(args);return json(200,{id,status:"PENDING"});};
 await assert.rejects(()=>createRunwayVideoAdapter({env:{},fetchImpl}).submit({prompt:"test"}),e=>e.code==="RUNWAY_DISABLED");
 await assert.rejects(()=>createRunwayVideoAdapter({env:{...enabled,RUNWAY_VIDEO_ALLOW_REMOTE:"false"},fetchImpl}).submit({prompt:"test"}),e=>e.code==="RUNWAY_REMOTE_DISABLED");
 assert.equal(calls.length,0);
 let assetUploads=0;
 const disabledImage=createRunwayVideoAdapter({
  env:{},fetchImpl,
  resolveAssetUri:async()=>{assetUploads++;return "runway://uploads/should-not-happen";}
 });
 await assert.rejects(
  ()=>disabledImage.prepareInput({prompt:"animate",startFrameAssetId:"asset-1"},{job:{owner_id:"owner-1"}}),
  error=>error.code==="RUNWAY_DISABLED"
 );
 assert.equal(assetUploads,0);
});
test("Runway adapter submits text-to-video with required version and authorization headers",async()=>{
 const calls=[];
 const adapter=createRunwayVideoAdapter({env:enabled,fetchImpl:async(url,options)=>{calls.push({url,options});return json(200,{id,status:"PENDING",estimatedCost:{credits:42}});}});
 const result=await adapter.submit({prompt:"A calm ocean at dawn",durationSeconds:5,aspectRatio:"16:9",requestId:"request-123"});
 assert.equal(result.taskId,id);assert.equal(result.status,"queued");assert.equal(result.estimatedCostCredits,42);assert.equal(result.platformRequestId,"request-123");
 assert.equal(calls[0].url,"https://api.dev.runwayml.com/v1/text_to_video");
 assert.equal(calls[0].options.headers["X-Runway-Version"],"2024-11-06");
 assert.equal(calls[0].options.headers.authorization,"Bearer test-key");
 assert.deepEqual(JSON.parse(calls[0].options.body),{model:"gen4.5",promptText:"A calm ocean at dawn",ratio:"1280:720",duration:5});
 assert.equal(RUNWAY_MIN_POLL_INTERVAL_MS,5000);
});
test("Runway task polling normalizes running and successful states and validates output URLs",async()=>{
 const queue=[{id,status:"RUNNING"},{id,status:"SUCCEEDED",output:["https://cdn.example.test/result.mp4"]}];
 const adapter=createRunwayVideoAdapter({env:enabled,fetchImpl:async()=>json(200,queue.shift())});
 assert.equal((await adapter.getStatus(id)).status,"running");
 const done=await adapter.getStatus(id);assert.equal(done.status,"succeeded");assert.deepEqual(done.outputUrls,["https://cdn.example.test/result.mp4"]);
 const unsafe=createRunwayVideoAdapter({env:enabled,fetchImpl:async()=>json(200,{id,status:"SUCCEEDED",output:["http://example.test/file"]})});
 await assert.rejects(()=>unsafe.getStatus(id),e=>e.code==="RUNWAY_INVALID_RESPONSE");
});
test("Runway cancel checks state first and never DELETEs a terminal task",async()=>{
 const calls=[];
 const terminal=createRunwayVideoAdapter({env:enabled,fetchImpl:async(url,options)=>{calls.push(options.method||"GET");return json(200,{id,status:"SUCCEEDED",output:[]});}});
 const result=await terminal.cancel(id);assert.equal(result.cancelRequested,false);assert.deepEqual(calls,["GET"]);
 const pending=createRunwayVideoAdapter({env:enabled,fetchImpl:async(url,options)=>{calls.push(options.method||"GET");return options.method==="DELETE"?{status:204,ok:true,text:async()=>""}:json(200,{id,status:"RUNNING"});}});
 const canceled=await pending.cancel(id);assert.equal(canceled.cancelRequested,true);assert.deepEqual(calls.slice(-2),["GET","DELETE"]);
});
test("Runway task IDs and HTTP failures fail closed without leaking provider bodies",async()=>{
 const adapter=createRunwayVideoAdapter({env:enabled,fetchImpl:async()=>({status:429,ok:false,text:async()=>"private provider details"})});
 await assert.rejects(()=>adapter.getStatus("not-a-uuid"),e=>e.code==="RUNWAY_INVALID_TASK_ID");
 await assert.rejects(()=>adapter.getStatus(id),e=>e.code==="RUNWAY_RATE_LIMITED"&&!e.message.includes("private provider details"));
});

test("Runway adapter rejects normalized options outside its declared model capabilities before network access",async()=>{
 let calls=0;const adapter=createRunwayVideoAdapter({env:enabled,fetchImpl:async()=>{calls++;return json(200,{id,status:"PENDING"});}});
 for(const input of [
  {prompt:"text",durationSeconds:1},
  {prompt:"text",durationSeconds:11},
  {prompt:"text",aspectRatio:"1:1"},
  {prompt:"text",resolution:"1080p"},
  {prompt:"text",negativePrompt:"avoid blur"},
  {prompt:"text",audioMode:"none"},
  {prompt:"text",startFrameAssetId:"asset-frame"},
  {prompt:"text",provider:"fal"},
  {prompt:"text",model:"kling_4"}
 ])await assert.rejects(()=>adapter.submit(input));
 assert.equal(calls,0);
});

test("Runway image-video payload validates provider upload URIs and maps Gen-4.5 fields",()=>{
 assert.deepEqual(buildRunwayImageVideoPayload({
  prompt:"A gentle camera push-in",promptImage:"runway://uploads/asset-123",
  duration:5,ratio:"1104:832",seed:12
 }),{
  model:"gen4.5",promptImage:"runway://uploads/asset-123",
  promptText:"A gentle camera push-in",position:"first",ratio:"1104:832",duration:5,seed:12
 });
 for(const promptImage of ["http://attacker.test/image.png","https://user:pass@cdn.example.test/image.png","data:image/png;base64,AAAA","not-a-uri"]){
  assert.throws(()=>buildRunwayImageVideoPayload({prompt:"move",promptImage}));
 }
});
 assert.equal(buildRunwayImageVideoPayload({
  prompt:"move",promptImage:"https://private-assets.example.test/signed/image.png?token=server-issued"
 }).promptImage,"https://private-assets.example.test/signed/image.png?token=server-issued");

test("Runway image-to-video resolves a private first-frame asset using owner and project scope",async()=>{
 const calls=[],resolved=[];
 const adapter=createRunwayVideoAdapter({
  env:enabled,
  resolveAssetUri:async scope=>{resolved.push(scope);return "runway://uploads/private-image-1";},
  fetchImpl:async(url,options)=>{calls.push({url,options});return json(200,{id,status:"PENDING",estimatedCost:{credits:60}});}
 });
 const input={
  prompt:"Animate this scene gently",startFrameAssetId:"private-asset-1",
  durationSeconds:5,aspectRatio:"4:3",requestId:"image-request-1"
 };
 const context={job:{owner_id:"owner-1",project_id:"project-1"}};
 const prepared=await adapter.prepareInput(input,context);
 const result=await adapter.submit(prepared,context);
 assert.equal(result.taskId,id);
 assert.deepEqual(resolved,[{assetId:"private-asset-1",ownerId:"owner-1",projectId:"project-1"}]);
 assert.equal(calls[0].url,"https://api.dev.runwayml.com/v1/image_to_video");
 assert.deepEqual(JSON.parse(calls[0].options.body),{
  model:"gen4.5",promptImage:"runway://uploads/private-image-1",
  promptText:"Animate this scene gently",position:"first",
  ratio:"1104:832",duration:5
 });
});

test("Runway image-to-video fails closed without a scoped asset resolver or owned job context",async()=>{
 let calls=0;
 const fetchImpl=async()=>{calls++;return json(200,{id,status:"PENDING"});};
 const noResolver=createRunwayVideoAdapter({env:enabled,fetchImpl});
 await assert.rejects(()=>noResolver.prepareInput({prompt:"animate",startFrameAssetId:"asset-1"},{job:{owner_id:"owner-1"}}),e=>e.code==="RUNWAY_IMAGE_ASSET_RESOLVER_REQUIRED");
 const withResolver=createRunwayVideoAdapter({env:enabled,fetchImpl,resolveAssetUri:async()=> "runway://uploads/a"});
 await assert.rejects(()=>withResolver.prepareInput({prompt:"animate",startFrameAssetId:"asset-1"},{}),e=>e.code==="RUNWAY_IMAGE_ASSET_SCOPE_INVALID");
 assert.equal(calls,0);
});

test("Runway text-to-video rejects image-only aspect ratios instead of silently changing framing",async()=>{
 let calls=0;
 const adapter=createRunwayVideoAdapter({env:enabled,fetchImpl:async()=>{calls++;return json(200,{id,status:"PENDING"});}});
 await assert.rejects(()=>adapter.submit({prompt:"text",aspectRatio:"4:3"}),e=>e.code==="RUNWAY_UNSUPPORTED_CAPABILITY");
 assert.equal(calls,0);
});
