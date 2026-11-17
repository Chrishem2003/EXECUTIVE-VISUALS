import test from "node:test";
import assert from "node:assert/strict";
import { createB2MultipartUploadApi } from "../b2-multipart-upload-api.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const projectId="22222222-2222-4222-8222-222222222222";
const sha="a".repeat(64);
const etag1="a".repeat(32),etag2="b".repeat(32);

function fixture({authorize=async()=>true,existing=null,providerParts=null,verifyInitially=false,verifyError=null,verifyReceiptOverride=null,claim={claimed:true,reason:"claimed"},quota={remainingOwnerBytes:1_000_000_000,remainingTotalBytes:1_000_000_000},registrationError=null}={}){
 const calls={storage:[],ledger:[],assets:[]};
 let session=null,parts=[];
 const storage={
  async beginMultipartUpload(path,type){calls.storage.push(["begin",path,type]);return{uploadId:"upload_12345678"};},
  async remove(path){calls.storage.push(["remove",path]);return true;},
  async createMultipartPartSignedUrl(path,id,part,ttl){calls.storage.push(["signed",path,id,part,ttl]);return"https://b2.example/signed?part="+part;},
  async listMultipartParts(path,id){calls.storage.push(["list",path,id]);return{parts:providerParts||[{partNumber:1,etag:etag1,size:5_000_000},{partNumber:2,etag:etag2,size:1_000_000}],truncated:false};},
  async completeMultipartUpload(path,id,items){calls.storage.push(["complete",path,id,items]);return{bucket:"executive-visuals-media",path,parts:items.length};},
  async abortMultipartUpload(path,id){calls.storage.push(["abort",path,id]);return true;},
  async verifyObject(path,options){calls.storage.push(["verify",path,options]);if(verifyError)throw verifyError;if(verifyInitially){verifyInitially=false;throw Object.assign(new Error("not yet complete"),{code:"B2_STORAGE_HTTP_404",status:404});}return{bucket:"executive-visuals-media",path,size:options.expectedSize,sha256:options.expectedSha256,contentType:options.contentType,...(verifyReceiptOverride||{})};}
 };
 const store={
  async findByIdempotencyKey(){return existing;},
  async create(input){session={id:"33333333-3333-4333-8333-333333333333",...input,status:"active",expiresAt:new Date(Date.now()+86400000).toISOString(),partCount:Math.ceil(input.size/input.partSize),parts:[]};calls.ledger.push(["create",input]);return session;},
  async get(){return session?{...session,parts:[...parts]}:null;},
  async recordPart(input){const item={partNumber:input.partNumber,etag:input.etag,sha256:input.sha256,size:input.size};parts=parts.filter(p=>p.partNumber!==item.partNumber);parts.push(item);calls.ledger.push(["record",input]);return item;},
  async listParts(){return{session,parts:[...parts]};},
  async claimCompletion(){calls.ledger.push(["claim"]);return claim;},
  async markCompleted(){session={...session,status:"completed"};calls.ledger.push(["completed"]);return true;},
  async markAborted(){session={...session,status:"aborted"};calls.ledger.push(["aborted"]);return true;}
 };
 const assets={async getStorageUsage(){return quota;},async registerVerifiedObject(input){calls.assets.push(input);if(registrationError)throw registrationError;return{id:input.assetId,ownerId,projectId:input.projectId,name:input.originalName,size:input.size,sha256:input.sha256};}};
 const api=createB2MultipartUploadApi({storage,store,assets,authorize,maxBytes:100_000_000,partSize:5_000_000});
 return{api,calls,get session(){return session;},get parts(){return parts;}};
}
const startInput={ownerId,projectId,body:{projectId,originalName:"scene.mp4",mediaType:"video/mp4",size:6_000_000,sha256:sha},idempotencyKey:"upload-key-0001"};

test("starts an authorized B2 multipart session and keeps provider upload IDs private",async()=>{
 const f=fixture();
 const result=await f.api.start(startInput);
 assert.equal(result.status,201);
 assert.equal(result.body.session.projectId,projectId);
 assert.equal(result.body.session.size,6_000_000);
 assert.equal("uploadId" in result.body.session,false);
 assert.equal("objectPath" in result.body.session,false);
 assert.equal("ownerId" in result.body.session,false);
 assert.equal(f.calls.storage[0][0],"begin");
 assert.equal(f.calls.ledger[0][0],"create");
});

test("rejects initiation when owner or global private storage quota is insufficient",async()=>{
 const f=fixture({quota:{remainingOwnerBytes:5_000_000,remainingTotalBytes:1_000_000_000}});
 const result=await f.api.start(startInput);
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED");
 assert.equal(f.calls.storage.length,0);
});

test("refuses session creation when the project authorization check fails",async()=>{
 const f=fixture({authorize:async()=>false});
 const result=await f.api.start(startInput);
 assert.equal(result.status,403);
 assert.equal(f.calls.storage.length,0);
});

