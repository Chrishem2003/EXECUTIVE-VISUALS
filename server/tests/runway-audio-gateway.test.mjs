import test from "node:test";
import assert from "node:assert/strict";
import {buildRunwayAudioPayload,processRunwayAudio} from "../runway-audio-gateway.mjs";

test("voice isolation payload uses the documented audio-only model",()=>{
 assert.deepEqual(buildRunwayAudioPayload({operation:"isolate",audioUri:"runway://upload/source-audio"}),{
  model:"eleven_voice_isolation",audioUri:"runway://upload/source-audio"
 });
});
test("voice dubbing payload validates language and consent-safe options",()=>{
 assert.deepEqual(buildRunwayAudioPayload({operation:"dub",audioUri:"runway://upload/source-audio",targetLang:"sw",disableVoiceCloning:true,dropBackgroundAudio:true,numSpeakers:2}),{
  model:"eleven_voice_dubbing",audioUri:"runway://upload/source-audio",targetLang:"sw",disableVoiceCloning:true,dropBackgroundAudio:true,numSpeakers:2
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
