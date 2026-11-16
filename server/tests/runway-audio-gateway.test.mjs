import test from "node:test";
import assert from "node:assert/strict";
import {buildRunwayAudioPayload,processRunwayAudio} from "../runway-audio-gateway.mjs";

test("voice isolation payload uses the documented audio-only model",()=>{
 assert.deepEqual(buildRunwayAudioPayload({operation:"isolate",audioUri:"runway://upload/source-audio"}),{
  model:"eleven_voice_isolation",audioUri:"runway://upload/source-audio"
 });
});
test("voice dubbing payload validates language and consent-safe options",()=>{
 assert.deepEqual(buildRunwayAudioPayload({operation:"dub",audioUri:"runway://upload/source-audio",targetLang:"hi",disableVoiceCloning:true,dropBackgroundAudio:true,numSpeakers:2}),{
  model:"eleven_voice_dubbing",audioUri:"runway://upload/source-audio",targetLang:"hi",disableVoiceCloning:true,dropBackgroundAudio:true,numSpeakers:2
 });
});
test("voice dubbing rejects unsupported languages, invalid speaker counts and untrusted inputs",()=>{
 assert.throws(()=>buildRunwayAudioPayload({operation:"dub",audioUri:"runway://upload/source-audio",targetLang:"xx"}),e=>e.code==="RUNWAY_AUDIO_INVALID_INPUT");
 assert.throws(()=>buildRunwayAudioPayload({operation:"dub",audioUri:"runway://upload/source-audio",targetLang:"es",numSpeakers:0}),e=>e.code==="RUNWAY_AUDIO_INVALID_INPUT");
 assert.throws(()=>buildRunwayAudioPayload({operation:"isolate",audioUri:"https://example.com/audio.mp3"}),e=>e.code==="RUNWAY_AUDIO_INVALID_INPUT");
 assert.throws(()=>buildRunwayAudioPayload({operation:"other",audioUri:"runway://upload/source-audio"}),e=>e.code==="RUNWAY_AUDIO_INVALID_INPUT");
});
test("remote voice processing fails closed until the administrator enables it",async()=>{
 const original={enabled:process.env.RUNWAY_AUDIO_ENABLED,remote:process.env.RUNWAY_AUDIO_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.RUNWAY_AUDIO_ENABLED="true";process.env.RUNWAY_AUDIO_ALLOW_REMOTE="false";process.env.RUNWAYML_API_SECRET="test";
 await assert.rejects(()=>processRunwayAudio({operation:"isolate",buffer:Buffer.alloc(1024),filename:"source.mp3",mimeType:"audio/mpeg"}),e=>e.code==="RUNWAY_AUDIO_REMOTE_DISABLED");
 for(const [key,value] of Object.entries({RUNWAY_AUDIO_ENABLED:original.enabled,RUNWAY_AUDIO_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(value===undefined)delete process.env[key];else process.env[key]=value;
});

test("voice isolation uploads an approved audio buffer, submits once and stores bounded provider output",async()=>{
 const original={enabled:process.env.RUNWAY_AUDIO_ENABLED,remote:process.env.RUNWAY_AUDIO_ALLOW_REMOTE,key:process.env.RUNWAYML_API_SECRET};
 process.env.RUNWAY_AUDIO_ENABLED="true";process.env.RUNWAY_AUDIO_ALLOW_REMOTE="true";process.env.RUNWAYML_API_SECRET="test";
 const calls=[],audio=Buffer.alloc(512,7),output=Buffer.alloc(512,8);
 const taskId="123e4567-e89b-42d3-a456-426614174000";
 const fetchImpl=async(url,options={})=>{
  const target=String(url);calls.push({url:target,method:options.method||"GET",body:typeof options.body==="string"?JSON.parse(options.body):null});
  if(target.endsWith("/uploads"))return new Response(JSON.stringify({runwayUri:"runway://upload/source-audio",uploadUrl:"https://uploads.example.com/presigned",fields:{key:"audio-key"}}),{status:200,headers:{"content-type":"application/json"}});
  if(target==="https://uploads.example.com/presigned")return new Response(null,{status:204});
  if(target.endsWith("/voice_isolation"))return new Response(JSON.stringify({id:taskId,estimatedCost:{credits:4}}),{status:200,headers:{"content-type":"application/json"}});
  if(target.endsWith("/tasks/"+taskId))return new Response(JSON.stringify({id:taskId,status:"SUCCEEDED",model:"eleven_voice_isolation",output:["https://cdn.example.cloudfront.net/isolated.mp3"]}),{status:200,headers:{"content-type":"application/json"}});
  if(target==="https://cdn.example.cloudfront.net/isolated.mp3")return new Response(output,{status:200,headers:{"content-type":"audio/mpeg","content-length":String(output.length)}});
  throw new Error("Unexpected URL "+target);
 };
 try{
  const result=await processRunwayAudio({operation:"isolate",buffer:audio,filename:"source.mp3",mimeType:"audio/mpeg",fetchImpl,sleepImpl:async()=>{}});
  assert.equal(result.provider,"runway");assert.equal(result.requestId,taskId);assert.equal(result.estimatedCostCredits,4);assert.equal(result.mimeType,"audio/mpeg");assert.deepEqual(result.buffer,output);
  const submit=calls.find(call=>call.url.endsWith("/voice_isolation"));
  assert.deepEqual(submit.body,{model:"eleven_voice_isolation",audioUri:"runway://upload/source-audio"});
 }finally{
  for(const [key,value] of Object.entries({RUNWAY_AUDIO_ENABLED:original.enabled,RUNWAY_AUDIO_ALLOW_REMOTE:original.remote,RUNWAYML_API_SECRET:original.key}))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