test("returns a scoped presigned URL and validates the exact part receipt size",async()=>{
 const f=fixture();
 await f.api.start(startInput);
 const url=await f.api.partUrl({ownerId,sessionId:f.session.id,partNumber:2});
 assert.equal(url.status,200);
 assert.equal(url.body.url,"https://b2.example/signed?part=2");
 assert.equal("uploadId" in url.body,false);
 const bad=await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:2,body:{etag:etag2,sha256:sha,size:5_000_000}});
 assert.equal(bad.status,400);
 const good=await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 assert.equal(good.status,200);
});

test("reconciles provider parts, verifies the completed object, and only then publishes the asset",async()=>{
 const f=fixture({verifyInitially:true});
 await f.api.start(startInput);
 const id=f.session.id;
 await f.api.recordPart({ownerId,sessionId:id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:id});
 assert.equal(result.status,200);
 assert.equal(result.body.asset.id,f.session.assetId);
 assert.equal(f.calls.storage.filter(x=>x[0]==="complete").length,1);
 assert.equal(f.calls.assets.length,1);
 assert.equal(f.calls.ledger.at(-1)[0],"completed");
});

test("removes a completed object when final Asset Library quota enforcement rejects publication",async()=>{
 const f=fixture({registrationError:Object.assign(new Error("quota exceeded"),{code:"CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED"})});
 await f.api.start(startInput);
 const id=f.session.id;
 await f.api.recordPart({ownerId,sessionId:id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:id});
 assert.equal(result.status,409);
 assert.equal(f.calls.storage.filter(x=>x[0]==="remove").length,1);
 assert.equal(f.calls.ledger.at(-1)[0],"aborted");
 assert.equal(f.calls.ledger.some(x=>x[0]==="completed"),false);
});

test("recovers an already completed provider object without completing the multipart upload twice",async()=>{
 const f=fixture({verifyInitially:false});
 await f.api.start(startInput);
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:f.session.id});
 assert.equal(result.status,200);
 assert.equal(f.calls.storage.filter(x=>x[0]==="complete").length,0);
 assert.equal(f.calls.storage.filter(x=>x[0]==="list").length,0);
 assert.equal(f.calls.assets.length,1);
 assert.equal(f.calls.ledger.at(-1)[0],"completed");
});

test("does not publish metadata when provider part reconciliation fails",async()=>{
 const f=fixture({verifyInitially:true,providerParts:[{partNumber:1,etag:"c".repeat(32),size:5_000_000},{partNumber:2,etag:etag2,size:1_000_000}]});
 await f.api.start(startInput);
 const id=f.session.id;
 await f.api.recordPart({ownerId,sessionId:id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:id});
 assert.equal(result.status,502);
 assert.equal(f.calls.assets.length,0);
 assert.equal(f.calls.storage.filter(x=>x[0]==="complete").length,0);
});


test("rejects a mismatched final object receipt before publishing any Asset Library metadata",async()=>{
 const f=fixture({verifyReceiptOverride:{bucket:"executive-visuals-media",path:"different/private/object.mp4",size:6_000_000,sha256:"b".repeat(64),contentType:"video/webm"}});
 await f.api.start(startInput);
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:f.session.id});
 assert.equal(result.status,502);
 assert.equal(result.body.error.code,"B2_MULTIPART_VERIFICATION_MISMATCH");
 assert.equal(f.calls.assets.length,0);
 assert.equal(f.calls.ledger.some(call=>call[0]==="completed"),false);
});

test("checks the final provider content type before Asset Library publication",async()=>{
 const f=fixture({verifyReceiptOverride:{contentType:"video/webm"}});
 await f.api.start(startInput);
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:f.session.id});
 assert.equal(result.body.error.code,"B2_MULTIPART_VERIFICATION_MISMATCH");
 assert.equal(f.calls.assets.length,0);
});


test("does not retry multipart completion when an existing object fails SHA-256 verification",async()=>{
 const f=fixture({verifyError:Object.assign(new Error("object SHA-256 mismatch"),{code:"B2_OBJECT_SHA256_MISMATCH"})});
 await f.api.start(startInput);
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:1,body:{etag:etag1,sha256:sha,size:5_000_000}});
 await f.api.recordPart({ownerId,sessionId:f.session.id,partNumber:2,body:{etag:etag2,sha256:sha,size:1_000_000}});
 const result=await f.api.complete({ownerId,sessionId:f.session.id});
 assert.equal(result.status,502);
 assert.equal(result.body.error.code,"B2_OBJECT_SHA256_MISMATCH");
 assert.equal(f.calls.storage.filter(call=>call[0]==="list").length,0);
 assert.equal(f.calls.storage.filter(call=>call[0]==="complete").length,0);
 assert.equal(f.calls.assets.length,0);
});

test("rejects unauthenticated and undersized multipart initiation",async()=>{
 const f=fixture();
 assert.equal((await f.api.start({...startInput,ownerId:"not-a-user"})).status,401);
 assert.equal((await f.api.start({...startInput,body:{...startInput.body,size:4_999_999}})).status,400);
 assert.equal(f.calls.storage.length,0);
});
