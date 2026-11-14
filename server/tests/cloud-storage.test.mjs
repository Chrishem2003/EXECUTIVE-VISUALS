import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCloudStorage, buildCloudAssetObjectPath } from "../cloud-storage.mjs";

const config={url:"https://example.supabase.co",serviceRoleKey:"storage-secret"};
const uuid="123e4567-e89b-42d3-a456-426614174000";
const path=uuid+"/assets/master.mp4";
function response(body={},status=200){return{ok:status>=200&&status<300,status,async text(){return JSON.stringify(body);}};}

test("uploads private assets to the fixed bucket using server credentials",async()=>{
 const calls=[];
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{calls.push({url,options});return response({Key:"ok"});}});
 const bytes=new Uint8Array([1,2,3,4]);
 const result=await storage.upload(path,bytes,"video/mp4");
 assert.deepEqual(result,{bucket:"executive-visuals-media",path,size:4,contentType:"video/mp4"});
 assert.equal(calls[0].url,"https://example.supabase.co/storage/v1/object/executive-visuals-media/"+path);
 assert.equal(calls[0].options.method,"POST");
 assert.equal(calls[0].options.headers.apikey,config.serviceRoleKey);
 assert.equal(calls[0].options.headers["x-upsert"],"false");
 assert.equal(calls[0].options.headers["content-type"],"video/mp4");
 assert.equal(calls[0].options.body,bytes);
});

test("streams media files to private storage and returns the streamed checksum",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-storage-test-")),file=join(root,"large.mp4"),bytes=Buffer.from("streamed-media-content"),calls=[];
 await writeFile(file,bytes);
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{
  const chunks=[];for await(const chunk of options.body)chunks.push(Buffer.from(chunk));
  calls.push({url,options,bytes:Buffer.concat(chunks)});
  return response({Key:"streamed"});
 }});
 const result=await storage.uploadFile(path,file,"video/mp4");
 assert.equal(result.size,bytes.length);assert.equal(result.sha256,createHash("sha256").update(bytes).digest("hex"));
 assert.deepEqual(calls[0].bytes,bytes);assert.equal(calls[0].options.duplex,"half");
 assert.equal(calls[0].options.headers["content-length"],String(bytes.length));
 await rm(root,{recursive:true,force:true});
});
test("rejects oversized files before starting a streaming storage request",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-storage-limit-")),file=join(root,"large.mp4");await writeFile(file,Buffer.alloc(5));
 let called=false;const storage=createCloudStorage({...config,maxBytes:4,fetchImpl:async()=>{called=true;return response({});}});
 await assert.rejects(()=>storage.uploadFile(path,file,"video/mp4"),/size limit/);
 assert.equal(called,false);await rm(root,{recursive:true,force:true});
});
test("signed URLs are short-lived, validated and pinned to the configured origin",async()=>{
 const calls=[];
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{calls.push({url,options});return response({signedURL:"/object/sign/executive-visuals-media/"+path+"?token=temporary"});}});
 const url=await storage.createSignedUrl(path,300);
 assert.equal(new URL(url).origin,"https://example.supabase.co");
 assert.ok(new URL(url).pathname.startsWith("/storage/v1/object/sign/"));
 assert.equal(calls[0].options.method,"POST");
 assert.deepEqual(JSON.parse(calls[0].options.body),{expiresIn:300});
 await assert.rejects(()=>storage.createSignedUrl(path,10),/expiry/);
 const foreign=createCloudStorage({...config,fetchImpl:async()=>response({signedURL:"https://example.supabase.co/not-a-storage-link"})});
 await assert.rejects(()=>foreign.createSignedUrl(path),/unsafe signed URL/);
});

test("lists an exact asset prefix with Storage List V2 cursor pagination",async()=>{
 const calls=[];
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return response({hasNext:true,nextCursor:"cursor-next",folders:[],objects:[
   {id:"object-1",name:"attempt-423e4567-e89b-42d3-a456-426614174000.mp4",created_at:"2026-11-01T00:00:00Z",metadata:{size:12}},
   {id:"object-2",name:"original.mp4",created_at:"2026-11-01T00:00:00Z"}
  ]});
 }});
 const prefix=uuid+"/323e4567-e89b-42d3-a456-426614174000/";
 const result=await storage.listObjects({prefix,limit:25});
 assert.equal(calls[0].url,"https://example.supabase.co/storage/v1/object/list-v2/executive-visuals-media");
 assert.equal(calls[0].options.method,"POST");
 assert.deepEqual(JSON.parse(calls[0].options.body),{prefix,limit:25,with_delimiter:false,sortBy:{column:"name",order:"asc"}});
 assert.equal(result.objects.length,2);
 assert.equal(result.objects[0].createdAt,"2026-11-01T00:00:00Z");
 assert.equal(result.hasNext,true);
 assert.equal(result.nextCursor,"cursor-next");
 await storage.listObjects({prefix,limit:25,cursor:result.nextCursor});
 assert.equal(JSON.parse(calls[1].options.body).cursor,"cursor-next");
 await assert.rejects(()=>storage.listObjects({prefix:"../"}),/exact owner-or-project/);
 await assert.rejects(()=>storage.listObjects({prefix,limit:1001}),/pagination/);
 await assert.rejects(()=>storage.listObjects({prefix,cursor:""}),/pagination/);
});

