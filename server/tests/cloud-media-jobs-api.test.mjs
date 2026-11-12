import test from "node:test";
import assert from "node:assert/strict";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const assetId="823e4567-e89b-42d3-a456-426614174000";
const jobId="923e4567-e89b-42d3-a456-426614174000";

function mediaJobApi({asset={id:assetId,ownerId:owner,projectId:project,name:"scene.mp4",mediaType:"video/mp4",size:100,sha256:"a".repeat(64)},canWrite=true,canRead=true,existing=[] ,mediaJobsEnabled=true}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("/jobs?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify(existing);}};
  if(url.includes("/jobs?")&&options.method==="POST"){
   const body=JSON.parse(options.body);
   return{ok:true,status:201,async text(){return JSON.stringify([{...body,created_at:"2026-11-12T00:00:00.000Z"}]);}};
  }
  return{ok:true,status:201,async text(){return"[]";}};
 };
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,mediaJobsEnabled,
  timelineService:{timelines:{},assets:{async get(input){calls.push({assetGet:input});return asset;}}},
  authorize:async input=>input.ownerId===owner&&(!input.projectId||input.projectId===project)&&(input.action==="read"?canRead:canWrite)
 });
 return{api,calls};
}

const path="/api/cloud/assets/"+assetId+"/media-jobs";

test("cloud media jobs enqueue only authorized private assets with server-owned identity and idempotency",async()=>{
 const f=mediaJobApi();
 const deniedIdentity=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-color-001",body:{jobType:"media.color",options:{brightness:0.1,owner_id:editor}}});
 assert.equal(deniedIdentity.status,400);
 assert.equal(f.calls.some(call=>call.options?.method==="POST"),false);
 const accepted=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-color-002",body:{jobType:"media.color",options:{brightness:0.1,contrast:1.1,saturation:0.9}}});
 assert.equal(accepted.status,202);
 assert.equal(accepted.body.job.owner_id,owner);
 const created=JSON.parse(f.calls.find(call=>call.url?.includes("/jobs?")&&call.options.method==="POST").options.body);
 assert.equal(created.owner_id,owner);
 assert.equal(created.project_id,project);
 assert.equal(created.job_type,"media.color");
 assert.deepEqual(created.input,{sourceAssetId:assetId,brightness:0.1,contrast:1.1,saturation:0.9});
 assert.equal(created.status,"queued");
 assert.equal(f.calls.some(call=>call.url.includes("job_events")),true);
});

test("cloud media jobs enforce editor authorization and media compatibility before writes",async()=>{
 const denied=mediaJobApi({canWrite:false});
 const forbidden=await denied.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-denied-1",body:{jobType:"media.color"}});
 assert.equal(forbidden.status,403);
 assert.equal(denied.calls.some(call=>call.options?.method==="POST"),false);
 const image=mediaJobApi({asset:{id:assetId,ownerId:owner,projectId:project,mediaType:"image/png"}});
 const unsupported=await image.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-type-01",body:{jobType:"media.color"}});
 assert.equal(unsupported.status,415);
 assert.equal(image.calls.some(call=>call.options?.method==="POST"),false);
});

test("cloud media job options reject unknown fields and invalid ranges",async()=>{
 const f=mediaJobApi();
 const unknown=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-unknown",body:{jobType:"media.color",options:{ownerId:editor}}});
 assert.equal(unknown.status,400);
 const invalid=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-invalid",body:{jobType:"media.thumbnail",options:{seconds:99999}}});
 assert.equal(invalid.status,400);
 assert.equal(f.calls.some(call=>call.options?.method==="POST"),false);
});

test("cloud media job idempotency replays exact requests and rejects key reuse",async()=>{
 const input={sourceAssetId:assetId,brightness:0.2};
 const row={id:jobId,owner_id:owner,project_id:project,job_type:"media.color",status:"queued",input};
 const replay=mediaJobApi({existing:[row]});
 const same=await replay.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-replay-1",body:{jobType:"media.color",options:{brightness:0.2}}});
 assert.equal(same.status,200);
 assert.equal(same.body.idempotentReplay,true);
 const conflict=await replay.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-replay-1",body:{jobType:"media.color",options:{brightness:0.4}}});
 assert.equal(conflict.status,409);
});

test("cloud media jobs require idempotency keys and reject unsupported operations",async()=>{
 const f=mediaJobApi();
 const missing=await f.api.handle({method:"POST",path,ownerId:owner,body:{jobType:"media.probe"}});
 assert.equal(missing.status,400);
 const unknown=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-unknown",body:{jobType:"shell.exec"}});
 assert.equal(unknown.status,400);
});

test("cloud media job API remains disabled until an isolated worker is explicitly enabled",async()=>{
 const f=mediaJobApi({mediaJobsEnabled:false});
 const result=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-disabled",body:{jobType:"media.probe"}});
 assert.equal(result.status,503);
 assert.equal(result.body.error.code,"CLOUD_MEDIA_WORKER_DISABLED");
 assert.equal(f.calls.some(call=>call.options?.method==="POST"),false);
});

test("cloud media job history is scoped to the selected authorized project",async()=>{
 const row={id:jobId,owner_id:owner,project_id:project,job_type:"media.thumbnail",status:"succeeded",progress:100};
 const f=mediaJobApi({existing:[row]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project}});
 assert.equal(result.status,200);
 assert.equal(result.body.jobs.length,1);
 assert.equal(f.calls.some(call=>call.url.includes("project_id=eq."+project)),true);
 const invalid=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:"not-a-uuid"}});
 assert.equal(invalid.status,400);
});

test("cloud media job history does not query projects the caller cannot read",async()=>{
 const f=mediaJobApi({canRead:false});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project}});
 assert.equal(result.status,404);
 assert.equal(f.calls.some(call=>call.url.includes("/jobs?")),false);
});
