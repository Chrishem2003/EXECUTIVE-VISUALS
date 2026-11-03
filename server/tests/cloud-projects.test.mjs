import test from "node:test";
import assert from "node:assert/strict";
import { createCloudProjectRepository } from "../cloud-projects.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const row={id:project,owner_id:owner,name:"Production",description:"Film project",settings:{},revision:3,created_at:"2026-10-01T00:00:00Z",updated_at:"2026-10-02T00:00:00Z",archived_at:null};
function fixture({allowed=true,actor=owner,rows=[row],role="editor"}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("project_members?"))return{ok:true,status:200,async text(){return JSON.stringify([{project_id:project,role}]);}};
  if(options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{...JSON.parse(options.body),created_at:row.created_at,updated_at:row.updated_at,revision:1,archived_at:null}]);}};
  if(options.method==="PATCH")return{ok:true,status:200,async text(){return JSON.stringify([{...row,...JSON.parse(options.body)}]);}};
  if(url.includes("owner_id=eq."))return{ok:true,status:200,async text(){return JSON.stringify(actor===owner?rows:[])}};
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
test("lists owned and shared projects without duplicates and checks membership access",async()=>{
 const f=fixture();const result=await f.repository.list({ownerId:owner});
 assert.equal(result.length,1);assert.equal(result[0].id,project);
 assert.equal(f.calls.filter(x=>x.url.includes("projects?")).length,2);
});
test("lists shared projects with the collaborator role from project_members",async()=>{
 const f=fixture({actor:editor,role:"reviewer"});const result=await f.repository.list({ownerId:editor});
 assert.equal(result.length,1);assert.equal(result[0].access_role,"reviewer");
 assert.ok(f.calls.some(call=>call.url.includes("project_members?select=project_id,role")));
});
test("keeps project owner role authoritative over any membership row",async()=>{
 const f=fixture({role:"viewer"});const result=await f.repository.list({ownerId:owner});
 assert.equal(result[0].access_role,"owner");
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
