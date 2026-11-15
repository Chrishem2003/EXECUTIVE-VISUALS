import test from "node:test";
import assert from "node:assert/strict";
import { createLumaProviderFileRepository } from "../luma-provider-file-repository.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const projectId="223e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const attemptId="423e4567-e89b-42d3-a456-426614174000";
const providerFileId="523e4567-e89b-42d3-a456-426614174000";
const sha256="a".repeat(64);
const identity={assetId,ownerId,projectId,purpose:"input",mimeType:"video/mp4",byteSize:4,sha256};
function response(body,status=200){return{ok:status>=200&&status<300,status,async text(){return body===null?"":JSON.stringify(body);}};}
function fixture(handler){
 const calls=[];
 const repository=createLumaProviderFileRepository({url:"https://example.supabase.co",serviceRoleKey:"secret",fetchImpl:async(url,init)=>{calls.push({url,init});return handler(url,init,calls);}});
 return{repository,calls};
}

test("Luma repository creates an immutable identity-bound upload attempt",async()=>{
 const {repository,calls}=fixture((url,init)=>response([{id:attemptId,asset_id:assetId,owner_id:ownerId,project_id:projectId,purpose:"input",mime_type:"video/mp4",byte_size:4,sha256,attempt_key:"b".repeat(64),state:"PREPARED",attempt_count:1}]));
 const row=await repository.createAttempt({...identity,attemptKey:"b".repeat(64),filename:"source.mp4"});
 assert.equal(row.id,attemptId);
 assert.equal(calls[0].init.method,"POST");
 assert.equal(calls[0].init.headers["content-profile"],"executive_visuals");
 const payload=JSON.parse(calls[0].init.body);
 assert.equal(payload.owner_id,ownerId);
 assert.equal(payload.asset_id,assetId);
 assert.equal(payload.state,"PREPARED");
});

test("Luma repository resolves idempotent insert conflicts and rejects identity substitution",async()=>{
 const {repository,calls}=fixture((url,init)=>{
  if(init.method==="POST")return response({message:"duplicate key"},409);
  return response([{id:attemptId,asset_id:assetId,owner_id:ownerId,project_id:projectId,purpose:"input",mime_type:"video/mp4",byte_size:4,sha256,attempt_key:"b".repeat(64),state:"PREPARED",attempt_count:1}]);
 });
 const row=await repository.createAttempt({...identity,attemptKey:"b".repeat(64),filename:"source.mp4"});
 assert.equal(row.id,attemptId);
 assert.equal(calls.length,2);
 const bad=fixture((url,init)=>{
  if(init.method==="POST")return response({message:"duplicate key"},409);
  return response([{id:attemptId,asset_id:assetId,owner_id:"923e4567-e89b-42d3-a456-426614174000",project_id:projectId,purpose:"input",mime_type:"video/mp4",byte_size:4,sha256,attempt_key:"b".repeat(64),state:"PREPARED"}]);
 });
 await assert.rejects(bad.repository.createAttempt({...identity,attemptKey:"b".repeat(64),filename:"source.mp4"}),error=>error.code==="LUMA_FILE_ATTEMPT_CONFLICT");
});

test("Luma repository performs compare-and-swap state transitions",async()=>{
 const {repository,calls}=fixture((url,init)=>response([{id:attemptId,...identity,state:"PROVIDER_CREATED",provider_file_id:providerFileId}]));
 const row=await repository.updateAttempt({id:attemptId,fromStates:["UPLOADING"],state:"PROVIDER_CREATED",patch:{provider_file_id:providerFileId}});
 assert.equal(row.state,"PROVIDER_CREATED");
 assert.match(calls[0].url,/state=in\.\(UPLOADING\)/);
 assert.equal(JSON.parse(calls[0].init.body).provider_file_id,providerFileId);
});

test("Luma repository refuses to overwrite a concurrently advanced attempt",async()=>{
 const {repository}=fixture((url,init)=>{
  if(init.method==="PATCH")return response([]);
  return response([{id:attemptId,state:"COMPLETED"}]);
 });
 await assert.rejects(repository.updateAttempt({id:attemptId,fromStates:["UPLOADING"],state:"FAILED"}),error=>error.code==="LUMA_FILE_ATTEMPT_CONFLICT");
});

test("Luma repository upserts and verifies the exact owner, asset and provider file mapping",async()=>{
 const {repository,calls}=fixture((url,init)=>response([{id:attemptId,provider:"luma-ray32",provider_file_id:providerFileId,asset_id:assetId,owner_id:ownerId,project_id:projectId,purpose:"input",sha256,state:"READY"}]));
 const row=await repository.upsertFile({...identity,providerFileId,state:"READY"});
 assert.equal(row.provider_file_id,providerFileId);
 assert.match(calls[0].url,/on_conflict=provider,asset_id,owner_id,purpose/);
 assert.equal(JSON.parse(calls[0].init.body).provider,"luma-ray32");
});

test("Luma repository lists only bounded recoverable upload attempts",async()=>{
 const {repository,calls}=fixture(()=>response([]));
 await repository.listRecoverable({limit:1000});
 assert.match(calls[0].url,/state=in\.\(UPLOADING,OUTCOME_UNKNOWN,PROVIDER_CREATED\)/);
 assert.match(calls[0].url,/limit=100/);
});

test("Luma repository rejects invalid identifiers and unsafe state patches",async()=>{
 const {repository,calls}=fixture(()=>response([]));
 await assert.rejects(repository.createAttempt({...identity,ownerId:"not-a-uuid",attemptKey:"b".repeat(64),filename:"x"}),error=>error.code==="LUMA_FILE_IDENTITY_INVALID");
 await assert.rejects(repository.updateAttempt({id:attemptId,fromStates:["UPLOADING"],state:"FAILED",patch:{owner_id:ownerId}}),error=>error.code==="LUMA_FILE_ATTEMPT_PATCH_INVALID");
 assert.equal(calls.length,0);
});
