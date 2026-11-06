import test from "node:test";
import assert from "node:assert/strict";
import { createCloudReviewRepository } from "../cloud-reviews.mjs";
const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",projectId="423e4567-e89b-42d3-a456-426614174000",assetId="523e4567-e89b-42d3-a456-426614174000",timelineId="623e4567-e89b-42d3-a456-426614174000",reviewId="723e4567-e89b-42d3-a456-426614174000";
const timeline={id:timelineId,projectId,revision:5,timeline:{frameRate:{numerator:24,denominator:1}}};
function setup({role="editor",existing=[]}={}){
 const calls=[],rows=[...existing];
 const projects={async get({ownerId,projectId:id}){return id===projectId?{id,ownerId:owner, name:"Review project"}:null;}};
 const assets={async get({ownerId,assetId:id}){return{id,projectId,mediaType:"video/mp4"};}};
 const timelines={async get(){return timeline;}};
 const fetchImpl=async(url,options)=>{
  const path=url.split("/rest/v1/")[1];
  calls.push({path,method:options.method,body:options.body?JSON.parse(options.body):null});
  if(path.startsWith("project_members?"))return{ok:true,status:200,async text(){return JSON.stringify(role? [{role}]:[]);}};
  if(path.startsWith("reviews?")&&options.method==="GET"){
   const query=path.split("?")[1]||"";
   const result=rows.filter(row=>(!query.includes("id=eq.")||query.includes("id=eq."+row.id))&&(!query.includes("project_id=eq.")||query.includes("project_id=eq."+row.project_id))&&(!query.includes("request_id=eq.")||query.includes("request_id=eq."+row.request_id)));
   return{ok:true,status:200,async text(){return JSON.stringify(result);}};
  }
  if(path.startsWith("reviews?")&&options.method==="POST"){
   const row={created_at:"2026-11-06T12:00:00.000Z",updated_at:"2026-11-06T12:00:00.000Z",...JSON.parse(options.body)};
   rows.push(row);return{ok:true,status:201,async text(){return JSON.stringify([row]);}};
  }
  if(path.startsWith("reviews?")&&options.method==="PATCH"){
   const query=path.split("?")[1]||"",found=rows.find(row=>query.includes("id=eq."+row.id));
   if(!found)return{ok:true,status:200,async text(){return"[]";}};
   Object.assign(found,JSON.parse(options.body));return{ok:true,status:200,async text(){return JSON.stringify([found]);}};
  }
  throw new Error("Unexpected request "+options.method+" "+path);
 };
 const repo=createCloudReviewRepository({url:"https://example.supabase.co",serviceRoleKey:"server-secret",fetchImpl,authorize:async({ownerId,projectId:pid,action})=>[owner,editor].includes(ownerId)&&pid===projectId&&(action==="read"||action==="write"),projects,assets,timelines});
 return{repo,calls,rows};
}
const input={projectId,assetId,timelineId,timelineRevision:4,frameNumber:240,durationFrames:24,body:"Fix the title alignment.",annotation:{version:1,shapes:[{type:"arrow",points:[{x:0.1,y:0.2},{x:0.8,y:0.7}]}]}};
test("creates a frame-anchored review as the verified reviewer and keeps project ownership separate",async()=>{
 const f=setup();const result=await f.repo.create({actorId:editor,input,idempotencyKey:"review-request-0001"});
 assert.equal(result.review.projectId,projectId);assert.equal(result.review.authorId,editor);assert.equal(result.review.frameNumber,240);
 assert.equal(f.rows[0].owner_id,owner);assert.equal(f.rows[0].reviewer_id,editor);
 assert.equal(Number(f.rows[0].timecode_seconds),10);
});
test("rejects viewer roles from creating comments",async()=>{
 const f=setup({role:"viewer"});await assert.rejects(()=>f.repo.create({actorId:editor,input}),error=>error.code==="CLOUD_REVIEW_ACCESS_DENIED");
});
test("lists project comments but filters internal notes from viewer membership",async()=>{
 const rows=[{id:reviewId,owner_id:owner,project_id:projectId,reviewer_id:owner,body:"public",visibility:"project",status:"open",decision:"comment",created_at:"2026-11-06T12:00:00Z"},{id:"823e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:projectId,reviewer_id:owner,body:"private",visibility:"internal",status:"open",decision:"comment",created_at:"2026-11-06T12:00:00Z"}];
 const f=setup({role:"viewer",existing:rows});const result=await f.repo.list({actorId:editor,projectId});assert.equal(result.length,1);assert.equal(result[0].body,"public");
});
test("only comment author or project editor can edit, and optimistic concurrency prevents lost updates",async()=>{
 const row={id:reviewId,owner_id:owner,project_id:projectId,reviewer_id:editor,body:"Old note",visibility:"project",status:"open",decision:"comment",created_at:"2026-11-06T12:00:00Z",updated_at:"2026-11-06T12:00:00Z"};
 const f=setup({existing:[row]});const result=await f.repo.update({actorId:editor,reviewId,input:{body:"Updated note",status:"resolved"}});
 assert.equal(result.body,"Updated note");assert.equal(result.status,"resolved");assert.equal(result.resolvedBy,editor);
 assert.ok(f.calls.some(call=>call.method==="PATCH"&&call.path.includes("updated_at=eq.")));
});
test("rejects unauthorized review edits",async()=>{
 const row={id:reviewId,owner_id:owner,project_id:projectId,reviewer_id:owner,body:"Owner note",visibility:"project",status:"open",decision:"comment",created_at:"2026-11-06T12:00:00Z",updated_at:"2026-11-06T12:00:00Z"};
 const f=setup({role:"reviewer",existing:[row]});await assert.rejects(()=>f.repo.update({actorId:editor,reviewId,input:{body:"Tamper"}}),error=>error.code==="CLOUD_REVIEW_ACCESS_DENIED");
});
test("rejects review payload attempts to forge ownership or author identity",async()=>{
 const f=setup();await assert.rejects(()=>f.repo.create({actorId:editor,input:{...input,ownerId:owner,reviewerId:owner}}),error=>error.code==="CLOUD_REVIEW_INVALID");
});
