import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiFilesUploadService } from "../google-gemini-files-upload-service.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const projectId="123e4567-e89b-42d3-a456-426614174001";
const assetId="123e4567-e89b-42d3-a456-426614174002";
const receipt={uri:"https://generativelanguage.googleapis.com/v1beta/files/file_123456",providerFileName:"files/file_123456",mediaType:"video/mp4",expiresAt:"2026-11-07T08:00:00.000Z"};

test("prepares an authorized private asset and returns no Google URI or credential",async()=>{
 const calls={gateway:[],audit:[]};
 const service=createGoogleGeminiFilesUploadService({
  gateway:{resolveAsset:async args=>{calls.gateway.push(args);return receipt;}},
  getProjectAccess:(user,project)=>user===ownerId&&project===projectId?{role:"owner"}:null,
  canWriteProject:(user,project)=>user===ownerId&&project===projectId,
  audit:async(...args)=>calls.audit.push(args)
 });
 const result=await service.prepare({ownerId,projectId,assetId,mediaType:"video/mp4"});
 assert.deepEqual(calls.gateway,[{assetId,ownerId,projectId,mediaType:"video/mp4"}]);
 assert.deepEqual(result,{status:"active",assetId,mediaType:"video/mp4",expiresAt:receipt.expiresAt});
 assert.equal(JSON.stringify(result).includes("generativelanguage.googleapis.com"),false);
 assert.equal(JSON.stringify(result).includes("providerFileName"),false);
 assert.equal(calls.audit.length,1);
 assert.equal(calls.audit[0][1],"integration.google_gemini.file_prepared");
 assert.equal(calls.audit[0][2],"provider_file");
 assert.equal(calls.audit[0][5],projectId);
});

test("rejects project viewers before any provider upload",async()=>{
 let uploads=0;
 const service=createGoogleGeminiFilesUploadService({
  gateway:{resolveAsset:async()=>{uploads++;return receipt;}},
  getProjectAccess:()=>({role:"viewer"}),
  canWriteProject:()=>false,
  audit:async()=>{}
 });
 await assert.rejects(service.prepare({ownerId,projectId,assetId,mediaType:"video/mp4"}),error=>error.code==="EDITOR_REQUIRED"&&error.status===403);
 assert.equal(uploads,0);
});

test("rejects inaccessible projects and malformed request metadata",async()=>{
 let uploads=0;
 const service=createGoogleGeminiFilesUploadService({
  gateway:{resolveAsset:async()=>{uploads++;return receipt;}},
  getProjectAccess:()=>null,canWriteProject:()=>false,audit:async()=>{}
 });
 await assert.rejects(service.prepare({ownerId,projectId,assetId,mediaType:"video/mp4"}),error=>error.code==="PROJECT_NOT_FOUND");
 await assert.rejects(service.prepare({ownerId,projectId,assetId,mediaType:"text/html"}),error=>error.code==="GEMINI_FILE_REQUEST_INVALID");
 await assert.rejects(service.prepare({ownerId,assetId,mediaType:"video/mp4",projectId:"not-a-uuid"}),error=>error.code==="GEMINI_FILE_REQUEST_INVALID");
 assert.equal(uploads,0);
});

test("rejects an invalid provider receipt and never audits it as successful",async()=>{
 let audits=0;
 const service=createGoogleGeminiFilesUploadService({
  gateway:{resolveAsset:async()=>({uri:"https://example.com/file",mediaType:"video/mp4",expiresAt:"not-a-date"})},
  getProjectAccess:()=>({role:"owner"}),canWriteProject:()=>true,audit:async()=>{audits++;}
 });
 await assert.rejects(service.prepare({ownerId,projectId,assetId,mediaType:"video/mp4"}),error=>error.code==="GEMINI_FILE_RECEIPT_INVALID");
 assert.equal(audits,0);
});
