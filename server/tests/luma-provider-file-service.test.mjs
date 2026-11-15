import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLumaProviderFileService } from "../luma-provider-file-service.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const projectId="223e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const fileId="423e4567-e89b-42d3-a456-426614174000";
const bytes=new Uint8Array([1,2,3,4]);
const sha256=createHash("sha256").update(bytes).digest("hex");
const asset={id:assetId,ownerId,projectId,name:"source.mp4",mediaType:"video/mp4",size:bytes.byteLength,sha256};

function fixture({attemptState="PREPARED",remoteState="ready",assetOwner=ownerId,authorized=true,checksum=sha256}={}){
 const calls={create:0,upload:0,complete:0,get:0,delete:0};
 const state={attempt:{id:"523e4567-e89b-42d3-a456-426614174000",attempt_key:"a".repeat(64),asset_id:assetId,owner_id:ownerId,project_id:projectId,purpose:"input",mime_type:"video/mp4",byte_size:4,sha256,state:attemptState,provider_file_id:attemptState==="PREPARED"?null:fileId,upload_expires_at:"2026-11-16T12:00:00.000Z",upload_completed_at:null,last_error_code:null},file:null};
 const assets={
  async get({ownerId:requested,assetId:requestedAsset}){return authorized&&requested===ownerId&&requestedAsset===assetId?{...asset,ownerId:assetOwner,sha256:checksum}:null;},
  async createSignedUrl({ownerId:requested,assetId:requestedAsset}){return{asset:{id:requestedAsset,ownerId:assetOwner,projectId},url:"https://storage.example/storage/v1/object/sign/private/source.mp4?token=opaque"};}
 };
 const repository={
  async getFileByAsset(){return state.file;},
  async createAttempt(){return {...state.attempt};},
  async updateAttempt({id,fromStates,state:next,patch={}}){
   if(state.attempt.id!==id||!fromStates.includes(state.attempt.state))throw Object.assign(new Error("conflict"),{code:"LUMA_FILE_ATTEMPT_CONFLICT"});
   Object.assign(state.attempt,patch,{state:next});return {...state.attempt};
  },
  async upsertFile(record){state.file={...record,provider_file_id:record.providerFileId,state:record.state};return state.file;}
 };
 const adapter={
  async createFileUpload(args){calls.create++;assert.equal(args.userId,ownerId);assert.equal(args.sizeBytes,4);return{fileId,upload:{method:"PUT",url:"https://bucket.s3.amazonaws.com/object",headers:{},expiresAt:"2026-11-16T12:00:00.000Z"}};},
  async uploadFileBytes(args){calls.upload++;assert.equal(args.bytes.byteLength,4);return{uploadedBytes:4};},
  async completeFileUpload(){calls.complete++;return{fileId,state:"pending"};},
  async getFile(){calls.get++;return{fileId,state:remoteState,mimeType:"video/mp4",sizeBytes:4,failureReason:null};},
  async deleteFile(){calls.delete++;return{fileId,deleted:true};}
 };
 const fetchImpl=async()=>({ok:true,status:200,headers:{get:name=>name==="content-length"?String(bytes.byteLength):"video/mp4"},body:{getReader(){let sent=false;return{async read(){if(sent)return{done:true};sent=true;return{done:false,value:bytes};},async cancel(){},releaseLock(){}};}}});
 const service=createLumaProviderFileService({assets,adapter,repository,fetchImpl,supabaseUrl:"https://storage.example",now:()=>Date.parse("2026-11-15T12:00:00.000Z")});
 return{service,calls,state,adapter,repository,assets};
}

test("Luma source asset upload persists owner-scoped mapping only after provider reports ready",async()=>{
 const f=fixture();
 const result=await f.service.prepareAsset({ownerId,projectId,assetId,purpose:"input"});
 assert.deepEqual(result,{fileId,state:"ready",assetId,purpose:"input"});
 assert.deepEqual(f.calls,{create:1,upload:1,complete:1,get:1,delete:0});
 assert.equal(f.state.file.state,"READY");
 assert.equal(f.state.file.ownerId,ownerId);
 assert.equal(f.state.attempt.state,"COMPLETED");
});

test("pending Luma ingestion stays recoverable and does not mark upload failed",async()=>{
 const f=fixture({remoteState:"pending"});
 await assert.rejects(f.service.prepareAsset({ownerId,projectId,assetId}),error=>error.code==="VIDEO_PROVIDER_POLL_DEFERRED"&&error.retryable===true);
 assert.equal(f.state.attempt.state,"PROVIDER_CREATED");
 assert.equal(f.state.attempt.upload_completed_at!==null,true);
 assert.equal(f.state.file,null);
});

test("recovery polls a persisted provider file instead of creating a duplicate",async()=>{
 const f=fixture({attemptState:"PROVIDER_CREATED"});
 const result=await f.service.prepareAsset({ownerId,projectId,assetId});
 assert.equal(result.fileId,fileId);
 assert.equal(f.calls.create,0);
 assert.equal(f.calls.upload,0);
 assert.equal(f.state.attempt.state,"COMPLETED");
});

test("unknown interrupted upload is quarantined rather than duplicated",async()=>{
 const f=fixture({attemptState:"UPLOADING"});
 await assert.rejects(f.service.prepareAsset({ownerId,projectId,assetId}),error=>error.code==="LUMA_FILE_RECOVERY_QUARANTINED");
 assert.equal(f.state.attempt.state,"QUARANTINED");
 assert.equal(f.calls.create,0);
});

