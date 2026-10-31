import test from "node:test";
import assert from "node:assert/strict";
import {generateFalVideo} from "../fal-video-gateway.mjs";
const names=["VIDEO_GATEWAY_ENABLED","VIDEO_GATEWAY_ALLOW_REMOTE","VIDEO_GATEWAY_TIMEOUT_MS","FAL_KEY","FAL_VIDEO_MODEL"];
const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
const restore=()=>{for(const name of names)saved[name]===undefined?delete process.env[name]:process.env[name]=saved[name]};
function json(status,body){return {status,ok:status>=200&&status<300,text:async()=>JSON.stringify(body)}}
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
