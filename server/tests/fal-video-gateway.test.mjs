import test from "node:test";
import assert from "node:assert/strict";
import {generateFalVideo, buildFalVideoPayload, getFalVideoCapabilities, submitFalVideoTask, getFalVideoTask, downloadFalVideoTaskOutput} from "../fal-video-gateway.mjs";
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


test("durable Fal adapter submits full endpoint paths and polls the persisted request ID",async()=>{
 const previous={VIDEO_GATEWAY_ENABLED:process.env.VIDEO_GATEWAY_ENABLED,VIDEO_GATEWAY_ALLOW_REMOTE:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,FAL_KEY:process.env.FAL_KEY,FAL_VIDEO_MODEL:process.env.FAL_VIDEO_MODEL};
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/veo/v3.1"});
 const requestId="019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b",calls=[];
 const fetchImpl=async(url,options={})=>{
  const parsed=new URL(url);calls.push({url:parsed.toString(),options});
  if(options.method==="POST")return json(200,{status:"IN_QUEUE",request_id:requestId});
  if(parsed.pathname.endsWith("/status"))return json(200,{status:"COMPLETED",request_id:requestId});
  return json(200,{video:{url:"https://v3.fal.media/files/final.mp4"}});
 };
 try{
  const submitted=await submitFalVideoTask({model:"fal-ai/veo/v3.1",prompt:"A cinematic landscape",durationSeconds:8,aspectRatio:"16:9",fetchImpl});
  assert.equal(submitted.taskId,requestId);
  assert.equal(submitted.provider,"fal");
  assert.match(calls[0].url,/queue\.fal\.run\/fal-ai\/veo\/v3\.1$/);
  assert.equal(calls[0].options.headers.authorization,"Key test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body),{prompt:"A cinematic landscape",duration:8,aspect_ratio:"16:9"});
  const result=await getFalVideoTask({taskId:requestId,model:"fal-ai/veo/v3.1",fetchImpl});
  assert.equal(result.status,"SUCCEEDED");
  assert.equal(result.outputUrl,"https://v3.fal.media/files/final.mp4");
  assert.match(calls[1].url,/queue\.fal\.run\/fal-ai\/veo\/requests\/[0-9a-f-]+\/status$/);
  assert.match(calls[2].url,/queue\.fal\.run\/fal-ai\/veo\/requests\/[0-9a-f-]+$/);
 }finally{for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;}
});
test("durable Fal adapter surfaces completed queue failures without attempting result download",async()=>{
 const previous={VIDEO_GATEWAY_ENABLED:process.env.VIDEO_GATEWAY_ENABLED,VIDEO_GATEWAY_ALLOW_REMOTE:process.env.VIDEO_GATEWAY_ALLOW_REMOTE,FAL_KEY:process.env.FAL_KEY,FAL_VIDEO_MODEL:process.env.FAL_VIDEO_MODEL};
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 const requestId="019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b",calls=[];
 const fetchImpl=async(url)=>{calls.push(String(url));return json(200,{status:"COMPLETED",request_id:requestId,error:"Model failed",error_type:"runner_error"});};
 try{
  const result=await getFalVideoTask({taskId:requestId,model:"fal-ai/example-video",fetchImpl});
  assert.equal(result.status,"FAILED");
  assert.equal(result.error.code,"runner_error");
  assert.equal(calls.length,1);
 }finally{for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;}
});
test("durable Fal output downloader rejects non-Fal hosts and validates MP4 bytes",async()=>{
 const bytes=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0]);
 const fetchImpl=async()=>({ok:true,status:200,headers:new Headers({"content-length":String(bytes.length)}),body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})});
 const result=await downloadFalVideoTaskOutput({outputUrl:"https://v3.fal.media/files/final.mp4",fetchImpl});
 assert.equal(result.toString("ascii",4,8),"ftyp");
 await assert.rejects(()=>downloadFalVideoTaskOutput({outputUrl:"https://attacker.example/final.mp4",fetchImpl}),error=>error.code==="VIDEO_GATEWAY_INVALID_RESPONSE");
});

test("Fal API JSON responses are streamed with a hard 2 MiB cap",async()=>{
 const original=globalThis.fetch;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>new Response("x".repeat(2*1024*1024+1),{status:200});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");}
 finally{globalThis.fetch=original;restore();}
});
test("Fal rejects JSON responses without a readable stream rather than buffering them",async()=>{
 const original=globalThis.fetch;let textRead=false;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>({status:200,ok:true,headers:new Headers(),body:null,text:async()=>{textRead=true;return "{}";}});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(textRead,false);}
 finally{globalThis.fetch=original;restore();}
});
test("Fal cancels declared oversized JSON and rejected response bodies before parsing",async()=>{
 const original=globalThis.fetch;let cancelled=0;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>({status:429,ok:false,headers:new Headers(),body:{cancel:async()=>{cancelled++;}}});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_RATE_LIMITED");assert.equal(cancelled,1);}
 finally{globalThis.fetch=original;restore();}
});

test("Fal cancels declared oversized JSON and media bodies before reading",async()=>{
 const original=globalThis.fetch;let jsonCancelled=false;
 Object.assign(process.env,{VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",FAL_KEY:"test-key",FAL_VIDEO_MODEL:"fal-ai/example-video"});
 globalThis.fetch=async()=>({status:200,ok:true,headers:new Headers({"content-length":String(2*1024*1024+1)}),body:{cancel:async()=>{jsonCancelled=true;}}});
 try{await assert.rejects(()=>generateFalVideo({prompt:"A test scene"}),e=>e.code==="VIDEO_GATEWAY_INVALID_RESPONSE");assert.equal(jsonCancelled,true);}
 finally{globalThis.fetch=original;restore();}
 let mediaCancelled=false;
 await assert.rejects(()=>downloadFalVideoTaskOutput({outputUrl:"https://v3.fal.media/files/oversized.mp4",fetchImpl:async()=>({status:200,ok:true,headers:new Headers({"content-length":String(250*1024*1024+1)}),body:{cancel:async()=>{mediaCancelled=true;}}})}),e=>e.code==="VIDEO_OUTPUT_INVALID");
 assert.equal(mediaCancelled,true);
});
