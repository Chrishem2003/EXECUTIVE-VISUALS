import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsMirrorUploadService } from "../google-gemini-gcs-mirror-upload-service.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const assetId="22222222-2222-4222-8222-222222222222";
const projectId="33333333-3333-4333-8333-333333333333";

test("GCS mirror upload enforces authenticated owner and project editor access",async()=>{
 const calls=[],audits=[];
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(args){calls.push(args);return{generation:"1740000000000000",reused:false,gcsUri:"gs://private/object"};}},
  getProjectAccess:()=>({access_role:"viewer"}),canWriteProject:()=>false,
  audit:async(...args)=>audits.push(args)
 });
 await assert.rejects(service.mirror({ownerId,assetId,projectId}),/Owner or editor access/);
 assert.equal(calls.length,0);
 assert.equal(audits.length,0);
});

test("GCS mirror upload accepts editor access and returns no private GCS URI",async()=>{
 const calls=[],audits=[];
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(args){calls.push(args);return{generation:"1740000000000000",reused:true,gcsUri:"gs://private/object"};}},
  getProjectAccess:()=>({access_role:"editor"}),canWriteProject:()=>true,
  audit:async(...args)=>audits.push(args)
 });
 const result=await service.mirror({ownerId,assetId,projectId});
 assert.deepEqual(calls,[{ownerId,assetId,projectId}]);
 assert.equal(result.status,"mirrored");
 assert.equal(result.reused,true);
 assert.equal("gcsUri" in result,false);
 assert.equal(audits.length,1);
 assert.equal(audits[0][1],"integration.google_gcs.asset_mirrored");
});

test("GCS mirror upload supports owner-scoped personal assets",async()=>{
 const calls=[];
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(args){calls.push(args);return{generation:"1740000000000000",reused:false};}},
  getProjectAccess:()=>{throw new Error("must not query project access");},
  canWriteProject:()=>{throw new Error("must not query project access");},
  audit:async()=>{}
 });
 await service.mirror({ownerId,assetId});
 assert.deepEqual(calls,[{ownerId,assetId,projectId:null}]);
});

test("GCS mirror upload rejects malformed scopes and incomplete receipts",async()=>{
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(){return{reused:false};}},
  getProjectAccess:()=>({access_role:"owner"}),canWriteProject:()=>true,audit:async()=>{}
 });
 await assert.rejects(service.mirror({ownerId:"not-a-user",assetId}),/Authenticated owner/);
 await assert.rejects(service.mirror({ownerId,assetId}),/verified generation receipt/);
});

test("Gemini GCS registration mirrors first, enforces editor access and returns provider receipt",async()=>{
 const calls=[],audits=[];
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(args){calls.push(["mirror",args]);return{generation:"1740000000000000",reused:false};}},
  geminiFiles:{async registerAsset(args){calls.push(["register",args]);return{uri:"https://generativelanguage.googleapis.com/v1beta/files/file_123",providerFileName:"files/file_123",expiresAt:"2026-11-20T00:00:00.000Z",reused:false};}},
  getProjectAccess:()=>({access_role:"editor"}),canWriteProject:()=>true,audit:async(...args)=>audits.push(args)
 });
 const result=await service.registerWithGemini({ownerId,assetId,projectId,mediaType:"video/mp4"});
 assert.equal(calls.length,2);
 assert.equal(calls[0][0],"mirror");
 assert.equal(calls[1][0],"register");
 assert.equal(result.status,"registered");
 assert.equal(result.providerFileName,"files/file_123");
 assert.equal(audits[0][1],"integration.google_gcs.gemini_file_registered");
});

test("Gemini GCS registration cannot bypass project authorization or use caller GCS URIs",async()=>{
 const calls=[];
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(args){calls.push(args);return{generation:"1740000000000000"};}},
  geminiFiles:{async registerAsset(){throw new Error("must not register");}},
  getProjectAccess:()=>({access_role:"viewer"}),canWriteProject:()=>false,audit:async()=>{}
 });
 await assert.rejects(service.registerWithGemini({ownerId,assetId,projectId,mediaType:"video/mp4"}),/Owner or editor access/);
 await assert.rejects(service.registerWithGemini({ownerId,assetId,projectId,mediaType:"text/plain",gcsUri:"gs://attacker-bucket/object"}),/Owner or editor access/);
 assert.equal(calls.length,0);
});

test("Gemini GCS registration rejects unsupported media and malformed provider receipts",async()=>{
 const service=createGoogleGeminiGcsMirrorUploadService({
  mirrorService:{async mirrorAsset(){return{generation:"1740000000000000"};}},
  geminiFiles:{async registerAsset(){return{uri:"not-a-google-uri",providerFileName:"files/file_123",expiresAt:"bad-date"};}},
  getProjectAccess:()=>({access_role:"owner"}),canWriteProject:()=>true,audit:async()=>{}
 });
 await assert.rejects(service.registerWithGemini({ownerId,assetId,mediaType:"application/x-executable"}),/supported media type/);
 await assert.rejects(service.registerWithGemini({ownerId,assetId,mediaType:"video/mp4"}),/valid active provider-file receipt/);
});
