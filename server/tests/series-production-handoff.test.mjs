import test from "node:test";
import assert from "node:assert/strict";
import { matchGeneratedStoryboardAssets } from "../../src/core/series-production.ts";

const approvalId="223e4567-e89b-42d3-a456-426614174000";
const projectId="123e4567-e89b-42d3-a456-426614174000";
const assetIds=[
 "323e4567-e89b-42d3-a456-426614174000",
 "423e4567-e89b-42d3-a456-426614174000"
];
const hash="a".repeat(64);
const shots=[{id:"shot-1"},{id:"shot-2"}];
function asset(shotIndex,id=assetIds[shotIndex],overrides={}){
 return {
  id,projectId,mediaType:"video/mp4",sha256:hash,
  metadata:{operation:"video.generate",approvalId,shotIndex,provider:"runway",model:"gen4.5",providerTaskId:"provider-task-"+shotIndex,approvedRequestHash:hash},
  ...overrides
 };
}

test("matches generated outputs in approved shot order only when complete provenance is present",()=>{
 const result=matchGeneratedStoryboardAssets(shots,[asset(1),asset(0)],approvalId,projectId);
 assert.deepEqual(result.map(item=>item.shotIndex),[0,1]);
 assert.deepEqual(result.map(item=>item.asset.id),assetIds);
});

test("rejects generated storyboard assets without a verified checksum",()=>{
 assert.throws(()=>matchGeneratedStoryboardAssets(shots,[asset(0,assetIds[0],{sha256:null}),asset(1)],approvalId,projectId),/SHA-256 checksum/);
});

test("rejects generated storyboard assets with incomplete provider execution lineage",()=>{
 assert.throws(()=>matchGeneratedStoryboardAssets(shots,[asset(0,assetIds[0],{metadata:{...asset(0).metadata,providerTaskId:""}}),asset(1)],approvalId,projectId),/provider execution lineage/);
});

test("rejects string-coerced shot indexes rather than guessing the approved shot",()=>{
 assert.throws(()=>matchGeneratedStoryboardAssets(shots,[asset(0,assetIds[0],{metadata:{...asset(0).metadata,shotIndex:"0"}}),asset(1)],approvalId,projectId),/invalid shot index/);
});

test("rejects generated assets from another project and duplicate outputs for one shot",()=>{
 assert.throws(()=>matchGeneratedStoryboardAssets(shots,[asset(0),asset(1,assetIds[1],{projectId:"different-project"})],approvalId,projectId),/different cloud project/);
 assert.throws(()=>matchGeneratedStoryboardAssets(shots,[asset(0),asset(0,"523e4567-e89b-42d3-a456-426614174000"),asset(1)],approvalId,projectId),/More than one generated asset/);
});
