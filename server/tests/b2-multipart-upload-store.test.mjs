import test from "node:test";
import assert from "node:assert/strict";
import { createB2MultipartUploadStore } from "../b2-multipart-upload-store.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="223e4567-e89b-42d3-a456-426614174000";
const asset="323e4567-e89b-42d3-a456-426614174000";
const sessionId="423e4567-e89b-42d3-a456-426614174000";
const uploadId="upload_12345678";
const objectPath=project+"/"+asset+"/original.mp4";
const sha256="a".repeat(64);
const etag1="b".repeat(32),etag2="c".repeat(32);
const now=()=>new Date("2026-11-17T12:00:00.000Z");

function setup(){
 const sessions=[],parts=[],calls=[];
 let instant=new Date("2026-11-17T12:00:00.000Z");
 const fetchImpl=async(url,options={})=>{
  const parsed=new URL(url),table=parsed.pathname.split("/").pop(),params=parsed.searchParams,method=options.method||"GET";
  calls.push({url,method,body:options.body?JSON.parse(options.body):null,headers:options.headers});
  const rows=table==="asset_multipart_upload_sessions"?sessions:table==="asset_multipart_upload_parts"?parts:null;
  if(!rows)return{ok:false,status:404,async text(){return"{}";}};
  const matches=row=>[...params.entries()].every(([key,filter])=>{
   const [op,...rest]=filter.split("."),value=rest.join(".");
   if(op==="eq")return String(row[key]??"")===value;
   if(op==="in")return value.slice(1,-1).split(",").includes(String(row[key]??""));
   return true;
  });
  if(method==="POST"){
   const body=JSON.parse(options.body),conflict=rows.find(row=>table==="asset_multipart_upload_sessions"?row.owner_id===body.owner_id&&row.idempotency_key===body.idempotency_key:row.session_id===body.session_id&&row.part_number===body.part_number);
   if(conflict){const prefer=options.headers.prefer||"";return{ok:true,status:200,async text(){return prefer.includes("return=representation")?"[]":"";}};}
   const row={id:table==="asset_multipart_upload_sessions"?sessionId:undefined,...body,created_at:now().toISOString(),updated_at:now().toISOString()};
   rows.push(row);return{ok:true,status:201,async text(){return JSON.stringify([row]);}};
  }
  if(method==="GET"){
   let result=rows.filter(matches);
   if(params.get("order")==="part_number.asc")result=result.sort((a,b)=>a.part_number-b.part_number);
   if(params.has("limit"))result=result.slice(0,Number(params.get("limit")));
   return{ok:true,status:200,async text(){return JSON.stringify(result);}};
  }
  if(method==="PATCH"){
   const body=JSON.parse(options.body),changed=[];
   for(const row of rows.filter(matches)){Object.assign(row,body);changed.push(row);}
   return{ok:true,status:200,async text(){return JSON.stringify(changed);}};
  }
  return{ok:false,status:405,async text(){return"{}";}};
 };
 return{store:createB2MultipartUploadStore({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,clock:()=>new Date(instant)}),sessions,parts,calls,advance:ms=>{instant=new Date(instant.getTime()+ms);}};
}
function createInput(overrides={}){return{ownerId:owner,projectId:project,assetId:asset,idempotencyKey:"upload-job-123",objectPath,uploadId,originalName:"master.mp4",mediaType:"video/mp4",size:10_000_000,sha256,partSize:5_000_000,expiresAt:"2026-11-18T12:00:00.000Z",...overrides};}

test("persists a tenant-scoped upload session and returns the same session on idempotent retry",async()=>{
 const {store,sessions,calls}=setup();
 const first=await store.create(createInput()),second=await store.create(createInput());
 assert.equal(first.id,sessionId);assert.equal(second.id,sessionId);assert.equal(sessions.length,1);
 assert.equal(first.status,"active");assert.equal(first.provider,"backblaze-b2");assert.equal(first.partCount,2);
 assert.ok(calls.every(call=>call.headers["accept-profile"]==="executive_visuals"));
});

test("rejects reuse of an idempotency key for a different source, name, media type or storage target",async()=>{
 const {store}=setup();await store.create(createInput());
 for(const overrides of [
  {sha256:"d".repeat(64)},
  {originalName:"different.mp4"},
  {mediaType:"video/webm"},
  {objectPath:project+"/"+asset+"/different.mp4"}
 ])await assert.rejects(()=>store.create(createInput(overrides)),{code:"B2_MULTIPART_IDEMPOTENCY_CONFLICT"});
});
test("binds the object path to the authenticated owner or project and reserved asset ID",async()=>{
 const {store}=setup();
 await assert.rejects(()=>store.create(createInput({objectPath:owner+"/"+asset+"/original.mp4"})),/bound to the verified owner\/project/);
 await assert.rejects(()=>store.create(createInput({objectPath:project+"/423e4567-e89b-42d3-a456-426614174000/original.mp4"})),/bound to the verified owner\/project/);
});

