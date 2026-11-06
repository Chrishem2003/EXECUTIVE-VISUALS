import test from "node:test";
import assert from "node:assert/strict";
import {createCloudPublicationAuditApi} from "../cloud-publication-audit-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const project="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const job="55555555-5555-4555-8555-555555555555";
const run="99999999-9999-4999-8999-999999999999";
const admin={id:owner,email:"admin@example.test",emailVerified:true};
const row=(id,at="2026-11-07T12:00:00.000Z")=>({id,run_id:run,event_type:"publication.cleanup_completed",owner_id:owner,project_id:project,occurred_at:at,details:{removedCount:0}});
function fixture({rows=[],allow=true,admins="admin@example.test",status=200}={}){
 const calls=[];
 const api=createCloudPublicationAuditApi({
  url:"https://example.supabase.co",serviceRoleKey:"private-service-role",
  adminEmails:admins,authorize:async()=>allow,
  fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:status>=200&&status<300,status,async json(){return rows;}};}
 });
 return{api,calls};
}
test("requires an explicit administrator allowlist and rejects untrusted identities",async()=>{
 const f=fixture();
 assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:{id:owner,email:"other@example.test",emailVerified:true},query:{}})).status,403);
 assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:{id:owner,email:"admin@example.test",emailVerified:false},query:{}})).status,403);
 assert.equal(f.calls.length,0);
 assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:null,query:{}})).status,401);
 assert.equal((await f.api.handle({method:"POST",path:"/api/cloud/publication-audit",user:admin,query:{}})).status,405);
});
test("scopes personal audit events to the authenticated owner and null project",async()=>{
 const f=fixture({rows:[row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query:{limit:"20"}});
 assert.equal(result.status,200);
 const url=new URL(f.calls[0].url);
 assert.equal(url.searchParams.get("owner_id"),"eq."+owner);
 assert.equal(url.searchParams.get("project_id"),"is.null");
 assert.equal(url.searchParams.get("limit"),"21");
 assert.equal(f.calls[0].options.headers.apikey,"private-service-role");
 assert.equal(f.calls[0].options.headers["accept-profile"],"executive_visuals");
 assert.equal(result.body.readOnly,true);
});
test("authorizes project scope before querying and applies filters",async()=>{
 const f=fixture({rows:[row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query:{projectId:project,jobId:job,runId:run,actorId:owner,eventType:"publication.cleanup_completed",from:"2026-11-01T00:00:00Z",to:"2026-11-08T00:00:00Z"}});
 assert.equal(result.status,200);
 const url=new URL(f.calls[0].url);
 assert.equal(url.searchParams.get("project_id"),"eq."+project);
 assert.equal(url.searchParams.get("job_id"),"eq."+job);
 assert.equal(url.searchParams.get("run_id"),"eq."+run);
 assert.equal(url.searchParams.get("actor_id"),"eq."+owner);
 assert.equal(url.searchParams.get("event_type"),"eq.publication.cleanup_completed");
 assert.equal(url.searchParams.get("and"),"(occurred_at.gte.2026-11-01T00:00:00.000Z,occurred_at.lte.2026-11-08T00:00:00.000Z)");
 assert.equal(url.searchParams.get("or"),null);
});
test("denies project access without querying the audit ledger",async()=>{
 const f=fixture({allow:false});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query:{projectId:project}});
 assert.equal(result.status,404);
 assert.equal(f.calls.length,0);
});
test("uses stable keyset pagination and returns a continuation cursor",async()=>{
 const f=fixture({rows:[row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),row("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),row("dddddddd-dddd-4ddd-8ddd-dddddddddddd")]});
 const first=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query:{projectId:project,limit:"2"}});
 assert.equal(first.body.events.length,2);
 assert.equal(first.body.hasMore,true);
 assert.ok(first.body.nextCursor);
 const decoded=JSON.parse(Buffer.from(first.body.nextCursor,"base64url").toString("utf8"));
 assert.equal(decoded.id,"cccccccc-cccc-4ccc-8ccc-cccccccccccc");
 const second=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query:{projectId:project,limit:"2",cursor:first.body.nextCursor}});
 assert.equal(second.status,200);
 const url=new URL(f.calls[1].url);
 assert.match(url.searchParams.get("or"),/occurred_at\.lt\./);
 assert.match(url.searchParams.get("or"),/id\.lt\.cccccccc-cccc-4ccc-8ccc-cccccccccccc/);
});
test("rejects malformed cursors, unsafe filters and invalid date ranges",async()=>{
 const f=fixture();
 for(const query of [{projectId:"bad"},{eventType:"publication.cleanup_started"},{limit:"1000"},{cursor:"not-a-cursor"},{from:"2026-12-01T00:00:00Z",to:"2026-11-01T00:00:00Z"}]){
  const result=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query});
  assert.equal(result.status,400);
 }
 assert.equal(f.calls.length,0);
});
test("readiness checks the audit ledger without returning rows",async()=>{
 const f=fixture();
 assert.equal(await f.api.checkReadiness(),true);
 assert.equal(new URL(f.calls[0].url).searchParams.get("limit"),"0");
});
test("storage errors fail closed and do not expose service credentials",async()=>{
 const f=fixture({status:503});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/publication-audit",user:admin,query:{}});
 assert.equal(result.status,503);
 assert.equal(result.body.error.code,"PUBLICATION_AUDIT_UNAVAILABLE");
 assert.equal(JSON.stringify(result).includes("private-service-role"),false);
});
