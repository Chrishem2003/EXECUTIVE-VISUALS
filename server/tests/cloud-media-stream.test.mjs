import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const assetId="723e4567-e89b-42d3-a456-426614174000";
const signedUrl="https://example.supabase.co/storage/v1/object/sign/executive-visuals-media/object?token=private";
const asset={id:assetId,ownerId:owner,projectId:"423e4567-e89b-42d3-a456-426614174000",name:"camera take.mp4",mediaType:"video/mp4",size:100,sha256:"a".repeat(64)};
function makeApi({fetchImpl=async()=>new Response("media",{status:200,headers:{"content-length":"5"}}),createSignedUrl=async()=>({asset,url:signedUrl})}={}){
 const calls=[];
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timeoutMs:5000,fetchImpl,timelineService:{assets:{async createSignedUrl(input){calls.push(["signed",input]);return createSignedUrl(input);}},timelines:{},projects:{}},authorize:async()=>true});
 return{api,calls};
}

test("private cloud media stream proxies a single byte range and preserves content-range",async()=>{
 let request;
 const body=Readable.toWeb(Readable.from([Buffer.from("0123456789")]));
 const f=makeApi({fetchImpl:async(url,options)=>{request={url,options};return new Response(body,{status:206,headers:{"content-length":"10","content-range":"bytes 10-19/100"}});}});
 const result=await f.api.streamAsset({ownerId:owner,assetId,range:"bytes=10-19"});
 assert.equal(result.status,206);
 assert.equal(result.headers["content-type"],"video/mp4");
 assert.equal(result.headers["content-range"],"bytes 10-19/100");
 assert.equal(result.headers["cache-control"],"private, no-store");
 assert.equal(request.options.headers.range,"bytes=10-19");
 assert.equal(request.options.redirect,"error");
 assert.equal(request.url,signedUrl);
 const chunks=[];for await(const chunk of Readable.fromWeb(result.body))chunks.push(chunk);
 assert.equal(Buffer.concat(chunks).toString(),"0123456789");
 result.cleanup();
});

test("private cloud media stream serves full content without exposing the signed URL",async()=>{
 const f=makeApi();
 const result=await f.api.streamAsset({ownerId:owner,assetId});
 assert.equal(result.status,200);
 assert.equal(result.headers["content-length"],"5");
 assert.equal(result.headers["accept-ranges"],"bytes");
 assert.equal(result.headers["content-disposition"],'inline; filename="camera take.mp4"');
 assert.equal(JSON.stringify(result).includes("token=private"),false);
 result.cleanup();
});

test("private cloud media stream rejects malformed and multiple byte ranges before signing",async()=>{
 const f=makeApi();
 const result=await f.api.streamAsset({ownerId:owner,assetId,range:"bytes=0-1,4-5"});
 assert.equal(result.status,400);
 assert.equal(result.body.toString().includes("INVALID_RANGE"),true);
 assert.equal(f.calls.length,0);
});

test("private cloud media stream hides assets denied by owner or project authorization",async()=>{
 const f=makeApi({createSignedUrl:async()=>{throw Object.assign(new Error("denied"),{code:"CLOUD_ASSET_ACCESS_DENIED"});}});
 const result=await f.api.streamAsset({ownerId:owner,assetId});
 assert.equal(result.status,404);
 assert.equal(result.body.toString().includes("ASSET_NOT_FOUND"),true);
});

test("private cloud media stream rejects signed URLs outside the configured Supabase origin",async()=>{
 const f=makeApi({createSignedUrl:async()=>({asset,url:"https://attacker.example/steal"})});
 await assert.rejects(()=>f.api.streamAsset({ownerId:owner,assetId}),/unsafe private-media URL/);
});

test("private cloud media stream rejects inconsistent upstream range metadata",async()=>{
 const body=Readable.toWeb(Readable.from([Buffer.from("bad")]));
 const f=makeApi({fetchImpl:async()=>new Response(body,{status:206,headers:{"content-length":"3","content-range":"bytes 10-12/99"}})});
 await assert.rejects(()=>f.api.streamAsset({ownerId:owner,assetId,range:"bytes=10-12"}),/invalid byte-range response/);
});

test("private cloud media stream forwards an upstream unsatisfied range response",async()=>{
 const f=makeApi({fetchImpl:async()=>new Response(null,{status:416,headers:{"content-range":"bytes */100"}})});
 const result=await f.api.streamAsset({ownerId:owner,assetId,range:"bytes=999-"});
 assert.equal(result.status,416);
 assert.equal(result.headers["content-range"],"bytes */100");
});

test("private cloud media stream supports HEAD without opening a response body",async()=>{
 const f=makeApi({fetchImpl:async(url,options)=>{assert.equal(options.method,"HEAD");return new Response(null,{status:200,headers:{"content-length":"100"}});}});
 const result=await f.api.streamAsset({ownerId:owner,assetId,method:"HEAD"});
 assert.equal(result.status,200);
 assert.equal(result.body,null);
});