test("finds an existing session by owner-scoped idempotency key before provider initiation",async()=>{
 const {store}=setup();
 const created=await store.create(createInput());
 const found=await store.findByIdempotencyKey({ownerId:owner,idempotencyKey:"upload-job-123"});
 assert.equal(found.id,created.id);
 assert.equal(found.uploadId,uploadId);
 assert.deepEqual(found.parts,[]);
 assert.equal(await store.findByIdempotencyKey({ownerId:"523e4567-e89b-42d3-a456-426614174000",idempotencyKey:"upload-job-123"}),null);
});
test("rejects malformed idempotency keys during preflight lookup",async()=>{
 const {store}=setup();
 await assert.rejects(()=>store.findByIdempotencyKey({ownerId:owner,idempotencyKey:""}),/idempotency key/);
});
test("records each part idempotently and rejects mismatched retries and cross-owner reads",async()=>{
 const {store,parts}=setup();const session=await store.create(createInput());
 const first=await store.recordPart({ownerId:owner,sessionId:session.id,partNumber:1,etag:etag1,sha256:"e".repeat(64),size:5_000_000});
 const retry=await store.recordPart({ownerId:owner,sessionId:session.id,partNumber:1,etag:etag1,sha256:"e".repeat(64),size:5_000_000});
 assert.deepEqual(retry,first);assert.equal(parts.length,1);
 await assert.rejects(()=>store.recordPart({ownerId:owner,sessionId:session.id,partNumber:1,etag:etag2,sha256:"e".repeat(64),size:5_000_000}),{code:"B2_MULTIPART_PART_CONFLICT"});
 assert.equal(await store.get({ownerId:"523e4567-e89b-42d3-a456-426614174000",sessionId:session.id}),null);
});

test("completion requires every ordered part and uses a compare-and-set state transition",async()=>{
 const {store,sessions}=setup();const session=await store.create(createInput());
 assert.deepEqual(await store.claimCompletion({ownerId:owner,sessionId:session.id}),{claimed:false,reason:"parts_incomplete",received:0,expected:2});
 await store.recordPart({ownerId:owner,sessionId:session.id,partNumber:2,etag:etag2,sha256:"f".repeat(64),size:5_000_000});
 await store.recordPart({ownerId:owner,sessionId:session.id,partNumber:1,etag:etag1,sha256:"e".repeat(64),size:5_000_000});
 assert.deepEqual(await store.claimCompletion({ownerId:owner,sessionId:session.id}),{claimed:true,reason:"claimed"});
 assert.equal(sessions[0].status,"completing");
 assert.deepEqual(await store.claimCompletion({ownerId:owner,sessionId:session.id}),{claimed:false,reason:"already_completing"});
 assert.equal(await store.markCompleted({ownerId:owner,sessionId:session.id}),true);
 assert.equal(sessions[0].status,"completed");
});

test("reclaims a stale completion claim after a worker restart using compare-and-set",async()=>{
 const {store,sessions,advance}=setup();
 const session=await store.create(createInput());
 await store.recordPart({ownerId,sessionId:session.id,partNumber:1,etag:etag1,sha256:"e".repeat(64),size:5_000_000});
 await store.recordPart({ownerId,sessionId:session.id,partNumber:2,etag:etag2,sha256:"f".repeat(64),size:5_000_000});
 assert.deepEqual(await store.claimCompletion({ownerId,sessionId:session.id}),{claimed:true,reason:"claimed"});
 const firstClaim=sessions[0].completion_claimed_at;
 advance(5*60*1000+1);
 assert.deepEqual(await store.claimCompletion({ownerId,sessionId:session.id}),{claimed:true,reason:"reclaimed_stale_completion"});
 assert.notEqual(sessions[0].completion_claimed_at,firstClaim);
 assert.equal(sessions[0].status,"completing");
});

test("does not reclaim a completion claim before its lease expires",async()=>{
 const {store,advance}=setup();
 const session=await store.create(createInput());
 await store.recordPart({ownerId,sessionId:session.id,partNumber:1,etag:etag1,sha256:"e".repeat(64),size:5_000_000});
 await store.recordPart({ownerId,sessionId:session.id,partNumber:2,etag:etag2,sha256:"f".repeat(64),size:5_000_000});
 await store.claimCompletion({ownerId,sessionId:session.id});
 advance(5*60*1000-1);
 assert.deepEqual(await store.claimCompletion({ownerId,sessionId:session.id}),{claimed:false,reason:"already_completing"});
});

test("rejects unsafe completion lease durations",()=>{
 assert.throws(()=>createB2MultipartUploadStore({url:"https://example.supabase.co",serviceRoleKey:"service-secret",completionLeaseMs:1}),/completion lease/);
});

test("expired and inactive sessions cannot accept additional part checkpoints",async()=>{
 const {store,advance}=setup();const session=await store.create(createInput({expiresAt:"2026-11-17T12:01:00.000Z"}));
 advance(120_000);
 await assert.rejects(()=>store.recordPart({ownerId:owner,sessionId:session.id,partNumber:1,etag:etag1,sha256:"e".repeat(64),size:5_000_000}),{code:"B2_MULTIPART_SESSION_NOT_ACTIVE"});
});

test("rejects malformed identifiers, unsafe paths, invalid hashes and impossible part geometry",async()=>{
 const {store}=setup();
 await assert.rejects(()=>store.create(createInput({ownerId:"not-a-uuid"})),/owner ID/);
 await assert.rejects(()=>store.create(createInput({objectPath:"../private/master.mp4"})),/object path/);
 await assert.rejects(()=>store.create(createInput({sha256:"bad"})),/SHA-256/);
 await assert.rejects(()=>store.create(createInput({partSize:1_000_000})),/part size/);
});
