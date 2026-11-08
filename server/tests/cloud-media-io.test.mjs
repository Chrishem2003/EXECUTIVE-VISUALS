import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCloudMediaAssetIO } from "../cloud-media-io.mjs";

const content=Buffer.from("cloud-media-fixture");
const digest=createHash("sha256").update(content).digest("hex");
function response(data,status=200){return{ok:status>=200&&status<300,status,headers:new Headers({"content-length":String(data.length)}),body:new Response(data).body};}
async function fixture({payload=content,assetSha=digest,assetSize=content.length,maxBytes=100}={}){
 const root=await mkdtemp(join(tmpdir(),"ev-media-test-")),calls=[];
 const assets={
  async createSignedUrl(args){calls.push({op:"sign",args});return{url:"https://storage.example/signed",asset:{id:"asset-1",ownerId:"owner-1",size:assetSize,sha256:assetSha,mediaType:"video/mp4"}};},
  async create(args){calls.push({op:"create",args});return{id:"created",name:args.originalName,size:args.bytes.length};}
 };
 const io=createCloudMediaAssetIO({assets,tempRoot:root,maxBytes,fetchImpl:async(url,options)=>{calls.push({op:"download",url,options});return response(payload);}});
 return{io,root,calls};
}
test("materializes authorized cloud asset into a private temporary file and verifies checksum",async()=>{
 const f=await fixture();const result=await f.io.materialize({ownerId:"owner-1",assetId:"asset-1"});
 assert.equal(result.sha256,digest);assert.deepEqual(await readFile(result.path),content);
 assert.equal(f.calls[0].op,"sign");assert.equal(f.calls[0].args.ownerId,"owner-1");
 await result.cleanup();await result.cleanup();assert.deepEqual(await readdir(f.root),[]);
 await rm(f.root,{recursive:true,force:true});
});
test("rejects altered cloud content and removes temporary files",async()=>{
 const f=await fixture({payload:Buffer.from("tampered")});
 await assert.rejects(()=>f.io.materialize({ownerId:"owner-1",assetId:"asset-1"}),e=>e.code==="CLOUD_MEDIA_INTEGRITY_MISMATCH");
 assert.deepEqual(await readdir(f.root),[]);await rm(f.root,{recursive:true,force:true});
});
test("rejects downloads that exceed the configured byte limit",async()=>{
 const f=await fixture({payload:Buffer.alloc(101),assetSize:101,maxBytes:100});
 await assert.rejects(()=>f.io.materialize({ownerId:"owner-1",assetId:"asset-1"}),e=>e.code==="CLOUD_MEDIA_TOO_LARGE");
 assert.deepEqual(await readdir(f.root),[]);await rm(f.root,{recursive:true,force:true});
});
test("publishes generated media using asset repository metadata and bytes",async()=>{
 const f=await fixture();const path=join(f.root,"render.mp4");await writeFile(path,content);
 const result=await f.io.publish({ownerId:"owner-1",projectId:"project-1",filename:"render.mp4",mediaType:"video/mp4",path,metadata:{operation:"timeline.render"}});
 assert.equal(result.id,"created");const call=f.calls.find(x=>x.op==="create");
 assert.equal(call.args.ownerId,"owner-1");assert.equal(call.args.projectId,"project-1");assert.deepEqual(call.args.bytes,content);
 await rm(f.root,{recursive:true,force:true});
});
test("publishes worker output through the streaming repository method when available",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-media-stream-test-")),path=join(root,"master.mp4");await writeFile(path,content);
 let call=null;
 const assets={async createSignedUrl(){},async createFromFile(args){call=args;return{id:"streamed-asset"}}};
 const io=createCloudMediaAssetIO({assets,tempRoot:root,maxBytes:100});
 const result=await io.publish({ownerId:"owner-1",projectId:"project-1",filename:"master.mp4",mediaType:"video/mp4",path,metadata:{operation:"timeline.render"}});
 assert.equal(result.id,"streamed-asset");assert.equal(call.filePath,path);assert.equal(call.ownerId,"owner-1");
 await rm(root,{recursive:true,force:true});
});
test("rejects oversized output before reading it into memory or calling the repository",async()=>{
 const f=await fixture({maxBytes:5});const path=join(f.root,"large.mp4");await writeFile(path,Buffer.alloc(6));
 await assert.rejects(()=>f.io.publish({ownerId:"owner-1",filename:"large.mp4",mediaType:"video/mp4",path}),e=>e.code==="CLOUD_MEDIA_TOO_LARGE");
 assert.equal(f.calls.some(x=>x.op==="create"),false);await rm(f.root,{recursive:true,force:true});
});
test("rejects unsafe signed download URLs before making a request",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-media-test-")),calls=[];
 const io=createCloudMediaAssetIO({tempRoot:root,assets:{async createSignedUrl(){return{url:"http://attacker.example/file",asset:{size:4,sha256:digest}}},async create(){}},fetchImpl:async()=>{calls.push("fetch");return response(content)}});
 await assert.rejects(()=>io.materialize({ownerId:"owner-1",assetId:"asset-1"}),/unsafe signed URL/);
 assert.equal(calls.length,0);await rm(root,{recursive:true,force:true});
});
test("requires explicit repository methods and valid limits",()=>{
 assert.throws(()=>createCloudMediaAssetIO({}),/asset repository/);
 assert.throws(()=>createCloudMediaAssetIO({assets:{createSignedUrl(){},create(){}},maxBytes:0}),/byte limit/);
});

test("routes a stable publication key to the idempotent asset repository method",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-media-idempotent-test-")),path=join(root,"render.mp4");
 await writeFile(path,content);
 let call=null;
 const assets={async createSignedUrl(){},async createFromFile(){throw new Error("non-idempotent path must not be used");},async createFromFileIdempotent(args){call=args;return{id:"stable-asset"};}};
 const io=createCloudMediaAssetIO({assets,tempRoot:root,maxBytes:100});
 const leaseContext={jobId:"523e4567-e89b-42d3-a456-426614174000",workerId:"worker-test-1",leaseToken:"623e4567-e89b-42d3-a456-426614174000"};
 let leaseChecks=0;
 const result=await io.publish({ownerId:"owner-1",projectId:"project-1",filename:"render.mp4",mediaType:"video/mp4",path,publicationKey:"job-1:output:v1",leaseContext,assertLease:async()=>{leaseChecks++;return true;}});
 assert.equal(result.id,"stable-asset");
 assert.equal(call.publicationKey,"job-1:output:v1");
 assert.equal(call.filePath,path);
 assert.deepEqual(call.leaseContext,leaseContext);
 assert.equal(leaseChecks,1);
 await rm(root,{recursive:true,force:true});
});
