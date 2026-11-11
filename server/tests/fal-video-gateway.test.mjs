import test from "node:test";
import assert from "node:assert/strict";
import {generateFalVideo, buildFalVideoPayload, getFalVideoCapabilities} from "../fal-video-gateway.mjs";
const names=["VIDEO_GATEWAY_ENABLED","VIDEO_GATEWAY_ALLOW_REMOTE","VIDEO_GATEWAY_TIMEOUT_MS","FAL_KEY","FAL_VIDEO_MODEL","FAL_VIDEO_IMAGE_INPUT_FIELD"];
const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
const restore=()=>{for(const name of names)saved[name]===undefined?delete process.env[name]:process.env[name]=saved[name]};
function json(status,body){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}})}
test("video adapter submits, polls and returns validated MP4 bytes",async()=>{
 const original=globalThis.fetch,calls=[];
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",VIDEO_GATEWAY_TIMEOUT_MS:"10000",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(url);calls.push({url:parsed.toString(),options});
  if(options.method==="POST")return json(200,{request_id:"video_123",status_url:"https://queue.fal.run/fal-ai/example-video/requests/video_123/status",response_url:"https://queue.fal.run/fal-ai/example-video/requests/video_123"});
  if(parsed.pathname.endsWith("/status"))return json(200,{status:"COMPLETED"});
  if(parsed.hostname==="queue.fal.run")return json(200,{video:{url:"https://v3.fal.media/files/output.mp4"}});
  const bytes=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0]);
  return {ok:true,status:200,headers:new Headers({"content-length":String(bytes.length)}),body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})};
 };
 try{
  const result=await generateFalVideo({prompt:"A cinematic aerial shot",duration:7,aspectRatio:"9:16"});
  assert.equal(result.provider,"fal");assert.equal(result.requestId,"video_123");assert.equal(result.mimeType,"video/mp4");
  assert.equal(result.buffer.toString("ascii",4,8),"ftyp");assert.equal(calls.length,4);
  assert.equal(calls[0].options.headers.authorization,"Key test-key");
  assert.equal(calls.at(-1).options.redirect,"error");
  assert.deepEqual(JSON.parse(calls[0].options.body),{prompt:"A cinematic aerial shot",duration:7,aspect_ratio:"9:16"});
 }finally{globalThis.fetch=original;restore()}
});
test("video adapter forwards a reference image only through the configured model input field",async()=>{
 const original=globalThis.fetch,calls=[];
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",VIDEO_GATEWAY_TIMEOUT_MS:"10000",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/image-to-video",FAL_VIDEO_IMAGE_INPUT_FIELD:"image_url"});
 globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(url);calls.push({url:parsed.toString(),options});
  if(options.method==="POST")return json(200,{request_id:"video_ref_123",status_url:"https://queue.fal.run/fal-ai/image-to-video/requests/video_ref_123/status",response_url:"https://queue.fal.run/fal-ai/image-to-video/requests/video_ref_123"});
  if(parsed.pathname.endsWith("/status"))return json(200,{status:"COMPLETED"});
  if(parsed.hostname==="queue.fal.run")return json(200,{video:{url:"https://v3.fal.media/files/reference-output.mp4"}});
  const bytes=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0]);
  return {ok:true,status:200,headers:new Headers({"content-length":String(bytes.length)}),body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})};
 };
 const referenceImageDataUrl="data:image/png;base64,iVBORw0KGgo=";
 try{
  await generateFalVideo({prompt:"Animate this approved reference frame",duration:5,aspectRatio:"16:9",referenceImageDataUrl});
  const submitted=JSON.parse(calls[0].options.body);
  assert.equal(submitted.image_url,referenceImageDataUrl);
  assert.equal(submitted.prompt,"Animate this approved reference frame");
  assert.equal(submitted.duration,5);
 }finally{globalThis.fetch=original;restore()}
});
test("video adapter requires explicit remote opt-in and rejects unsafe output hosts",async()=>{
 const original=globalThis.fetch;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"false",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 try{
  await assert.rejects(()=>generateFalVideo({prompt:"test"}),e=>e.code==="VIDEO_GATEWAY_REMOTE_DISABLED");
  process.env.VIDEO_GATEWAY_ALLOW_REMOTE="true";
  globalThis.fetch=async(url,options={})=>{const parsed=new URL(url);if(options.method==="POST")return json(200,{request_id:"x",status_url:"https://queue.fal.run/status",response_url:"https://queue.fal.run/result"});if(parsed.pathname==="/status")return json(200,{status:"COMPLETED"});return json(200,{video:{url:"https://attacker.example/video.mp4"}})};
  await assert.rejects(()=>generateFalVideo({prompt:"test"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");
 }finally{globalThis.fetch=original;restore()}
});


test("video capability declaration matches the configured model input contract",()=>{
 const withoutReference=getFalVideoCapabilities({imageInputField:""});
 assert.equal(withoutReference.referenceImages,false);
 assert.deepEqual(withoutReference.aspectRatios,["16:9","9:16","1:1"]);
 assert.deepEqual(withoutReference.resolutions,["provider_default"]);
 assert.deepEqual(withoutReference.audioModes,[]);
 assert.equal(withoutReference.maxDurationSeconds,30);
 const withReference=getFalVideoCapabilities({imageInputField:"image_url"});
 assert.equal(withReference.referenceImages,true);
 assert.equal(getFalVideoCapabilities({imageInputField:"unsupported_field"}).referenceImages,false);
});

test("video payload rejects invalid durations, unsupported aspect ratios and empty prompts",()=>{
 for(const duration of [0,0.5,31,NaN,Infinity]){
  assert.throws(()=>buildFalVideoPayload({prompt:"A valid prompt",duration}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
 }
 assert.throws(()=>buildFalVideoPayload({prompt:"A valid prompt",aspectRatio:"4:3"}),error=>error.code==="VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
 assert.throws(()=>buildFalVideoPayload({prompt:"   "}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildFalVideoPayload({prompt:"x".repeat(12001)}),error=>error.code==="VIDEO_GATEWAY_INVALID_INPUT");
});

test("video payload preserves valid requested duration and aspect ratio without coercion",()=>{
 assert.deepEqual(buildFalVideoPayload({prompt:"Keep the framing",duration:12,aspectRatio:"9:16"}),{
  prompt:"Keep the framing",duration:12,aspect_ratio:"9:16"
 });
});


test("FAL API JSON responses are streamed with a hard 2 MiB cap",async()=>{
 const original=globalThis.fetch;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>new Response("x".repeat(2*1024*1024+1),{status:200});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");}
 finally{globalThis.fetch=original;restore();}
});


test("FAL rejects response bodies without a readable stream instead of buffering them",async()=>{
 const original=globalThis.fetch;let textRead=false;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>({status:200,ok:true,headers:new Headers(),body:null,text:async()=>{textRead=true;return "{}";}});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(textRead,false);}
 finally{globalThis.fetch=original;restore();}
});


test("FAL cancels a response body immediately when declared JSON size exceeds the cap",async()=>{
 const original=globalThis.fetch;let cancelled=false;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>({status:200,ok:true,headers:new Headers({"content-length":String(2*1024*1024+1)}),body:{cancel:async()=>{cancelled=true;}}});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(cancelled,true);}
 finally{globalThis.fetch=original;restore();}
});

test("FAL cancels oversized generated-video downloads from Content-Length before reading",async()=>{
 const original=globalThis.fetch;let cancelled=false;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",VIDEO_GATEWAY_TIMEOUT_MS:"10000",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(url);
  if(options.method==="POST")return json(200,{request_id:"video_oversized",status_url:"https://queue.fal.run/fal-ai/example-video/requests/video_oversized/status",response_url:"https://queue.fal.run/fal-ai/example-video/requests/video_oversized"});
  if(parsed.pathname.endsWith("/status"))return json(200,{status:"COMPLETED"});
  if(parsed.hostname==="queue.fal.run")return json(200,{video:{url:"https://v3.fal.media/files/oversized.mp4"}});
  return {ok:true,status:200,headers:new Headers({"content-length":String(250*1024*1024+1)}),body:{cancel:async()=>{cancelled=true;}}};
 };
 try{await assert.rejects(()=>generateFalVideo({prompt:"A cinematic shot"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(cancelled,true);}
 finally{globalThis.fetch=original;restore();}
});
