import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoPrivateAssetReader } from "../cloud-video-private-assets.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const collaboratorId="423e4567-e89b-42d3-a456-426614174000";
const projectId="223e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const bytes=Buffer.from([137,80,78,71,13,10,26,10,...Array(504).fill(7)]);

test("materializes a private personal asset, maps verified metadata and always cleans the temporary file",async()=>{
  const calls=[];
  const reader=createCloudVideoPrivateAssetReader({
    mediaIO:{async materialize(scope){calls.push(scope);return{
      asset:{id:assetId,ownerId,projectId:null,name:"frame.png",mediaType:"image/png",storageBucket:"executive-visuals-media"},
      path:"/private/frame",async cleanup(){calls.push("cleanup");}
    };}},
    readFileImpl:async path=>{assert.equal(path,"/private/frame");return bytes;}
  });
  const result=await reader({assetId,ownerId,projectId:null});
  assert.deepEqual(calls,[{ownerId,assetId},"cleanup"]);
  assert.equal(result.id,assetId);assert.equal(result.ownerId,ownerId);
  assert.equal(result.isPrivate,true);assert.equal(result.filename,"frame.png");
  assert.equal(result.contentType,"image/png");assert.deepEqual(result.bytes,bytes);
});

test("allows project-shared assets from another owner only inside the exact authorized project",async()=>{
  let cleaned=0;
  const reader=createCloudVideoPrivateAssetReader({
    mediaIO:{async materialize(){return{asset:{id:assetId,ownerId,projectId,name:"shared.webp",mediaType:"image/webp",storageBucket:"executive-visuals-media"},path:"/private/shared",async cleanup(){cleaned++;}};}},
    readFileImpl:async()=>bytes
  });
  const result=await reader({assetId,ownerId:collaboratorId,projectId});
  assert.equal(result.ownerId,ownerId);assert.equal(result.projectId,projectId);assert.equal(cleaned,1);
});

test("rejects cross-project and non-private bucket assets while cleaning temporary files",async()=>{
  for(const asset of [
    {id:assetId,ownerId,projectId:"523e4567-e89b-42d3-a456-426614174000",name:"frame.png",mediaType:"image/png",storageBucket:"executive-visuals-media"},
    {id:assetId,ownerId,projectId:null,name:"frame.png",mediaType:"image/png",storageBucket:"public-bucket"}
  ]){
    let cleaned=0;
    const reader=createCloudVideoPrivateAssetReader({
      mediaIO:{async materialize(){return{asset,path:"/private/frame",async cleanup(){cleaned++;}};}},
      readFileImpl:async()=>bytes
    });
    assert.equal(await reader({assetId,ownerId,projectId}),null);
    assert.equal(cleaned,1);
  }
});

test("cleans malformed materialization and rejects invalid bytes",async()=>{
  let cleaned=0;
  const malformed=createCloudVideoPrivateAssetReader({mediaIO:{async materialize(){return{path:"/private/x",async cleanup(){cleaned++;}};}}});
  await assert.rejects(malformed({assetId,ownerId}),/invalid materialization/);
  assert.equal(cleaned,1);
  const invalidBytes=createCloudVideoPrivateAssetReader({mediaIO:{async materialize(){return{asset:{id:assetId,ownerId,name:"frame.png",mediaType:"image/png",storageBucket:"executive-visuals-media"},path:"/private/x",async cleanup(){cleaned++;}};}},readFileImpl:async()=>"not bytes"});
  await assert.rejects(invalidBytes({assetId,ownerId}),/invalid private asset bytes/);
  assert.equal(cleaned,2);
});

test("requires a cloud media IO adapter",()=>{
  assert.throws(()=>createCloudVideoPrivateAssetReader({}),/requires cloud media IO/);
});