test("aborts a streaming upload when its worker execution signal is cancelled",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-storage-abort-")),file=join(root,"render.mp4");
 await writeFile(file,Buffer.from("render"));
 const controller=new AbortController();
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{
  if(options.signal.aborted)throw Object.assign(new Error("aborted"),{name:"AbortError"});
  return await new Promise((resolve,reject)=>{
   options.signal.addEventListener("abort",()=>reject(Object.assign(new Error("aborted"),{name:"AbortError"})),{once:true});
  });
 }});
 const pending=storage.uploadFile(path,file,"video/mp4",{signal:controller.signal});
 controller.abort();
 await assert.rejects(()=>pending,error=>error.code==="CLOUD_STORAGE_UPLOAD_ABORTED");
 await rm(root,{recursive:true,force:true});
});

test("removal is scoped to the fixed bucket and exact object prefix",async()=>{
 const calls=[];
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{calls.push({url,options});return response({});}});
 assert.equal(await storage.remove(path),true);
 assert.equal(calls[0].url,"https://example.supabase.co/storage/v1/object/executive-visuals-media");
 assert.equal(calls[0].options.method,"DELETE");
 assert.deepEqual(JSON.parse(calls[0].options.body),{prefixes:[path]});
});

test("unsafe paths, unsupported media, oversized data and credential-bearing URLs fail closed",async()=>{
 const storage=createCloudStorage({...config,maxBytes:4,fetchImpl:async()=>response({})});
 await assert.rejects(()=>storage.upload("../escape",new Uint8Array([1]),"video/mp4"),/path/);
 await assert.rejects(()=>storage.upload("not-a-uuid/file.mp4",new Uint8Array([1]),"video/mp4"),/UUID/);
 await assert.rejects(()=>storage.upload(path,new Uint8Array([1]),"application/x-executable"),/Unsupported/);
 await assert.rejects(()=>storage.upload(path,new Uint8Array(5),"video/mp4"),/size limit/);
 await assert.rejects(()=>storage.upload(path,new Uint8Array(0),"video/mp4"),/empty/);
 assert.throws(()=>createCloudStorage({url:"https://user:pass@example.supabase.co",serviceRoleKey:"secret"}),/HTTPS/);
});

test("cloud asset object paths match owner and project storage policy prefixes",()=>{
 const ownerId="123e4567-e89b-42d3-a456-426614174000";
 const projectId="223e4567-e89b-42d3-a456-426614174000";
 const assetId="323e4567-e89b-42d3-a456-426614174000";
 assert.equal(buildCloudAssetObjectPath({ownerId,assetId,filename:"master.mp4"}),ownerId+"/"+assetId+"/master.mp4");
 assert.equal(buildCloudAssetObjectPath({ownerId,projectId,assetId,filename:"master.mp4"}),projectId+"/"+assetId+"/master.mp4");
 assert.throws(()=>buildCloudAssetObjectPath({ownerId:"invalid",assetId,filename:"x.mp4"}),/UUID/);
 assert.throws(()=>buildCloudAssetObjectPath({ownerId,assetId,filename:"../escape.mp4"}),/filename/);
});

test("streaming uploads only enable upsert when explicitly requested",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-storage-upsert-")),file=join(root,"render.mp4");await writeFile(file,Buffer.from("render"));
 const headers=[];
 const storage=createCloudStorage({...config,fetchImpl:async(url,options)=>{for await(const chunk of options.body){}headers.push(options.headers);return response({Key:"ok"});}});
 await storage.uploadFile(path,file,"video/mp4");
 await storage.uploadFile(path,file,"video/mp4",{upsert:true});
 assert.equal(headers[0]["x-upsert"],"false");
 assert.equal(headers[1]["x-upsert"],"true");
 await rm(root,{recursive:true,force:true});
});
