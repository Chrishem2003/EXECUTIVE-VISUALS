import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMediaBatchRequest } from "../media-batch.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="223e4567-e89b-42d3-a456-426614174000";
const videoA="323e4567-e89b-42d3-a456-426614174000";
const videoB="423e4567-e89b-42d3-a456-426614174000";
function fixture({canWrite=true,assets={}}={}){
 const records={
  [videoA]:{id:videoA,owner_id:owner,project_id:project,media_type:"video/mp4"},
  [videoB]:{id:videoB,owner_id:owner,project_id:project,media_type:"video/webm"},
  ...assets
 };
 return {getAsset:id=>records[id]||null,canWriteProject:(actor,id)=>actor===owner&&id===project&&canWrite};
}
const items=[{sourceAssetId:videoA},{sourceAssetId:videoB}];

test("normalizes a project-scoped color-correction batch with safe defaults",()=>{
 const f=fixture();
 const result=normalizeMediaBatchRequest({ownerId:owner,projectId:project,jobType:"media.color",items,...f});
 assert.equal(result.projectId,project);
 assert.equal(result.items.length,2);
 assert.deepEqual(result.items[0].options,{brightness:0,contrast:1,saturation:1});
 assert.deepEqual(result.items[1].options,{brightness:0,contrast:1,saturation:1});
});

test("supports bounded denoise, resize, interpolation, proxy and audio extraction batches",()=>{
 const f=fixture();
 assert.equal(normalizeMediaBatchRequest({ownerId:owner,jobType:"media.denoise",options:{luma:6,chroma:4},items,...f}).items[0].options.luma,6);
 assert.equal(normalizeMediaBatchRequest({ownerId:owner,jobType:"media.resize",options:{width:1280,height:720,fit:"cover"},items,...f}).items[0].options.fit,"cover");
 assert.equal(normalizeMediaBatchRequest({ownerId:owner,jobType:"media.interpolate",options:{fps:48},items,...f}).items[0].options.fps,48);
 assert.equal(normalizeMediaBatchRequest({ownerId:owner,jobType:"media.proxy",options:{proxyWidth:720,proxyCrf:30},items,...f}).items[0].options.proxyWidth,720);
 assert.deepEqual(normalizeMediaBatchRequest({ownerId:owner,jobType:"media.audio_extract",items,...f}).items[0].options,{});
});

test("rejects batches outside the 1 to 50 item bound and duplicate source assets",()=>{
 const f=fixture();
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.color",items:[],...f}),error=>error.code==="INVALID_MEDIA_BATCH_SIZE");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.color",items:Array.from({length:51},(_,i)=>({sourceAssetId:"video-"+i})),...f}),error=>error.code==="INVALID_MEDIA_BATCH_SIZE");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.color",items:[items[0],items[0]],...f}),error=>error.code==="INVALID_MEDIA_BATCH_ITEM");
});

test("rejects unsupported operations, unknown options and out-of-range FFmpeg values",()=>{
 const f=fixture();
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.ai-upscale",items,...f}),error=>error.code==="MEDIA_BATCH_OPERATION_UNSUPPORTED");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.color",options:{brightness:0,ownerId:owner},items,...f}),error=>error.code==="MEDIA_BATCH_OPTION_UNSUPPORTED");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.color",options:{contrast:4},items,...f}),error=>error.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.resize",options:{width:100,height:720},items,...f}),error=>error.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.proxy",options:{proxyWidth:100,proxyCrf:28},items,...f}),error=>error.code==="INVALID_MEDIA_OPTIONS");
});

test("enforces project write permission and rejects mixed-project or non-video sources",()=>{
 const denied=fixture({canWrite:false});
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,projectId:project,jobType:"media.color",items,...denied}),error=>error.code==="PROJECT_NOT_FOUND");
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,jobType:"media.color",items,...denied}),error=>error.code==="PROJECT_NOT_FOUND");
 const otherProject="523e4567-e89b-42d3-a456-426614174000";
 const mixed=fixture({assets:{[videoB]:{id:videoB,project_id:otherProject,media_type:"video/mp4"}}});
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,projectId:project,jobType:"media.color",items,...mixed}),error=>error.code==="PROJECT_MISMATCH");
 const image=fixture({assets:{[videoA]:{id:videoA,project_id:project,media_type:"image/png"}}});
 assert.throws(()=>normalizeMediaBatchRequest({ownerId:owner,projectId:project,jobType:"media.color",items:[items[0]],...image}),error=>error.code==="UNSUPPORTED_MEDIA_TYPE");
});
