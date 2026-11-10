import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCloudTimelineRepository } from "../cloud-timelines.mjs";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const timelineId="523e4567-e89b-42d3-a456-426614174000";
const timeline={id:timelineId,owner_id:owner,project_id:null,name:"Sequence",revision:3,timeline:{frameRate:{numerator:24,denominator:1},tracks:[],markers:[]},otio:null,created_at:"2026-11-09T10:00:00.000Z",updated_at:"2026-11-09T11:00:00.000Z"};
const snapshot={timeline_id:timelineId,revision:2,name:"Sequence",timeline:{frameRate:{numerator:24,denominator:1},tracks:[],markers:[{id:"m1",name:"Old marker",start:{value:12,rate:24}}]},otio:null,created_at:"2026-11-09T10:30:00.000Z"};

test("cloud timeline revision listing returns authorized metadata without loading full documents",async()=>{
 const calls=[];
 const fetchImpl=async(url)=>{calls.push(url);const rows=url.includes("timeline_revisions")?[{timeline_id:timelineId,revision:3,name:"Sequence",created_at:"2026-11-09T11:00:00Z"},{timeline_id:timelineId,revision:2,name:"Sequence",created_at:"2026-11-09T10:30:00Z"}]:[timeline];return{ok:true,status:200,async text(){return JSON.stringify(rows);}};};
 const repo=createCloudTimelineRepository({url:"https://example.supabase.co",serviceRoleKey:"server-only",fetchImpl,authorize:async()=>true,getAsset:async()=>({mediaType:"video/mp4"})});
 const revisions=await repo.listRevisions({ownerId:owner,timelineId,limit:50});
 assert.equal(revisions.length,2);
 assert.equal(revisions[0].revision,3);
 assert.equal("timeline" in revisions[0],false);
 assert.match(calls[1],/select=timeline_id,revision,name,created_at/);
});

test("cloud timeline revision retrieval returns the immutable saved document",async()=>{
 const fetchImpl=async(url)=>{const rows=url.includes("timeline_revisions")?[snapshot]:[timeline];return{ok:true,status:200,async text(){return JSON.stringify(rows);}};};
 const repo=createCloudTimelineRepository({url:"https://example.supabase.co",serviceRoleKey:"server-only",fetchImpl,authorize:async()=>true,getAsset:async()=>({mediaType:"video/mp4"})});
 const result=await repo.getRevision({ownerId:owner,timelineId,revision:2});
 assert.equal(result.revision,2);
 assert.equal(result.timeline.markers[0].name,"Old marker");
});

test("revision endpoints require a verified account and return bounded metadata",async()=>{
 const calls=[];
 const service={timelines:{
  async listRevisions(input){calls.push(["list",input]);return[{timelineId,revision:3,name:"Sequence",createdAt:"2026-11-09T11:00:00Z"}];},
  async getRevision(input){calls.push(["get",input]);return{timelineId,revision:2,name:"Sequence",timeline:snapshot.timeline,otio:null,createdAt:snapshot.created_at};}
 }};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"server-only",fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),timelineService:service,authorize:async()=>true});
 const list=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/revisions",ownerId:owner,query:{limit:"50"}});
 assert.equal(list.status,200);assert.equal(list.body.revisions[0].revision,3);
 const detail=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/revisions/2",ownerId:owner});
 assert.equal(detail.status,200);assert.equal(detail.body.revision.timeline.markers[0].name,"Old marker");
 const denied=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/revisions",ownerId:"not-a-uuid"});
 assert.equal(denied.status,401);assert.equal(calls.length,2);
});

test("revision endpoint rejects invalid revision numbers",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"server-only",fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),timelineService:{timelines:{async getRevision(){throw new Error("must not be called");},async listRevisions(){throw new Error("must not be called");}}},authorize:async()=>true});
 const result=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/revisions/0",ownerId:owner});
 assert.equal(result.status,400);
});

test("database migration captures immutable revisions and limits member access to reads",async()=>{
 const sql=await readFile(new URL("../../supabase/migrations/20261120100000_timeline_revision_history.sql",import.meta.url),"utf8");
 assert.match(sql,/create table if not exists executive_visuals\.timeline_revisions/i);
 assert.match(sql,/after insert or update of revision on executive_visuals\.timelines/i);
 assert.match(sql,/security definer/i);
 assert.match(sql,/on conflict \(timeline_id, revision\) do nothing/i);
 assert.match(sql,/create policy ev_timeline_revisions_read/i);
 assert.ok(sql.includes("from executive_visuals.timelines t"));
 assert.doesNotMatch(sql,/create policy[^;]+for (insert|update|delete)/i);
});
