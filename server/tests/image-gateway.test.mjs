import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { generateImage } from "../image-gateway.mjs";
import { storeGeneratedImage } from "../generated-assets.mjs";

const envKeys=["IMAGE_GATEWAY_ENABLED","IMAGE_GATEWAY_URL","IMAGE_GATEWAY_MODEL","IMAGE_GATEWAY_API_KEY","IMAGE_GATEWAY_TIMEOUT_MS","IMAGE_GATEWAY_ALLOW_REMOTE"];
const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const restore=()=>envKeys.forEach(key=>saved[key]===undefined?delete process.env[key]:process.env[key]=saved[key]);
const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z9sAAAAASUVORK5CYII=";

test("image gateway returns validated bytes and stores a private checksum-verified asset",async()=>{
 const server=createServer(async(req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  assert.equal(req.url,"/v1/images/generations");
  assert.equal(req.headers.authorization,"Bearer image-test-secret");
  const payload=JSON.parse(body);
  assert.equal(payload.model,"image-test-model");
  assert.equal(payload.prompt,"An original cinematic landscape");
  assert.equal(payload.response_format,"b64_json");
  assert.equal(payload.n,1);
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({model:"image-test-model",data:[{b64_json:png}],usage:{prompt_tokens:20,total_tokens:20}}));
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const root=await mkdtemp(join(tmpdir(),"ev-image-gateway-"));
 const db=openDatabase(join(root,"image.sqlite"));
 try{
  const address=server.address();
  process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";process.env.IMAGE_GATEWAY_MODEL="image-test-model";process.env.IMAGE_GATEWAY_API_KEY="image-test-secret";process.env.IMAGE_GATEWAY_TIMEOUT_MS="5000";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="false";
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("image-user","image@example.test");
  const generated=await generateImage({prompt:"An original cinematic landscape",size:"1024x1024",quality:"high"});
  assert.equal(generated.model,"image-test-model");
  assert.equal(generated.buffer.toString("base64"),png);
  const asset=await storeGeneratedImage({db,mediaRoot:join(root,"media"),ownerId:"image-user",projectId:null,jobId:"image-job",prompt:"An original cinematic landscape",model:generated.model,buffer:generated.buffer});
  const row=db.prepare("SELECT * FROM assets WHERE id=?").get(asset.id);
  assert.equal(row.media_type,"image/png");
  assert.equal(row.sha256,asset.sha256);
  assert.equal(JSON.parse(row.metadata_json).generated,true);
  const stored=await readFile(join(root,"media",row.storage_path));
  assert.equal(stored.toString("base64"),png);
 }finally{restore();db.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
test("image gateway is disabled by default and remote access requires explicit opt-in",async()=>{
 process.env.IMAGE_GATEWAY_ENABLED="false";
 await assert.rejects(()=>generateImage({prompt:"test"}),error=>error.code==="IMAGE_GATEWAY_DISABLED");
 process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_URL="http://example.com/v1";process.env.IMAGE_GATEWAY_MODEL="image-test-model";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="false";
 await assert.rejects(()=>generateImage({prompt:"test"}),error=>error.code==="IMAGE_GATEWAY_INSECURE_URL");
 process.env.IMAGE_GATEWAY_URL="https://gateway.example.test/v1";
 await assert.rejects(()=>generateImage({prompt:"test"}),error=>error.code==="IMAGE_GATEWAY_REMOTE_DISABLED");
 restore();
});
test("image gateway rejects malformed or non-image base64 output",async()=>{
 const server=createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[{b64_json:Buffer.from("not an image").toString("base64")}]}));});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const address=server.address();
  process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";process.env.IMAGE_GATEWAY_MODEL="image-test-model";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="false";
  await assert.rejects(async()=>{const result=await generateImage({prompt:"test"});await storeGeneratedImage({db:{prepare(){throw new Error("should not reach database");}},mediaRoot:tmpdir(),ownerId:"x",jobId:"x",prompt:"test",model:result.model,buffer:result.buffer});},error=>error.code==="IMAGE_SIGNATURE_INVALID");
 }finally{restore();await new Promise(resolve=>server.close(resolve));}
});
