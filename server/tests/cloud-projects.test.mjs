import test from "node:test";
import assert from "node:assert/strict";
import { createCloudProjectRepository } from "../cloud-projects.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const row={id:project,owner_id:owner,name:"Production",description:"Film project",settings:{},revision:3,created_at:"2026-10-01T00:00:00Z",updated_at:"2026-10-02T00:00:00Z",archived_at:null};
function fixture({allowed=true,actor=owner,rows=[row]}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("project_members?"))return{ok:true,status:200,async text(){return JSON.stringify([{project_id:project}]);}};
  if(options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{...JSON.parse(options.body),created_at:row.created_at,updated_at:row.updated_at,revision:1,archived_at:null}]);}};
  if(options.method==="PATCH")return{ok:true,status:200,async text(){return JSON.stringify([{...row,...JSON.parse(options.body)}]);}};
  return{ok:true,status:200,async text(){return JSON.stringify(rows)}};
 };
 const repository=createCloudProjectRepository({url:"https://example.supabase.co",serviceRoleKey:"secret",fetchImpl,authorize:async({ownerId,projectId,action})=>allowed&&ownerId===actor&&(!projectId||projectId===project)&&(action==="read"||action==="write")});
 return{repository,calls};
}
test("creates projects with verified owner identity and validated metadata",async()=>{
 const f=fixture();const result=await f.repository.create({ownerId:owner,name:"  Production  ",description:"Brief",settings:{aspectRatio:"16:9"}});
 assert.equal(result.ownerId,owner);assert.equal(result.name,"Production");
 const body=JSON.parse(f.calls[0].options.body);assert.equal(body.owner_id,owner);assert.equal(body.name,"Production");
});
test("creates a cloud project using the exact active local project UUID",async()=>{
 const f=fixture({rows:[]});
 const result=await f.repository.create({ownerId:owner,projectId:project,name:"Production",description:"Film project"});
 assert.equal(result.id,project);
 assert.equal(JSON.parse(f.calls.at(-1).options.body).id,project);
 assert.equal(f.calls.filter(call=>call.options.method==="POST").length,1);
});
test("links an existing same-owner cloud project idempotently without overwriting it",async()=>{
 const f=fixture();
 const result=await f.repository.create({ownerId:owner,projectId:project,name:"Changed name",description:"Changed description"});
 assert.equal(result.id,project);
 assert.equal(result.name,row.name);
 assert.equal(f.calls.filter(call=>call.options.method==="POST").length,0);
});
test("does not link a project UUID owned by another account",async()=>{
 const f=fixture({rows:[{...row,owner_id:editor}]});
 await assert.rejects(()=>f.repository.create({ownerId:owner,projectId:project,name:"Production"}),e=>e.code==="CLOUD_PROJECT_ACCESS_DENIED");
 assert.equal(f.calls.filter(call=>call.options.method==="POST").length,0);
});
test("rejects malformed explicit cloud project IDs before database access",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.repository.create({ownerId:owner,projectId:"not-a-uuid",name:"Production"}));
 assert.equal(f.calls.length,0);
});

test("lists owned and shared projects without duplicates and checks membership access",async()=>{
 const f=fixture();const result=await f.repository.list({ownerId:owner});
 assert.equal(result.length,1);assert.equal(result[0].id,project);
 assert.equal(f.calls.filter(x=>x.url.includes("projects?")).length,2);
});
test("reads shared projects through the authorizer",async()=>{
 const f=fixture({actor:editor});const result=await f.repository.get({ownerId:editor,projectId:project});
 assert.equal(result.id,project);
});
test("does not disclose projects when authorization fails",async()=>{
 const f=fixture({allowed:false});await assert.rejects(()=>f.repository.get({ownerId:owner,projectId:project}),e=>e.code==="CLOUD_PROJECT_ACCESS_DENIED");
});
test("uses optimistic revision updates and permits authorized editors",async()=>{
 const f=fixture({actor:editor});const result=await f.repository.update({ownerId:editor,projectId:project,expectedRevision:3,name:"Updated"});
 assert.equal(result.revision,4);assert.ok(f.calls.at(-1).url.includes("revision=eq.3"));
});
test("rejects stale project revisions before mutation",async()=>{
 const f=fixture();await assert.rejects(()=>f.repository.update({ownerId:owner,projectId:project,expectedRevision:2,name:"Updated"}),e=>e.code==="CLOUD_PROJECT_REVISION_CONFLICT");
 assert.equal(f.calls.filter(x=>x.options.method==="PATCH").length,0);
});
test("archives without deleting project records",async()=>{
 const f=fixture();const result=await f.repository.archive({ownerId:owner,projectId:project,expectedRevision:3});
 assert.equal(result.archived,true);assert.equal(result.revision,4);
});

test("prevents project editors from archiving the owner's project",async()=>{
 const f=fixture({actor:editor});
 await assert.rejects(()=>f.repository.archive({ownerId:editor,projectId:project,expectedRevision:3}),e=>e.code==="CLOUD_PROJECT_ACCESS_DENIED");
 assert.equal(f.calls.filter(x=>x.options.method==="PATCH").length,0);
});
