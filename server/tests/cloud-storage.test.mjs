import test from "node:test";
import assert from "node:assert/strict";
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
