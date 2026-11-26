import test from "node:test";
import assert from "node:assert/strict";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const asset={id:assetId,ownerId,projectId:null,name:"private clip.mp4",mediaType:"video/mp4",size:8,sha256:"a".repeat(64)};
function api(createSignedUrl){
 return createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"test-service-role-key",
  fetchImpl:async()=>{throw new Error("unexpected database request");},
  timelineService:{assets:{createSignedUrl}},
  authorize:async()=>true,
  env:{}
 });
}
test("private download authorization returns the owner-scoped asset and signed URL",async()=>{
 const calls=[];
 const service=api(async input=>{calls.push(input);return{asset,url:"https://example.supabase.co/storage/v1/object/sign/private/opaque"};});
 const result=await service.getPrivateAssetDownload({ownerId,assetId,expiresIn:60});
 assert.deepEqual(calls,[{ownerId,assetId,expiresIn:60}]);
 assert.equal(result.asset.id,assetId);
 assert.equal(result.asset.ownerId,ownerId);
 assert.match(result.url,/^https:\/\//);
});
test("private download authorization rejects malformed caller identities before storage access",async()=>{
 let called=false;
 const service=api(async()=>{called=true;return{asset,url:"https://example.supabase.co/object"};});
 await assert.rejects(()=>service.getPrivateAssetDownload({ownerId:"not-a-uuid",assetId}),/verified owner and asset identity/);
 assert.equal(called,false);
});
test("private download authorization rejects mismatched asset receipts",async()=>{
 const service=api(async()=>({asset:{...asset,id:"423e4567-e89b-42d3-a456-426614174000"},url:"https://example.supabase.co/object"}));
 await assert.rejects(()=>service.getPrivateAssetDownload({ownerId,assetId}),/invalid metadata/);
});
test("private download authorization rejects non-HTTPS storage URLs",async()=>{
 const service=api(async()=>({asset,url:"http://example.supabase.co/object"}));
 await assert.rejects(()=>service.getPrivateAssetDownload({ownerId,assetId}),/invalid metadata/);
});
