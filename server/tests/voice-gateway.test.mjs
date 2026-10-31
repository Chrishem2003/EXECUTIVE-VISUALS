import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { generateVoice } from "../voice-gateway.mjs";
import { storeGeneratedAudio } from "../generated-assets.mjs";

const envKeys=["VOICE_GATEWAY_ENABLED","VOICE_GATEWAY_URL","VOICE_GATEWAY_MODEL","VOICE_GATEWAY_API_KEY","VOICE_GATEWAY_TIMEOUT_MS","VOICE_GATEWAY_ALLOW_REMOTE","VOICE_GATEWAY_VOICE"];
const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const restore=()=>envKeys.forEach(key=>saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key]);
const mp3=Buffer.from([0xff,0xfb,0x90,0x64,0x00,0x00,0x00,0x00]);

test("voice gateway creates validated audio and persists a private checksum-verified asset",async()=>{
 const server=createServer(async(req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  assert.equal(req.url,"/v1/audio/speech");
  assert.equal(req.headers.authorization,"Bearer voice-test-secret");
  const payload=JSON.parse(body);
  assert.equal(payload.model,"voice-test-model");
  assert.equal(payload.input,"Welcome to Executive Visuals.");
  assert.equal(payload.voice,"alloy");
  assert.equal(payload.response_format,"mp3");
  res.writeHead(200,{"content-type":"audio/mpeg","content-length":String(mp3.length)});res.end(mp3);
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const root=await mkdtemp(join(tmpdir(),"ev-voice-gateway-")),db=openDatabase(join(root,"voice.sqlite"));
 try{
  const address=server.address();
  process.env.VOICE_GATEWAY_ENABLED="true";process.env.VOICE_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";process.env.VOICE_GATEWAY_MODEL="voice-test-model";process.env.VOICE_GATEWAY_API_KEY="voice-test-secret";process.env.VOICE_GATEWAY_TIMEOUT_MS="5000";process.env.VOICE_GATEWAY_ALLOW_REMOTE="false";
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("voice-user","voice@example.test");
  const generated=await generateVoice({text:"Welcome to Executive Visuals.",voice:"alloy",format:"mp3"});
  assert.equal(generated.mimeType,"audio/mpeg");assert.deepEqual(generated.buffer,mp3);
  const asset=await storeGeneratedAudio({db,mediaRoot:join(root,"media"),ownerId:"voice-user",jobId:"voice-job",prompt:"Welcome to Executive Visuals.",model:generated.model,buffer:generated.buffer,mimeType:generated.mimeType});
  const row=db.prepare("SELECT * FROM assets WHERE id=?").get(asset.id);
  assert.equal(row.media_type,"audio/mpeg");assert.equal(row.sha256,asset.sha256);assert.equal(JSON.parse(row.metadata_json).generated,true);
  assert.deepEqual(await readFile(join(root,"media",row.storage_path)),mp3);
 }finally{restore();db.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
test("voice generation is disabled by default and remote access requires explicit opt-in",async()=>{
 process.env.VOICE_GATEWAY_ENABLED="false";
 await assert.rejects(()=>generateVoice({text:"hello"}),error=>error.code==="VOICE_GATEWAY_DISABLED");
 process.env.VOICE_GATEWAY_ENABLED="true";process.env.VOICE_GATEWAY_URL="https://voice.example.test/v1";process.env.VOICE_GATEWAY_MODEL="voice-test-model";process.env.VOICE_GATEWAY_ALLOW_REMOTE="false";
 await assert.rejects(()=>generateVoice({text:"hello"}),error=>error.code==="VOICE_GATEWAY_REMOTE_DISABLED");
 restore();
});
test("voice gateway rejects invalid scripts and non-audio responses",async()=>{
 process.env.VOICE_GATEWAY_ENABLED="true";process.env.VOICE_GATEWAY_URL="http://127.0.0.1:1/v1";process.env.VOICE_GATEWAY_MODEL="voice-test-model";process.env.VOICE_GATEWAY_ALLOW_REMOTE="false";
 await assert.rejects(()=>generateVoice({text:"  "}),error=>error.code==="SCRIPT_REQUIRED");
 const server=createServer((req,res)=>{res.writeHead(200,{"content-type":"audio/mpeg"});res.end("not audio")});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  process.env.VOICE_GATEWAY_URL="http://127.0.0.1:"+server.address().port+"/v1";
  await assert.rejects(()=>generateVoice({text:"hello"}),error=>error.code==="VOICE_GATEWAY_INVALID_RESPONSE");
 }finally{restore();await new Promise(resolve=>server.close(resolve));}
});
