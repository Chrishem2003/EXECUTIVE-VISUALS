import test from "node:test";
import assert from "node:assert/strict";
import { createCloudAssetAuthorizer } from "../cloud-asset-auth.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const reviewer="323e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
function setup({ownerRows=[],memberRows=[],failStatus=0}={}){
 const calls=[];
 const authorize=createCloudAssetAuthorizer({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(failStatus)return{ok:false,status:failStatus};
  const isOwner=url.includes("/projects?");
  return{ok:true,async json(){return isOwner?ownerRows:memberRows;}};
 }});
 return{authorize,calls};
}
test("personal assets authorize their authenticated owner without a project lookup",async()=>{
 const f=setup();
 assert.equal(await f.authorize({ownerId:owner,action:"write"}),true);
 assert.equal(f.calls.length,0);
});
test("project owners may read and write",async()=>{
 const f=setup({ownerRows:[{id:project}]});
 assert.equal(await f.authorize({ownerId:owner,projectId:project,action:"read"}),true);
 assert.equal(await f.authorize({ownerId:owner,projectId:project,action:"write"}),true);
 assert.equal(f.calls.length,2);
});
test("editors may read and write project assets",async()=>{
 const f=setup({memberRows:[{project_id:project}]});
 assert.equal(await f.authorize({ownerId:editor,projectId:project,action:"read"}),true);
 assert.equal(await f.authorize({ownerId:editor,projectId:project,action:"write"}),true);
});
test("reviewers and viewers may read but cannot write project assets",async()=>{
 const f=setup({memberRows:[{project_id:project}]});
 assert.equal(await f.authorize({ownerId:reviewer,projectId:project,action:"read"}),true);
 assert.equal(await f.authorize({ownerId:reviewer,projectId:project,action:"write"}),false);
});
test("unrelated users and malformed identifiers are denied",async()=>{
 const f=setup();
 assert.equal(await f.authorize({ownerId:editor,projectId:project,action:"read"}),false);
 assert.equal(await f.authorize({ownerId:"not-a-uuid",projectId:project,action:"write"}),false);
 assert.equal(await f.authorize({ownerId:editor,projectId:"bad",action:"read"}),false);
});
test("permission service errors fail closed rather than granting access",async()=>{
 const f=setup({failStatus:500});
 await assert.rejects(()=>f.authorize({ownerId:editor,projectId:project,action:"read"}),/permission lookup failed/);
});
test("authorization pins requests to the private schema and server credential",async()=>{
 const f=setup({ownerRows:[{id:project}]});
 await f.authorize({ownerId:owner,projectId:project,action:"write"});
 assert.equal(f.calls[0].options.headers["accept-profile"],"executive_visuals");
 assert.equal(f.calls[0].options.headers.authorization,"Bearer service-secret");
 assert.match(f.calls[0].url,/owner_id=eq\./);
});