test("private source ownership and project scope are checked before provider upload",async()=>{
 const f=fixture({authorized:false});
 await assert.rejects(f.service.prepareAsset({ownerId,projectId,assetId}),error=>error.code==="LUMA_FILE_ASSET_NOT_FOUND");
 assert.equal(f.calls.create,0);
});

test("private source checksum is verified before provider upload",async()=>{
 const f=fixture({checksum:"0".repeat(64)});
 await assert.rejects(f.service.prepareAsset({ownerId,projectId,assetId}),error=>error.code==="LUMA_FILE_ASSET_CHECKSUM_MISMATCH");
 assert.equal(f.calls.create,0);
});

test("generation input resolver replaces internal asset IDs with owner-scoped Luma file IDs",async()=>{
 const f=fixture();
 const resolved=await f.service.resolveInput({provider:"luma",model:"ray-3.2",prompt:"animate",startFrameAssetId:assetId},{job:{owner_id:ownerId,project_id:projectId}});
 assert.deepEqual(resolved.startFrame,{file_id:fileId});
 assert.equal(resolved.startFrameAssetId,assetId);
});

test("generation input resolver rejects caller-supplied provider file IDs",async()=>{
 const f=fixture();
 await assert.rejects(f.service.resolveInput({provider:"luma",model:"ray-3.2",prompt:"edit",sourceVideo:{file_id:fileId}},{job:{owner_id:ownerId,project_id:projectId}}),error=>error.code==="LUMA_FILE_UNSCOPED_REFERENCE");
});

test("generation input resolver maps multiple private keyframe assets and preserves frame indexes",async()=>{
 const f=fixture();
 const resolved=await f.service.resolveInput({
  provider:"luma",model:"ray-3.2",prompt:"animate",
  keyframeAssetIds:[assetId],keyframeIndexes:[0]
 },{job:{owner_id:ownerId,project_id:projectId}});
 assert.deepEqual(resolved.keyframes,[{file_id:fileId}]);
 assert.deepEqual(resolved.keyframeIndexes,[0]);
});

test("invalid or unordered Luma keyframe indexes are rejected before any provider upload",async()=>{
 const f=fixture();
 await assert.rejects(f.service.resolveInput({
  provider:"luma",model:"ray-3.2",prompt:"animate",durationSeconds:5,
  keyframeAssetIds:[assetId,"623e4567-e89b-42d3-a456-426614174000"],keyframeIndexes:[24,0]
 },{job:{owner_id:ownerId,project_id:projectId}}),error=>error.code==="LUMA_FILE_INPUT_INVALID");
 assert.equal(f.calls.create,0);
 await assert.rejects(f.service.resolveInput({
  provider:"luma",model:"ray-3.2",prompt:"animate",keyframeAssetIds:[assetId]
 },{job:{owner_id:ownerId,project_id:projectId}}),error=>error.code==="LUMA_FILE_INPUT_INVALID");
 assert.equal(f.calls.create,0);
});
test("Luma keyframe mode rejects mixed source-video operations before provider uploads",async()=>{
 const f=fixture();
 await assert.rejects(f.service.resolveInput({
  provider:"luma",model:"ray-3.2",operation:"video_edit",prompt:"edit",
  sourceVideoAssetId:assetId,durationSeconds:5,
  keyframeAssetIds:[assetId],keyframeIndexes:[0]
 },{job:{owner_id:ownerId,project_id:projectId}}),error=>error.code==="LUMA_FILE_INPUT_INVALID");
 assert.equal(f.calls.create,0);
});
test("generation input resolver rejects unsupported generic reference asset lists",async()=>{
 const f=fixture();
 await assert.rejects(f.service.resolveInput({
  provider:"luma",model:"ray-3.2",prompt:"animate",referenceAssetIds:[assetId]
 },{job:{owner_id:ownerId,project_id:projectId}}),error=>error.code==="LUMA_FILE_REFERENCE_MODE_UNSUPPORTED");
});

test("project collaborators can prepare an asset owned by another project member after scoped authorization",async()=>{
 const f=fixture({assetOwner:"923e4567-e89b-42d3-a456-426614174000"});
 const result=await f.service.prepareAsset({ownerId,projectId,assetId});
 assert.equal(result.fileId,fileId);
 assert.equal(f.state.file.ownerId,ownerId);
});

test("private source downloads reject signed URLs outside the configured storage origin",async()=>{
 const f=fixture();
 f.assets.createSignedUrl=async()=>({asset:{id:assetId,ownerId,projectId},url:"https://attacker.example/storage/v1/object/sign/private.mp4?token=x"});
 await assert.rejects(f.service.prepareAsset({ownerId,projectId,assetId}),error=>error.code==="LUMA_FILE_SIGNED_URL_INVALID");
 assert.equal(f.calls.create,0);
});

test("private source downloads require matching content type and bounded streaming body",async()=>{
 const f=fixture();
 const service=createLumaProviderFileService({
  assets:f.assets,adapter:f.adapter,repository:f.repository,supabaseUrl:"https://storage.example",
  fetchImpl:async()=>({ok:true,status:200,headers:{get:name=>name==="content-length"?"4":"image/png"},body:{getReader(){return{async read(){return{done:true};},async cancel(){},releaseLock(){}};}}}),
  now:()=>Date.parse("2026-11-15T12:00:00.000Z")
 });
 await assert.rejects(service.prepareAsset({ownerId,projectId,assetId}),error=>error.code==="LUMA_FILE_ASSET_CHECKSUM_MISMATCH");
 assert.equal(f.calls.create,0);
});
