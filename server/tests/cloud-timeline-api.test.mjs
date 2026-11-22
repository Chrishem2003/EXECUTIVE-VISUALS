import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { createCloudTimelineApi as createCloudTimelineApiBase } from "../cloud-timeline-api.mjs";
import { createVideoWorkflowCloudRequest } from "../video-workflow-cloud-contract.mjs";

// Deterministic test-only pricing policy: 1,000 customer credits per USD.
// Production always injects the validated server-side margin/fee policy.
function createCloudTimelineApi(options={}){
 return createCloudTimelineApiBase({quoteCustomerCredits:({currency,amountMicros})=>{
  if(currency!=="USD"||!Number.isSafeInteger(amountMicros)||amountMicros<1)throw new Error("Invalid test quote");
  return Math.ceil(amountMicros/1000);
 },...options});
}


const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",project="423e4567-e89b-42d3-a456-426614174000",timelineId="523e4567-e89b-42d3-a456-426614174000";
const timelineDoc={width:1280,height:720,frameRate:{numerator:24,denominator:1},tracks:[],markers:[]};
function setup({canWrite=true,projectOwnerId=owner,projectId=project,existing=[],assetMediaType="video/mp4",timelineCreditsPerSecond=0,timelineDocument=timelineDoc,reserveResponse={reservation_id:"923e4567-e89b-42d3-a456-426614174000",status:"reserved",credit_units:24},quotaError=null,env={},workflowNodeDispatch=null,workflowNodeDispatchEnabled=()=>false,workflowJobLookup=null,workflowJobCancel=null}={}){
 const calls=[],created=[];
 const timeline={id:timelineId,ownerId:owner,projectId,name:"Test timeline",revision:2,timeline:timelineDocument,otio:null};
 const timelines={
  async create(input){created.push(input);return{...timeline,...input,revision:1};},
  async get(input){calls.push(["get",input]);return input.ownerId===owner?timeline:null;},
  async list(input){calls.push(["timeline-list",input]);return[{...timeline}];},
  async update(input){calls.push(["update",input]);return{...timeline,revision:input.expectedRevision+1,timeline:input.timeline};}
 };
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.endsWith("/rpc/list_project_members"))return{ok:true,status:200,async text(){return JSON.stringify([{member_id:editor,email:"editor@example.test",role:"editor",created_at:"2026-11-01T00:00:00Z"}]);}};if(url.endsWith("/rpc/add_project_member"))return{ok:true,status:200,async text(){return JSON.stringify({projectId,memberId:editor,email:"editor@example.test",role:"editor"});}};if(url.endsWith("/rpc/remove_project_member"))return{ok:true,status:200,async text(){return"true";}};if(url.endsWith("/rpc/configure_project_credit_pool"))return{ok:true,status:200,async text(){return JSON.stringify({projectId,status:"active",monthlySpendLimitCredits:500});}};if(url.endsWith("/rpc/fund_project_credit_pool"))return{ok:true,status:200,async text(){return JSON.stringify([{pool_balance:1000,personal_balance:900,replayed:false}]);}};if(url.endsWith("/rpc/list_project_credit_pool_member_usage"))return{ok:true,status:200,async text(){return JSON.stringify([{member_id:editor,role:"editor",status:"active",monthly_limit_credits:250,used_this_month:50,remaining_this_month:200}]);}};if(url.endsWith("/rpc/configure_project_credit_pool_member_policy"))return{ok:true,status:200,async text(){return JSON.stringify({projectId,memberId:editor,status:"paused",monthlyLimitCredits:100});}};if(url.endsWith("/rpc/reserve_credit_units"))return{ok:true,status:200,async text(){return JSON.stringify(reserveResponse);}};if(url.endsWith("/rpc/release_credit_reservation"))return{ok:true,status:200,async text(){return"true";}};if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){const posted=JSON.parse(options.body);return JSON.stringify([{...posted,progress:0,created_at:"2026-11-11T00:00:00.000Z",updated_at:"2026-11-11T00:00:00.000Z"}])}};if(url.includes("/jobs?")&&options.method==="PATCH"){const route=new URL(url).searchParams,id=route.get("id")?.slice(3),expected=route.get("status")?.slice(3),row=existing.find(item=>item.id===id&&item.status===expected);if(!row)return{ok:true,status:200,async text(){return"[]"}};Object.assign(row,JSON.parse(options.body));return{ok:true,status:200,async text(){return JSON.stringify([row])}};}if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{async list(input){calls.push(["asset-list",input]);return[{id:"asset-1",projectId:input.projectId}];},async get(input){calls.push(["asset-get",input]);return{id:input.assetId,ownerId:input.ownerId,projectId,name:"clip.mp4",mediaType:assetMediaType};},async getStorageUsage(input){calls.push(["asset-usage",input]);return{globalBytes:4,globalAssetCount:1,ownerBytes:4,ownerAssetCount:1,maxTotalBytes:786432000,maxOwnerBytes:536870912,remainingTotalBytes:786431996,remainingOwnerBytes:536870908};},async createFromFile(input){calls.push(["asset-create-from-file",input]);if(quotaError)throw Object.assign(new Error(quotaError),{code:quotaError});return{id:"asset-uploaded",ownerId:input.ownerId,projectId:input.projectId,name:input.originalName,size:4};}},projects:{async create(input){calls.push(["project-create",input]);return{id:"project-1",...input};},async list(input){calls.push(["project-list",input]);return[{id:project}];},async get(input){calls.push(["project-get",input]);return{id:project,...input,ownerId:projectOwnerId};},async update(input){calls.push(["project-update",input]);return{id:project,...input};},async archive(input){calls.push(["project-archive",input]);return{id:project,archived:true};}}},authorize:async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"||canWrite),timelineCreditsPerSecond,env,workflowNodeDispatch,workflowNodeDispatchEnabled,workflowJobLookup,workflowJobCancel});
 return{api,calls,created};
}
test("cloud project owner can add, list and remove registered team members",async()=>{
 const f=setup({env:{PROJECT_CREDIT_POOL_API_ENABLED:"true"}});
 const listed=await f.api.handle({method:"GET",path:"/api/cloud/projects/"+project+"/members",ownerId:owner});
 assert.equal(listed.status,200);
 assert.equal(listed.body.members[0].email,"editor@example.test");
 const added=await f.api.handle({method:"POST",path:"/api/cloud/projects/"+project+"/members",ownerId:owner,body:{email:"editor@example.test",role:"editor"}});
 assert.equal(added.status,201);
 assert.equal(added.body.member.role,"editor");
 const removed=await f.api.handle({method:"DELETE",path:"/api/cloud/projects/"+project+"/members/"+editor,ownerId:owner});
 assert.equal(removed.status,200);
 assert.equal(removed.body.ok,true);
});

test("project shared credit routes require the feature flag and cloud project owner",async()=>{
 const disabled=setup();
 const off=await disabled.api.handle({method:"GET",path:"/api/cloud/projects/"+project+"/credit-pool/members",ownerId:owner});
 assert.equal(off.status,503);
 const enabled=setup({env:{PROJECT_CREDIT_POOL_API_ENABLED:"true"},projectOwnerId:editor});
 const denied=await enabled.api.handle({method:"GET",path:"/api/cloud/projects/"+project+"/credit-pool/members",ownerId:owner});
 assert.equal(denied.status,403);
 assert.equal(denied.body.error.code,"PROJECT_CREDIT_POOL_OWNER_REQUIRED");
});

test("project owner can configure and fund a cloud shared credit pool with idempotent transfer identity",async()=>{
 const f=setup({env:{PROJECT_CREDIT_POOL_API_ENABLED:"true"}});
 const configured=await f.api.handle({method:"POST",path:"/api/cloud/projects/"+project+"/credit-pool",ownerId:owner,body:{monthlySpendLimitCredits:500}});
 assert.equal(configured.status,200);
 assert.equal(configured.body.result.status,"active");
 const funded=await f.api.handle({method:"POST",path:"/api/cloud/projects/"+project+"/credit-pool/fund",ownerId:owner,idempotencyKey:"cloud-topup-0001",body:{credits:100}});
 assert.equal(funded.status,200);
 assert.equal(funded.body.result[0].pool_balance,1000);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].endsWith("/rpc/fund_project_credit_pool")),true);
});

test("project owner can read member usage and pause or cap a specific editor",async()=>{
 const f=setup({env:{PROJECT_CREDIT_POOL_API_ENABLED:"true"}});
 const usage=await f.api.handle({method:"GET",path:"/api/cloud/projects/"+project+"/credit-pool/members",ownerId:owner});
 assert.equal(usage.status,200);
 assert.equal(usage.body.result[0].remaining_this_month,200);
 const policy=await f.api.handle({method:"PUT",path:"/api/cloud/projects/"+project+"/credit-pool/members/"+editor+"/policy",ownerId:owner,body:{monthlyLimitCredits:100,status:"paused"}});
 assert.equal(policy.status,200);
 assert.equal(policy.body.result.status,"paused");
});

test("cloud asset usage endpoint returns only the verified owner's quota snapshot",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/assets/usage",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.usage.usedBytes,4);
 assert.equal("globalBytes" in result.body.usage,false);
 assert.deepEqual(f.calls.find(call=>call[0]==="asset-usage")[1],{ownerId:owner});
});

test("private media upload returns 507 and a typed error when storage quota is reached",async()=>{
 const f=setup({quotaError:"CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED"});
 const payload=Buffer.from([0,0,0,20,0x66,0x74,0x79,0x70,0,0,0,0]);
 const req=Readable.from([payload]);req.headers={"content-length":String(payload.length)};
 const result=await f.api.uploadAsset({req,ownerId:owner,projectId:project,originalName:"quota.mp4",mediaType:"video/mp4"});
 assert.equal(result.status,507);
 assert.equal(result.body.error.code,"CLOUD_ASSET_STORAGE_QUOTA_EXCEEDED");
 assert.equal("detail" in result.body.error,false);
});

test("cloud timeline create binds ownership to verified identity, not request body",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines",ownerId:owner,body:{ownerId:editor,projectId:project,name:"Test",timeline:timelineDoc}});assert.equal(result.status,201);assert.equal(f.created[0].ownerId,owner);assert.equal(f.created[0].projectId,project);});
test("cloud timeline accepts private video assets on overlay tracks for final compositing",async()=>{
 const f=setup({assetMediaType:"video/mp4"});
 const clip={id:"clip-1",assetId:"asset-1",name:"source.mp4",timelineStart:{value:0,rate:1},duration:{value:24,rate:24},sourceRange:{start:{value:0,rate:24},duration:{value:24,rate:24}},enabled:true};
 const timeline={...timelineDoc,tracks:[
  {id:"video-track",kind:"video",name:"Primary",enabled:true,locked:false,clips:[clip]},
  {id:"overlay-track",kind:"overlay",name:"Picture in picture",enabled:true,locked:false,clips:[{...clip,id:"overlay-clip",timelineStart:{value:6,rate:24},duration:{value:12,rate:24},sourceRange:{start:{value:0,rate:24},duration:{value:12,rate:24}},metadata:{x:16,y:16,width:160,height:90,opacity:0.7}}]}
 ]};
 const result=await f.api.handle({method:"PUT",path:"/api/cloud/timelines/"+timelineId,ownerId:owner,body:{expectedRevision:2,timeline}});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.timeline.timeline.tracks[1].clips[0].assetId,"asset-1");
});

test("cloud timeline get and update use verified owner and optimistic revision",async()=>{const f=setup();const got=await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:owner});assert.equal(got.status,200);const updated=await f.api.handle({method:"PUT",path:"/api/cloud/timelines/"+timelineId,ownerId:owner,body:{expectedRevision:2,timeline:timelineDoc}});assert.equal(updated.status,200);assert.equal(f.calls.find(c=>c[0]==="update")[1].expectedRevision,2);});
test("cloud render submission queues a durable job using current saved timeline revision",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{ownerId:editor,timelineId:"bad"},idempotencyKey:"render-1"});assert.equal(result.status,202,JSON.stringify(result.body));const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");const body=JSON.parse(inserted[2].body);assert.equal(body.owner_id,owner);assert.equal(body.input.timelineId,timelineId);assert.equal(body.input.timelineRevision,2);assert.equal(body.job_type,"timeline.render");});
test("billable cloud render reserves a server-calculated amount before the job is queued",async()=>{
 const timelineDocument={tracks:[{id:"v1",kind:"video",clips:[
  {id:"c1",timelineStart:{value:0,rate:1},duration:{value:12,rate:1},assetId:"asset-1"}
 ]}],markers:[]};
 const f=setup({timelineCreditsPerSecond:2,timelineDocument});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,idempotencyKey:"render-billable-1"});
 assert.equal(result.status,202);
 assert.equal(result.body.billing.reservedCredits,24);
 const reserve=f.calls.find(c=>c[0]==="fetch"&&c[1].endsWith("/rpc/reserve_credit_units"));
 assert.ok(reserve);
 const args=JSON.parse(reserve[2].body);
 assert.equal(args.p_owner_id,owner);
 assert.equal(args.p_credit_units,24);
 assert.equal(args.p_job_id,result.body.job.id);
 assert.equal(args.p_metadata.durationSeconds,12);
 const insert=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs?")&&c[2].method==="POST");
 assert.ok(insert);
 assert.ok(f.calls.findIndex(c=>c[0]==="fetch"&&c[1].endsWith("/rpc/reserve_credit_units"))<f.calls.indexOf(insert));
});

test("billable cloud render fails closed when the credit reservation is rejected",async()=>{
 const timelineDocument={tracks:[{id:"v1",kind:"video",clips:[
  {id:"c1",timelineStart:{value:0,rate:1},duration:{value:12,rate:1},assetId:"asset-1"}
 ]}],markers:[]};
 const f=setup({timelineCreditsPerSecond:2,timelineDocument,reserveResponse:{status:"reserved"}});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner});
 assert.equal(result.status,500);
 assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);
});

test("billable cloud render does not reserve credits for empty timelines",async()=>{
 const f=setup({timelineCreditsPerSecond:2});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner});
 assert.equal(result.status,422);
 assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].endsWith("/rpc/reserve_credit_units")),false);
});

test("cloud render submission requires project editor authorization",async()=>{const f=setup({canWrite:false});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{}});assert.equal(result.status,404);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);});
test("cloud render idempotency replays only the exact same timeline revision",async()=>{const existing=[{id:"623e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"timeline.render",status:"queued",input:{timelineId,timelineRevision:2}}];const f=setup({existing});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,idempotencyKey:"render-1"});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.idempotentReplay,true);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].endsWith("/jobs")),false);});
test("cloud timeline API rejects unverified or malformed owner IDs and ignores unrelated routes",async()=>{const f=setup();assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:"not-uuid"})).status,401);assert.equal(await f.api.handle({method:"GET",path:"/api/not-cloud",ownerId:owner}),null);});

test("cloud render history lists only timeline renders for an authorized project",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174000",owner_id:editor,project_id:project,job_type:"timeline.render",status:"succeeded",progress:100,input:{timelineId,timelineRevision:2},output:{outputAsset:{id:"723e4567-e89b-42d3-a456-426614174000"}},created_at:"2026-11-12T10:00:00Z"};
 const f=setup({existing:[job]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project,limit:"10"}});
 assert.equal(result.status,200);assert.equal(result.body.jobs[0].id,job.id);
 const query=f.calls.find(call=>call[0]==="fetch"&&call[1].includes("/jobs?"));
 assert.ok(query[1].includes("project_id=eq."+project));
 assert.ok(query[1].includes("job_type=eq.timeline.render"));
 assert.ok(query[1].includes("limit=10"));
});
test("cloud render history rejects missing and unauthorized project scopes without querying jobs",async()=>{
 const f=setup({canWrite:false});
 assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{}})).status,400);
 const denied=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:editor,query:{projectId:project}});
 assert.equal(denied.status,404);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/jobs?")),false);
});
test("cloud render job inspection allows project reviewers and returns durable status",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174000",owner_id:editor,project_id:project,job_type:"timeline.render",status:"processing",progress:45,input:{timelineId,timelineRevision:2},output:null,error:null};
 const f=setup({existing:[job]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+job.id,ownerId:owner});
 assert.equal(result.status,200);assert.equal(result.body.job.status,"processing");
});
test("cloud render job inspection hides unrelated personal jobs",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174000",owner_id:editor,project_id:null,job_type:"timeline.render",status:"queued",input:{timelineId,timelineRevision:2}};
 const f=setup({existing:[job]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+job.id,ownerId:owner});
 assert.equal(result.status,404);
});
test("cloud render job event history is available only after job access is verified",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174000",owner_id:editor,project_id:project,job_type:"timeline.render",status:"succeeded",input:{timelineId,timelineRevision:2}};
 const f=setup({existing:[job]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+job.id+"/events",ownerId:owner});
 assert.equal(result.status,200);assert.deepEqual(result.body.events,[]);
});

test("cloud queued media cancellation atomically records a terminal state and is idempotent",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174100",owner_id:editor,project_id:project,job_type:"timeline.render",status:"queued",progress:0,input:{timelineId,timelineRevision:2},cancel_requested_at:null};
 const f=setup({existing:[job]});
 const first=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+job.id+"/cancel",ownerId:owner});
 assert.equal(first.status,200);assert.equal(first.body.job.status,"queued");assert.equal(first.body.idempotentReplay,false);
 assert.equal(first.body.cancellationRequested,true);assert.ok(first.body.job.cancel_requested_at);
 assert.ok(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("job_events")&&JSON.parse(call[2].body).event_type==="job.cancellation_requested"));
 const replay=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+job.id+"/cancel",ownerId:owner});
 assert.equal(replay.status,200);assert.equal(replay.body.idempotentReplay,true);
});
test("cloud active media cancellation records durable intent without pretending execution has stopped",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174101",owner_id:editor,project_id:project,job_type:"media.transcode",status:"processing",progress:35,input:{assetId:"723e4567-e89b-42d3-a456-426614174000"},cancel_requested_at:null};
 const f=setup({existing:[job]});
 const first=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+job.id+"/cancel",ownerId:owner});
 assert.equal(first.status,200);assert.equal(first.body.job.status,"processing");assert.equal(first.body.cancellationRequested,true);
 assert.ok(first.body.job.cancel_requested_at);
 assert.ok(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("job_events")&&JSON.parse(call[2].body).event_type==="job.cancellation_requested"));
 const replay=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+job.id+"/cancel",ownerId:owner});
 assert.equal(replay.status,200);assert.equal(replay.body.idempotentReplay,true);assert.equal(replay.body.cancellationRequested,true);
 assert.equal(job.status,"processing");
});
test("cloud job cancellation requires editor access and excludes provider-managed video jobs",async()=>{
 const active={id:"623e4567-e89b-42d3-a456-426614174102",owner_id:editor,project_id:project,job_type:"timeline.render",status:"processing",cancel_requested_at:null};
 const denied=setup({canWrite:false,existing:[active]});
 assert.equal((await denied.api.handle({method:"POST",path:"/api/cloud/jobs/"+active.id+"/cancel",ownerId:owner})).status,403);
 assert.equal(denied.calls.some(call=>call[0]==="fetch"&&call[2].method==="PATCH"),false);
 const providerJob={...active,id:"623e4567-e89b-42d3-a456-426614174103",job_type:"video.generate"};
 const unknownMedia={...active,id:"623e4567-e89b-42d3-a456-426614174104",job_type:"media.unregistered"};
 const unknown=setup({existing:[unknownMedia]});
 assert.equal((await unknown.api.handle({method:"POST",path:"/api/cloud/jobs/"+unknownMedia.id+"/cancel",ownerId:owner})).body.error.code,"JOB_CANCELLATION_UNSUPPORTED");
 const unsupported=setup({existing:[providerJob]});
 const result=await unsupported.api.handle({method:"POST",path:"/api/cloud/jobs/"+providerJob.id+"/cancel",ownerId:owner});
 assert.equal(result.status,409);assert.equal(result.body.error.code,"JOB_CANCELLATION_UNSUPPORTED");
});
test("cloud timeline API readiness requires exposed schema tables and a private bucket",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async(url)=>({ok:true,status:200,async text(){return url.endsWith("/rpc/get_asset_storage_usage")?JSON.stringify([{max_total_bytes:786432000,max_owner_bytes:536870912}]):"[]";},async json(){return{public:false};}})});
 const result=await api.checkReadiness();assert.equal(result.ready,true);assert.equal(result.storage,"private");
});
test("cloud timeline readiness probes the composite-key project membership table using project_id",async()=>{
 const paths=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  fetchImpl:async(url)=>{paths.push(String(url));return{ok:true,status:200,async text(){return url.endsWith("/rpc/get_asset_storage_usage")?JSON.stringify([{max_total_bytes:786432000,max_owner_bytes:536870912}]):"[]";},async json(){return{public:false};}};}
 });
 const result=await api.checkReadiness();
 assert.equal(result.ready,true);
 assert.ok(paths.some(url=>url.includes("/rest/v1/project_members?select=project_id&limit=0")));
 assert.equal(paths.some(url=>url.includes("/rest/v1/project_members?select=id&limit=0")),false);
});

test("cloud timeline readiness blocks when lease or cancellation columns are missing",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async(url)=>({ok:!url.includes("lease_token"),status:url.includes("lease_token")?400:200,async text(){return url.includes("lease_token")?JSON.stringify({message:"column cancel_requested_at does not exist"}):url.endsWith("/rpc/get_asset_storage_usage")?JSON.stringify([{max_total_bytes:786432000,max_owner_bytes:536870912}]):"[]";},async json(){return{public:false};}})});
 await assert.rejects(()=>api.checkReadiness());
});
test("cloud timeline API refuses a public media bucket",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async(url)=>({ok:true,status:200,async text(){return url.endsWith("/rpc/get_asset_storage_usage")?JSON.stringify([{max_total_bytes:786432000,max_owner_bytes:536870912}]):"[]";},async json(){return{public:true};}})});
 await assert.rejects(()=>api.checkReadiness(),/not confirmed private/);
});
test("cloud timeline API readiness fails closed when a required schema table is unavailable",async()=>{
 let count=0;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async()=>{count++;return{ok:count!==3,status:count===3?404:200,async text(){return"[]";},async json(){return{public:false};}};}});
 await assert.rejects(()=>api.checkReadiness());
});

test("cloud asset upload streams a signature-checked file to the private repository",async()=>{
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("png-fixture")]);
 let stored=null;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{async createFromFile(input){stored={...input,bytes:await readFile(input.filePath)};return{id:"723e4567-e89b-42d3-a456-426614174000",ownerId:input.ownerId,projectId:input.projectId,name:input.originalName,mediaType:input.mediaType,size:bytes.length};}}},authorize:async()=>true});
 const req=Readable.from([bytes]);req.headers={"content-length":String(bytes.length)};
 const result=await api.uploadAsset({req,ownerId:owner,projectId:project,originalName:"my image.png",mediaType:"image/png"});
 assert.equal(result.status,201);assert.equal(stored.ownerId,owner);assert.equal(stored.projectId,project);assert.equal(stored.mediaType,"image/png");assert.deepEqual(stored.bytes,bytes);
});
test("cloud asset upload rejects mismatched file signatures and cleans temporary data",async()=>{
 let called=false;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{async createFromFile(){called=true;}}},authorize:async()=>true});
 const req=Readable.from([Buffer.from("not-a-png")]);req.headers={"content-length":"9"};
 const result=await api.uploadAsset({req,ownerId:owner,originalName:"bad.png",mediaType:"image/png"});
 assert.equal(result.status,415);assert.equal(called,false);
});
test("cloud asset upload enforces the configured streaming byte limit",async()=>{
 let called=false;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",maxUploadBytes:8,timelineService:{timelines:{},assets:{async createFromFile(){called=true;}}},authorize:async()=>true});
 const req=Readable.from([Buffer.from([137,80,78,71,13,10,26,10,1])]);req.headers={"content-length":"9"};
 const result=await api.uploadAsset({req,ownerId:owner,originalName:"large.png",mediaType:"image/png"});
 assert.equal(result.status,413);assert.equal(called,false);
});
test("cloud asset signed read and delete delegate to the owner-aware private repository",async()=>{
 const calls=[];
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{
  async createSignedUrl(input){calls.push(["read",input]);return{asset:{id:input.assetId},url:"https://signed.example/private",expiresIn:3600};},
  async softDelete(input){calls.push(["delete",input]);return{id:input.assetId,deleted:true,storageRemoved:true,cleanupPending:false};}
 }},authorize:async()=>true});
 const read=await api.handle({method:"GET",path:"/api/cloud/assets/"+timelineId,ownerId:owner});
 assert.equal(read.status,200);assert.equal(read.body.expiresIn,3600);assert.equal(calls[0][1].expiresIn,3600);assert.equal(read.body.asset.id,timelineId);
 const deleted=await api.handle({method:"DELETE",path:"/api/cloud/assets/"+timelineId,ownerId:owner});
 assert.equal(deleted.status,200);assert.deepEqual(calls.map(call=>call[0]),["read","delete"]);
});

test("cloud project API creates and lists only identity-scoped projects",async()=>{
 const f=setup();
 const created=await f.api.handle({method:"POST",path:"/api/cloud/projects",ownerId:owner,body:{ownerId:editor,name:"Unified production"}});
 assert.equal(created.status,201);assert.equal(f.calls.find(x=>x[0]==="project-create")[1].ownerId,owner);
 const listed=await f.api.handle({method:"GET",path:"/api/cloud/projects",ownerId:owner,query:{limit:"20",offset:"0"}});
 assert.equal(listed.status,200);assert.equal(listed.body.projects[0].id,project);
});
test("cloud project API uses revision-checked update and archive",async()=>{
 const f=setup();
 assert.equal((await f.api.handle({method:"PATCH",path:"/api/cloud/projects/"+project,ownerId:owner,body:{expectedRevision:2,name:"Edited"}})).status,200);
 assert.equal((await f.api.handle({method:"DELETE",path:"/api/cloud/projects/"+project,ownerId:owner,body:{expectedRevision:2}})).status,200);
});
test("cloud asset collection returns only assets authorized for requested project",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/assets",ownerId:owner,query:{projectId:project,limit:"25"}});
 assert.equal(result.status,200);assert.equal(result.body.assets.length,1);
 assert.equal(f.calls.find(x=>x[0]==="asset-list")[1].projectId,project);
});

test("cloud timeline collection lists only the selected authorized project",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/timelines",ownerId:owner,query:{projectId:project,limit:"15"}});
 assert.equal(result.status,200);assert.equal(result.body.timelines[0].id,timelineId);
 assert.equal(f.calls.find(x=>x[0]==="timeline-list")[1].projectId,project);
});

test("cloud caption uploads persist SRT validation evidence for readiness checks",async()=>{
 const bytes=Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nOpening line\n");
 let stored=null;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{async createFromFile(input){stored={...input,bytes:await readFile(input.filePath)};return{id:"823e4567-e89b-42d3-a456-426614174000",ownerId:input.ownerId,projectId:input.projectId,name:input.originalName,mediaType:input.mediaType,size:bytes.length,metadata:input.metadata};}}},authorize:async()=>true});
 const req=Readable.from([bytes]);req.headers={"content-length":String(bytes.length)};
 const result=await api.uploadAsset({req,ownerId:owner,projectId:project,originalName:"captions.srt",mediaType:"text/plain"});
 assert.equal(result.status,201);assert.equal(stored.metadata.captionValidation.format,"srt");assert.equal(stored.metadata.captionValidation.status,"passed");
});

test("cloud media preview jobs are queued with fixed server-side proxy settings and owner scope",async()=>{
 const f=setup();
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"proxy",sourceAssetId:"attacker-controlled"},idempotencyKey:"proxy-job-0001"});
 assert.equal(result.status,202);
 assert.equal(result.body.job.job_type,"media.proxy");
 assert.equal(result.body.job.owner_id,owner);
 assert.equal(result.body.job.project_id,project);
 assert.deepEqual(result.body.job.input,{sourceAssetId:assetId,container:"mp4",videoCodec:"libx264",audioCodec:"aac",preset:"veryfast",proxyWidth:960,proxyCrf:28,proxyProfile:"timeline-preview-960p"});
 assert.ok(f.calls.some(call=>call[0]==="asset-get"&&call[1].assetId===assetId));
});
test("cloud media preview jobs reject unsupported operations and invalid idempotency",async()=>{
 const f=setup();
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 assert.equal((await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"provider.generate"},idempotencyKey:"proxy-job-0002"})).status,400);
 assert.equal((await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"proxy"},idempotencyKey:"x"})).status,400);
});
test("cloud media preview jobs require project editor authorization",async()=>{
 const f=setup({canWrite:false});
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"proxy"},idempotencyKey:"proxy-job-0003"});
 assert.equal(result.status,404);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/jobs")&&call[2].method==="POST"),false);
});

test("cloud media preview jobs reject non-video source assets",async()=>{
 const f=setup({assetMediaType:"image/png"});
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"proxy"},idempotencyKey:"proxy-job-0004"});
 assert.equal(result.status,422);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/jobs")&&call[2].method==="POST"),false);
});
test("cloud media preview jobs replay an exact idempotent request",async()=>{
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const input={sourceAssetId:assetId,container:"mp4",videoCodec:"libx264",audioCodec:"aac",preset:"veryfast",proxyWidth:960,proxyCrf:28,proxyProfile:"timeline-preview-960p"};
 const existing=[{id:"823e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"media.proxy",status:"queued",input}];
 const f=setup({existing});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"proxy"},idempotencyKey:"proxy-job-0005"});
 assert.equal(result.status,200);
 assert.equal(result.body.idempotentReplay,true);
 assert.equal(result.body.job.id,existing[0].id);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/jobs")&&call[2].method==="POST"),false);
});

test("cloud thumbnail preview jobs queue the validated source timestamp",async()=>{
 const f=setup();
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"thumbnail",seconds:12.5},idempotencyKey:"thumbnail-job-0001"});
 assert.equal(result.status,202);
 assert.equal(result.body.job.job_type,"media.thumbnail");
 assert.deepEqual(result.body.job.input,{sourceAssetId:assetId,seconds:12.5});
});
test("cloud thumbnail preview jobs reject timestamps outside the supported range",async()=>{
 const f=setup();
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/"+assetId+"/media-jobs",ownerId:owner,body:{operation:"thumbnail",seconds:3601},idempotencyKey:"thumbnail-job-0002"});
 assert.equal(result.status,400);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/jobs")&&call[2].method==="POST"),false);
});


test("cloud workflow video quote authorizes the project and returns a non-billable exact-request quote",async()=>{
 const prepared=[],preflights=[],persisted=[];
 const routerAdapter={
  async prepareInput(input,context){prepared.push({input,context});return{...input,referenceImages:[]};},
  async preflight(input){preflights.push(input);return{billable:false,estimatedCredits:275,estimatedUsd:2.75,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}
 };
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){
    const args=JSON.parse(options.body);persisted.push(args);
    return{ok:true,status:200,async text(){return JSON.stringify(args.p_quote_id);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async({ownerId,projectId,action})=>ownerId===owner&&projectId===project&&action==="write",
  runwayRouterAdapter:routerAdapter,
  env:{RUNWAY_MODEL_ROUTER_ENABLED:"false",RUNWAY_VIDEO_ALLOW_REMOTE:"false"}
 });
 const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",durationSeconds:8,aspectRatio:"16:9",resolution:"provider_default",audioMode:"generated"},inputs:[],outputs:[]};
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{projectId:project,requestId:"workflow-1:video-node:1",node,values:{prompt:"A cinematic product launch"}}});
 assert.equal(result.status,200);
 assert.equal(result.body.quote.billable,false);
 assert.equal(result.body.quote.requiresExplicitApproval,true);
 assert.equal(result.body.quote.paidExecutionEnabled,false);
 assert.equal(result.body.quote.estimatedAmount,2.75);
 assert.equal(result.body.quote.estimatedCredits,275);
 assert.equal(result.body.quote.estimatedProviderCredits,275);
 assert.equal(result.body.quote.estimatedCustomerCredits,2750);
 assert.match(result.body.quote.requestHash,/^[a-f0-9]{64}$/);
 assert.equal(prepared.length,1);
 assert.equal(prepared[0].context.job.owner_id,owner);
 assert.equal(preflights.length,1);
 assert.equal(preflights[0].operation,"text-to-video");
 assert.equal(persisted.length,1,"quote must be persisted before it is returned");
 assert.equal(persisted[0].p_owner_id,owner);
 assert.equal(persisted[0].p_project_id,project);
 assert.equal(persisted[0].p_request_hash,result.body.quote.requestHash);
 assert.equal(persisted[0].p_estimated_amount,2.75);
 assert.equal(persisted[0].p_estimated_credits,275);
 assert.equal(persisted[0].p_estimated_customer_credits,2750);
 assert.equal(persisted[0].p_pricing_source,"runway_model_router_dry_run");
 assert.equal(persisted[0].p_quote_id,result.body.quote.id);
});

test("cloud workflow approval requires confirmation, revalidates inputs and atomically queues the exact quote",async()=>{
 const calls=[],prepared=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   calls.push({url,options});
   if(url.endsWith("/rpc/approve_and_enqueue_video_workflow")){
    return{ok:true,status:200,async text(){return JSON.stringify([{
     job_id:"823e4567-e89b-42d3-a456-426614174000",job_status:"queued",
     idempotent_replay:false,budget_reservation_id:"923e4567-e89b-42d3-a456-426614174000",
     approval_id:"a23e4567-e89b-42d3-a456-426614174000"
    }]);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async({ownerId,projectId,action})=>ownerId===owner&&projectId===project&&action==="write",
  runwayRouterAdapter:{async prepareInput(input,context){prepared.push({input,context});return{...input};},async preflight(){throw new Error("approval must not call provider preflight");}},
  env:{SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service-secret",CLOUD_WORKER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.example.com",RUNWAY_MODEL_ROUTER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ROUTER_CONFIG:"studio-video",RUNWAY_API_KEY:"test-key"}
 });
 const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",durationSeconds:8,aspectRatio:"16:9",resolution:"provider_default",audioMode:"generated"},inputs:[],outputs:[]};
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:true,projectId:project,quoteId:"723e4567-e89b-42d3-a456-426614174000",
  requestId:"workflow-1:video-node:1",node,values:{prompt:"A cinematic product launch"},
  approvedMaxAmount:2.75,approvalNote:"Approved for the exact quoted video workflow"
 }});
 assert.equal(result.status,202);
 assert.equal(result.body.job.status,"queued");
 assert.equal(result.body.idempotentReplay,false);
 assert.equal(prepared.length,1);
 assert.equal(calls.length,1,"approval must use one atomic database RPC and must not call the provider");
 const rpc=calls[0];
 assert.ok(rpc.url.endsWith("/rpc/approve_and_enqueue_video_workflow"));
 const args=JSON.parse(rpc.options.body);
 assert.equal(args.p_quote_id,"723e4567-e89b-42d3-a456-426614174000");
 assert.equal(args.p_owner_id,owner);
 assert.equal(args.p_project_id,project);
 assert.equal(args.p_config_id,"studio-video");
 assert.equal(args.p_idempotency_key,"workflow-1:video-node:1");
 assert.equal(args.p_approved_max_amount,2.75);
 assert.equal(args.p_input.workflowQuoteId,args.p_quote_id);
 assert.equal(args.p_input.workflowRequestId,args.p_idempotency_key);
 assert.equal(args.p_input.requestHash,args.p_request_hash);
 assert.equal(args.p_input.approvedMaxAmount,2.75);
});

test("cloud workflow approval rejects missing explicit confirmation without database writes",async()=>{
 let writes=0;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>{writes++;return{ok:true,status:200,async text(){return"[]";}};},
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  runwayRouterAdapter:{async prepareInput(input){return input;}},
  env:{RUNWAY_MODEL_ROUTER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ROUTER_CONFIG:"studio-video",RUNWAY_API_KEY:"test-key"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:false,projectId:project,quoteId:"723e4567-e89b-42d3-a456-426614174000",
  requestId:"workflow-1:video-node:1",node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},
  values:{prompt:"A cinematic product launch"},approvedMaxAmount:2.75
 }});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"VIDEO_WORKFLOW_APPROVAL_CONFIRMATION_REQUIRED");
 assert.equal(writes,0);
});

test("cloud workflow video quote fails closed when durable persistence is unavailable",async()=>{
 let providerCalls=0;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url)=>url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")
   ?{ok:false,status:503,async text(){return JSON.stringify({message:"database unavailable"});}}
   :{ok:true,status:200,async text(){return"[]";}},
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},authorize:async()=>true,
  runwayRouterAdapter:{
   async prepareInput(input){return input;},
   async preflight(){providerCalls++;return{billable:false,estimatedCredits:100,estimatedUsd:1,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}
  }
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"workflow-1:video-node:persist-failure",
  node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},
  values:{prompt:"A cinematic launch"}
 }});
 assert.equal(result.status,503);
 assert.equal(result.body.error.code,"CLOUD_TIMELINE_API_DATABASE_ERROR");
 assert.equal(providerCalls,1,"only the non-billable dry-run may run before quote persistence");
});

test("cloud workflow video quote rejects viewers before resolving private inputs or contacting provider",async()=>{
 let prepared=0,preflight=0;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),
  timelineService:{timelines:{},assets:{}},
  authorize:async()=>false,
  runwayRouterAdapter:{
   async prepareInput(){prepared++;return{};},
   async preflight(){preflight++;return{billable:false,estimatedCredits:100,estimatedUsd:1,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}
  }
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{projectId:project,requestId:"workflow-1:video-node:1",node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},values:{prompt:"A cinematic launch"}}});
 assert.equal(result.status,404);
 assert.equal(prepared,0);
 assert.equal(preflight,0);
});

test("cloud workflow video quote fails closed for unsupported nodes and unavailable quote adapters",async()=>{
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},authorize:async()=>true
 });
 const unsupported=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{projectId:project,requestId:"workflow-1:node-1",node:{kind:"image.generate",config:{provider:"runway",model:"model-router"}},values:{prompt:"A cinematic launch"}}});
 assert.equal(unsupported.status,422);
 const unavailable=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{projectId:project,requestId:"workflow-1:node-1",node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},values:{prompt:"A cinematic launch"}}});
 assert.equal(unavailable.status,503);
});


test("cloud workflow video-to-video quote binds duration to server-probed source metadata",async()=>{
 let prepared=0,preflight=0;
 const sourceId="b23e4567-e89b-42d3-a456-426614174000";
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,
  runwaySourceResolver:{
   async resolveMetadata(){return{ownerId:owner,projectId:project,assetId:sourceId,mediaType:"video/mp4",durationSeconds:6.2};},
   async prepare(){return{};}
  },
  runwayRouterAdapter:{
   async prepareInput(){prepared++;return{};},
   async preflight(){preflight++;return{billable:false,estimatedCredits:100,estimatedUsd:1,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}
  }
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"workflow-1:video-node:2",
  node:{kind:"video.generate",config:{provider:"runway",model:"model-router",durationSeconds:5}},
  values:{prompt:"Edit this source while preserving the camera movement",sourceVideoAssetId:sourceId}
 }});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"VIDEO_SOURCE_METADATA_MISMATCH");
 assert.equal(prepared,0);
 assert.equal(preflight,0);
});


test("cloud workflow quote requires the actual project owner before provider preflight",async()=>{
 let prepared=0,preflight=0,writes=0;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>{writes++;return{ok:true,status:200,async text(){return"[]";}};},
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,
  runwayRouterAdapter:{async prepareInput(){prepared++;return{};},async preflight(){preflight++;return{billable:false,estimatedCredits:100,estimatedUsd:1,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:editor,body:{
  projectId:project,requestId:"workflow-editor-quote",
  node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},
  values:{prompt:"A cinematic product launch"}
 }});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"VIDEO_WORKFLOW_PROJECT_OWNER_REQUIRED");
 assert.equal(prepared,0);
 assert.equal(preflight,0);
 assert.equal(writes,0);
});

test("cloud workflow approval requires the actual project owner before any budget or job write",async()=>{
 let writes=0,prepared=0;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>{writes++;return{ok:true,status:200,async text(){return"[]";}};},
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,
  runwayRouterAdapter:{async prepareInput(){prepared++;return{};}},
  env:{RUNWAY_MODEL_ROUTER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ROUTER_CONFIG:"studio-video",RUNWAY_API_KEY:"test-key"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:editor,body:{
  confirmed:true,projectId:project,quoteId:"723e4567-e89b-42d3-a456-426614174000",
  requestId:"workflow-editor-approval",
  node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},
  values:{prompt:"A cinematic product launch"},approvedMaxAmount:2.75
 }});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"VIDEO_WORKFLOW_PROJECT_OWNER_REQUIRED");
 assert.equal(prepared,0);
 assert.equal(writes,0);
});


test("cloud review routes persist frame-anchored comments through verified project membership",async()=>{
 const assetId="823e4567-e89b-42d3-a456-426614174000";
 const rows=[],calls=[];
 const fetchImpl=async(url,options)=>{
  const route=url.split("/rest/v1/")[1]||"";
  calls.push({route,method:options.method,body:options.body?JSON.parse(options.body):null});
  if(route.startsWith("project_members?"))return{ok:true,status:200,async text(){return JSON.stringify([{role:"reviewer"}]);}};
  if(route.startsWith("reviews?")&&options.method==="GET"){
   const params=new URLSearchParams(route.split("?")[1]||"");
   const result=rows.filter(row=>(!params.has("id")||params.get("id")==="eq."+row.id)&&(!params.has("project_id")||params.get("project_id")==="eq."+row.project_id));
   return{ok:true,status:200,async text(){return JSON.stringify(result);}};
  }
  if(route.startsWith("reviews?")&&options.method==="POST"){
   const row={created_at:"2026-11-12T08:00:00.000Z",updated_at:"2026-11-12T08:00:00.000Z",...JSON.parse(options.body)};
   rows.push(row);return{ok:true,status:201,async text(){return JSON.stringify([row]);}};
  }
  if(route.startsWith("reviews?")&&options.method==="PATCH"){
   const idMatch=route.match(/id=eq\.([0-9a-f-]+)/),row=rows.find(item=>item.id===idMatch?.[1]);
   if(!row)return{ok:true,status:200,async text(){return"[]";}};
   Object.assign(row,JSON.parse(options.body));return{ok:true,status:200,async text(){return JSON.stringify([row]);}};
  }
  throw new Error("Unexpected review request "+options.method+" "+route);
 };
 const timelineService={
  projects:{async get(){return{id:project,ownerId:owner,name:"Review project"};}},
  assets:{async get({assetId:id}){return{id,projectId:project,mediaType:"video/mp4",name:"master.mp4",sha256:"a".repeat(64)};}},
  timelines:{async get(){return{id:timelineId,projectId:project,revision:3,timeline:{frameRate:{numerator:24,denominator:1}}};}}
 };
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"server-secret",fetchImpl,timelineService,authorize:async()=>true});
 const created=await api.handle({method:"POST",path:"/api/cloud/reviews",ownerId:editor,idempotencyKey:"review-request-0001",body:{projectId:project,assetId,timelineId,timelineRevision:3,frameNumber:48,durationFrames:24,body:"Align the title with the product edge.",decision:"request_changes"}});
 assert.equal(created.status,201);
 assert.equal(created.body.review.authorId,editor);
 assert.equal(created.body.review.frameNumber,48);
 assert.equal(created.body.review.assetSha256,"a".repeat(64));
 assert.equal(rows[0].asset_sha256,"a".repeat(64));
 assert.equal(rows[0].owner_id,owner);
 assert.equal(rows[0].reviewer_id,editor);
 assert.equal(Number(rows[0].timecode_seconds),2);
 const listed=await api.handle({method:"GET",path:"/api/cloud/reviews",ownerId:editor,query:{projectId:project}});
 assert.equal(listed.status,200);
 assert.equal(listed.body.reviews.length,1);
 const actualId=created.body.review.id;
 const resolved=await api.handle({method:"PATCH",path:"/api/cloud/reviews/"+actualId,ownerId:editor,body:{status:"resolved"}});
 assert.equal(resolved.status,200);
 assert.equal(resolved.body.review.status,"resolved");
 assert.equal(calls.some(call=>call.method==="POST"&&call.route.startsWith("reviews?")),true);
});

test("paid workflow quotes require the complete provider-aware worker launch contract", async () => {
  const complete = {
    CLOUD_WORKER_ENABLED: "true",
    CLOUD_VIDEO_WORKER_ENABLED: "true",
    VIDEO_GATEWAY_ENABLED: "true",
    VIDEO_GATEWAY_ALLOW_REMOTE: "true",
    RUNWAY_MODEL_ROUTER_ENABLED: "true",
    RUNWAY_VIDEO_ALLOW_REMOTE: "true",
    RUNWAY_VIDEO_ROUTER_CONFIG: "studio-video",
    RUNWAY_API_KEY: "test-provider-key",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    CLOUD_VIDEO_OUTPUT_HOSTS: "cdn.runwayml.com"
  };
  async function quotePaidExecutionEnabled(env) {
    const api = createCloudTimelineApi({
      url: "https://example.supabase.co",
      serviceRoleKey: "test-service-role-key",
      env,
      fetchImpl: async (url, options) => {
        if (url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")) {
          const args = JSON.parse(options.body);
          return { ok: true, status: 200, async text() { return JSON.stringify(args.p_quote_id); } };
        }
        return { ok: true, status: 200, async text() { return "[]"; } };
      },
      timelineService: { timelines: {}, assets: {}, projects: { async get() { return { id: project, ownerId: owner }; } } },
      authorize: async ({ ownerId, projectId, action }) => ownerId === owner && projectId === project && action === "write",
      runwayRouterAdapter: {
        async prepareInput(input) { return { ...input }; },
        async preflight() { return { billable: false, estimatedCredits: 100, estimatedUsd: 1, currency: "USD", provider: "runway", model: "gen4.5", configId: "studio-video" }; }
      }
    });
    const result = await api.handle({
      method: "POST",
      path: "/api/cloud/workflows/video/quote",
      ownerId: owner,
      body: {
        projectId: project,
        requestId: "worker-readiness-quote",
        node: { id: "video-node", kind: "video.generate", config: { provider: "runway", model: "model-router", durationSeconds: 5 } },
        values: { prompt: "A cinematic product launch" }
      }
    });
    assert.equal(result.status, 200);
    return result.body.quote.paidExecutionEnabled;
  }

  assert.equal(await quotePaidExecutionEnabled(complete), true);
  const neon = {
    ...complete,
    CLOUD_MEDIA_STORAGE_PROVIDER: "neon",
    NEON_STORAGE_ENDPOINT: "https://br-staging.storage.c-9.us-east-2.aws.neon.tech",
    NEON_STORAGE_REGION: "us-east-2",
    NEON_STORAGE_ACCESS_KEY_ID: "neon_test_key_123",
    NEON_STORAGE_SECRET_ACCESS_KEY: "s".repeat(40),
    NEON_STORAGE_BUCKET: "executive-visuals-media"
  };
  assert.equal(await quotePaidExecutionEnabled(neon), true, "Neon private storage must satisfy the same paid-worker launch gate");
  assert.equal(await quotePaidExecutionEnabled({ ...neon, NEON_STORAGE_SECRET_ACCESS_KEY: "" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...neon, NEON_STORAGE_ENDPOINT: "http://storage.example.test" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...neon, NEON_STORAGE_BUCKET: "public-media" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...complete, CLOUD_WORKER_ENABLED: "false" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...complete, CLOUD_VIDEO_OUTPUT_HOSTS: "" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...complete, RUNWAY_VIDEO_MODELS: "gen4.5" }), false);

});

test("cloud transformation API rejects unknown, coerced and oversized inputs before writes",async()=>{
 const f=setup();
 const valid={projectId:project,sourceAssetId:"623e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace the parked car with a red electric coupe.",durationSeconds:8,rightsConfirmed:true,subjectConsentConfirmed:false};
 const invalid=[
  [{...valid,unexpectedProviderParameter:"ignored"},"TRANSFORMATION_FIELD_UNSUPPORTED"],
  [{...valid,projectId:42},"TRANSFORMATION_INPUT_INVALID"],
  [{...valid,sourceAssetId:42},"TRANSFORMATION_INPUT_INVALID"],
  [{...valid,operation:42},"TRANSFORMATION_INPUT_INVALID"],
  [{...valid,prompt:"x".repeat(8001)},"TRANSFORMATION_INPUT_INVALID"],
  [{...valid,durationSeconds:"8"},"TRANSFORMATION_INPUT_INVALID"],
  [{...valid,referenceAssetIds:["723e4567-e89b-42d3-a456-426614174000","723e4567-e89b-42d3-a456-426614174000"]},"REFERENCE_ASSET_INVALID"],
  [{...valid,preservation:["camera_motion","camera_motion"]},"TRANSFORMATION_PRESERVATION_INVALID"]
 ];
 for(let i=0;i<invalid.length;i++){
  const result=await f.api.handle({method:"POST",path:"/api/cloud/transformations",ownerId:owner,idempotencyKey:"strict-cloud-transform-"+i,body:invalid[i][0]});
  assert.equal(result.status,400);
  assert.equal(result.body.error.code,invalid[i][1]);
 }
 assert.equal(f.calls.some(call=>call[0]==="fetch"),false,"invalid requests must not write jobs or events");
});

test("cloud transformation cancellation is authorized, idempotent and limited to pre-execution states",async()=>{
 const id="623e4567-e89b-42d3-a456-426614174000";
 const draft={id,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"draft",input:{sourceAssetId:"723e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace the parked car with a red electric coupe.",durationSeconds:8,referenceAssetIds:[],preservation:[]},created_at:"2026-11-14T00:00:00.000Z",updated_at:"2026-11-14T00:00:00.000Z"};
 const f=setup({existing:[draft]});
 const cancelled=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/cancel",ownerId:owner});
 assert.equal(cancelled.status,200);
 assert.equal(cancelled.body.plan.status,"cancelled");
 assert.equal(cancelled.body.idempotentReplay,false);
 assert.ok(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("job_events")&&JSON.parse(call[2].body).event_type==="transformation.cancelled"));
 const replay=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/cancel",ownerId:owner});
 assert.equal(replay.status,200);
 assert.equal(replay.body.idempotentReplay,true);
 assert.equal(f.calls.filter(call=>call[0]==="fetch"&&call[1].includes("/jobs?")&&call[2].method==="PATCH").length,1);
});
test("cloud transformation cancellation can revoke an approved plan before dispatch",async()=>{
 const id="823e4567-e89b-42d3-a456-426614174000";
 const approved={id,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"awaiting_approval",approved_at:"2026-11-14T00:00:00.000Z",estimated_cost:{approvalId:"approval-1",estimatedCostMicros:100,approvedBudgetMicros:100,currency:"USD",adapterId:"provider-a",capability:"video.transform"},input:{sourceAssetId:"723e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace the parked car with a red electric coupe.",durationSeconds:8,referenceAssetIds:[],preservation:[]},created_at:"2026-11-14T00:00:00.000Z",updated_at:"2026-11-14T00:00:00.000Z"};
 const f=setup({existing:[approved]});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/cancel",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.plan.status,"cancelled");
});
test("cloud transformation cancellation refuses active work and unauthorized editors",async()=>{
 const id="923e4567-e89b-42d3-a456-426614174000";
 const active={id,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"processing",input:{},created_at:"2026-11-14T00:00:00.000Z",updated_at:"2026-11-14T00:00:00.000Z"};
 const f=setup({existing:[active]});
 const conflict=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/cancel",ownerId:owner});
 assert.equal(conflict.status,409);
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[2].method==="PATCH"),false);
 const denied=setup({canWrite:false,existing:[{...active,status:"draft"}]});
 const forbidden=await denied.api.handle({method:"POST",path:"/api/cloud/transformations/"+id+"/cancel",ownerId:owner});
 assert.equal(forbidden.status,403);
 assert.equal(denied.calls.some(call=>call[0]==="fetch"&&call[2].method==="PATCH"),false);
});

const lumaFrame="b23e4567-e89b-42d3-a456-426614174000";
const lumaQuote="c23e4567-e89b-42d3-a456-426614174000";
const lumaWorkerEnv={
 CLOUD_WORKER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",
 VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
 LUMA_VIDEO_ENABLED:"true",LUMA_VIDEO_ALLOW_REMOTE:"true",
 LUMA_PROVIDER_FILES_SCHEMA_READY:"true",LUMA_AGENTS_API_KEY:"server-test-key",
 LUMA_USD_PER_CREDIT:"0.003",SUPABASE_URL:"https://example.supabase.co",
 SUPABASE_SERVICE_ROLE_KEY:"server-service-key",CLOUD_VIDEO_OUTPUT_HOSTS:"media.example.com"
};

test("Luma Ray 3.2 workflow quote validates private frame assets and records account-priced non-billable quote",async()=>{
 const writes=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"server-service-key",env:lumaWorkerEnv,
  fetchImpl:async(url,options)=>{
   const route=url.split("/rest/v1/")[1]||"";
   if(route==="rpc/record_video_workflow_quote_with_customer_credits"){
    writes.push(JSON.parse(options.body));
    return{ok:true,status:200,async text(){return JSON.stringify(JSON.parse(options.body).p_quote_id);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{
   timelines:{},projects:{async get(){return{id:project,ownerId:owner};}},
   assets:{async get({assetId}){return{id:assetId,projectId:project,ownerId:owner,mediaType:"image/png",size:4,sha256:"a".repeat(64)};}}
  },
  authorize:async()=>true
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"luma-ui-quote-001",
  node:{id:"luma-video",kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5,resolution:"720p",aspectRatio:"9:16",referenceAssetId:lumaFrame,rightsConfirmed:true}},
  values:{prompt:"Animate a cinematic city skyline"}
 }});
 assert.equal(result.status,200);
 assert.equal(result.body.quote.provider,"luma");
 assert.equal(result.body.quote.model,"ray-3.2");
 assert.equal(result.body.quote.operation,"generate");
 assert.equal(result.body.quote.estimatedCredits,100);
 assert.equal(result.body.quote.estimatedAmount,0.3);
 assert.equal(result.body.quote.pricingSource,"luma_ray32_published_credits_contract_rate");
 assert.match(result.body.quote.pricingUrl,/lumalabs\.ai/);
 assert.equal(result.body.quote.billable,false);
 assert.equal(result.body.quote.paidExecutionEnabled,true);
 assert.equal(writes.length,1);
 assert.equal(writes[0].p_config_id,"luma-ray32");
 assert.equal(writes[0].p_pricing_source,"luma_ray32_published_credits_contract_rate");
 assert.equal(writes[0].p_operation,"generate");
});

test("Luma source-video edit and reframe quotes use private metadata and operation-specific rates",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174011";
 const writes=[];
 const metadataByOperation={edit:5,reframe:9.4};
 let activeOperation="edit";
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"server-service-key",env:lumaWorkerEnv,
  runwaySourceResolver:{async resolveMetadata({ownerId,projectId,assetId}){
   return{ownerId,projectId,assetId,mediaType:"video/mp4",durationSeconds:metadataByOperation[activeOperation]};
  }},
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){
    const args=JSON.parse(options.body);writes.push(args);
    return{ok:true,status:200,async text(){return JSON.stringify(args.p_quote_id);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},projects:{async get(){return{id:project,ownerId:owner};}},assets:{}},
  authorize:async()=>true
 });
 const edit=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"luma-source-edit-quote",
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",operation:"edit",durationSeconds:5,resolution:"720p",aspectRatio:"16:9",editStrength:"flex_2",sourceVideoAssetId:sourceId,rightsConfirmed:true}},
  values:{prompt:"Replace the background while preserving motion"}
 }});
 assert.equal(edit.status,200,JSON.stringify(edit.body));
 assert.equal(edit.body.quote.operation,"video_edit");
 assert.equal(writes[0].p_operation,"video_edit");
 activeOperation="reframe";
 const reframe=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"luma-source-reframe-quote",
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",operation:"reframe",durationSeconds:10,resolution:"540p",aspectRatio:"9:16",sourceVideoAssetId:sourceId,sourcePosition:{x_norm:0,y_norm:0,w_norm:1,h_norm:1},rightsConfirmed:true}},
  values:{prompt:"Recompose for a vertical social video"}
 }});
 assert.equal(reframe.status,200,JSON.stringify(reframe.body));
 assert.equal(reframe.body.quote.operation,"video_reframe");
 assert.equal(writes[1].p_operation,"video_reframe");
 assert.ok(reframe.body.quote.estimatedCredits>0);
});
test("Luma source-video edit approval revalidates private source metadata before durable enqueue",async()=>{
 const sourceId="b23e4567-e89b-42d3-a456-426614174012";
 let metadataCalls=0,enqueueArgs=null;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"server-service-key",env:lumaWorkerEnv,
  runwaySourceResolver:{async resolveMetadata({ownerId,projectId,assetId}){
   metadataCalls++;
   return{ownerId,projectId,assetId,mediaType:"video/mp4",durationSeconds:5};
  }},
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/approve_and_enqueue_video_workflow")){
    enqueueArgs=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify([{
     job_id:"b23e4567-e89b-42d3-a456-426614174013",job_status:"queued",
     idempotent_replay:false,budget_reservation_id:"b23e4567-e89b-42d3-a456-426614174014",
     approval_id:"b23e4567-e89b-42d3-a456-426614174015"
    }]);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:true,projectId:project,quoteId:"b23e4567-e89b-42d3-a456-426614174016",
  requestId:"luma-edit-approval-1",
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",operation:"edit",durationSeconds:5,resolution:"720p",aspectRatio:"16:9",sourceVideoAssetId:sourceId,editStrength:"flex_2",rightsConfirmed:true}},
  values:{prompt:"Replace the background"},approvedMaxAmount:2,approvalNote:"Approved source-video edit"
 }});
 assert.equal(result.status,202,JSON.stringify(result.body));
 assert.equal(metadataCalls,1);
 assert.equal(enqueueArgs.p_input.operation,"edit");
 assert.equal(enqueueArgs.p_input.sourceVideoAssetId,sourceId);
 assert.equal(enqueueArgs.p_approved_max_amount,2);
});
test("Luma multi-keyframe quotes revalidate every private anchor in the exact project",async()=>{
 const checked=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"server-service-key",env:lumaWorkerEnv,
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits"))return{ok:true,status:200,async text(){return JSON.stringify(JSON.parse(options.body).p_quote_id);}};
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{
   timelines:{},projects:{async get(){return{id:project,ownerId:owner};}},
   assets:{async get({assetId}){checked.push(assetId);return{id:assetId,projectId:project,ownerId:owner,mediaType:"image/png",size:4,sha256:"a".repeat(64)};}}
  },
  authorize:async()=>true
 });
 const frameA="b23e4567-e89b-42d3-a456-426614174001";
 const frameB="b23e4567-e89b-42d3-a456-426614174002";
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"luma-keyframe-quote-001",
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5,resolution:"720p",aspectRatio:"16:9",keyframeAssetIds:[frameA,frameB],keyframeIndexes:[0,120],rightsConfirmed:true}},
  values:{prompt:"A continuous cinematic camera move"}
 }});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.deepEqual(checked,[frameA,frameB]);
 assert.equal(result.body.quote.estimatedCredits,100);
 assert.equal(result.body.quote.billable,false);
});
test("Luma quote stays blocked until schema and private frame scope are ready",async()=>{
 let writes=0;
 const makeApi=(env,assetProject=project)=>createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"server-service-key",env,
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){writes++;return{ok:true,status:200,async text(){return JSON.stringify(lumaQuote);}};}
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{
   timelines:{},projects:{async get(){return{id:project,ownerId:owner};}},
   assets:{async get({assetId}){return{id:assetId,projectId:assetProject,ownerId:owner,mediaType:"image/png",size:4,sha256:"a".repeat(64)};}}
  },authorize:async()=>true
 });
 const body={projectId:project,requestId:"luma-ui-quote-002",node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5,resolution:"720p",referenceAssetId:lumaFrame,rightsConfirmed:true}},values:{prompt:"A cinematic scene"}};
 const schemaBlocked=await makeApi({...lumaWorkerEnv,LUMA_PROVIDER_FILES_SCHEMA_READY:"false"}).handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body});
 assert.equal(schemaBlocked.status,503);
 const wrongProject=await makeApi(lumaWorkerEnv,"d23e4567-e89b-42d3-a456-426614174000").handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body});
 assert.equal(wrongProject.status,422,JSON.stringify(wrongProject.body));
 assert.equal(writes,0);
});

test("Luma approval uses the same governed quote adapter and stable config ID",async()=>{
 let approvalArgs;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"server-service-key",env:lumaWorkerEnv,
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/approve_and_enqueue_video_workflow")){
    approvalArgs=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify([{job_id:"e23e4567-e89b-42d3-a456-426614174000",job_status:"queued",idempotent_replay:false,budget_reservation_id:"f23e4567-e89b-42d3-a456-426614174000",approval_id:"a23e4567-e89b-42d3-a456-426614174000"}]);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},projects:{async get(){return{id:project,ownerId:owner};}},assets:{async get(){return null;}}},
  authorize:async()=>true
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:true,projectId:project,quoteId:lumaQuote,requestId:"luma-ui-approval-001",
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5,resolution:"720p",aspectRatio:"16:9"}},
  values:{prompt:"A cinematic product reveal"},approvedMaxAmount:0.5,approvalNote:"Approve this exact Luma generation."
 }});
 assert.equal(result.status,202);
 assert.equal(approvalArgs.p_config_id,"luma-ray32");
 assert.equal(approvalArgs.p_input.provider,"luma");
 assert.equal(approvalArgs.p_input.model,"ray-3.2");
 assert.equal(approvalArgs.p_input.operation,"generate");
 assert.equal(approvalArgs.p_input.approvedMaxAmount,0.5);
});


test("direct Seedance workflow quote uses the official list-price estimator and records the exact model",async()=>{
 const ownerId=owner,projectId=project,requestId="seedance-direct-quote-001";let persisted;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){
    persisted=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify(persisted.p_quote_id);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:projectId,ownerId};}}},
  authorize:async()=>true,
  env:{CLOUD_VIDEO_WORKER_ENABLED:"false",RUNWAY_VIDEO_ALLOW_REMOTE:"false"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId,body:{
  projectId,requestId,node:{kind:"video.generate",config:{provider:"runway",model:"seedance2_5",draft:true,durationSeconds:8,resolution:"1080p",aspectRatio:"16:9"}},
  values:{prompt:"A cinematic product reveal"}
 }});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.quote.billable,false);
 assert.equal(result.body.quote.requiresExplicitApproval,true);
 assert.equal(result.body.quote.paidExecutionEnabled,false);
 assert.equal(result.body.quote.model,"seedance2_5");
 assert.equal(result.body.quote.estimatedCredits,160);
 assert.equal(result.body.quote.estimatedAmount,1.6);
 assert.equal(persisted.p_model,"seedance2_5");
 assert.equal(persisted.p_config_id,"runway-direct-seedance2-5");
 assert.equal(persisted.p_pricing_source,"runway_direct_model_list_price");
});

test("Seedance draft enhancement quote verifies the original succeeded project job and prices 1080p",async()=>{
 const sourceDraftJobId="323e4567-e89b-42d3-a456-426614174000";
 const draftTaskId="223e4567-e89b-42d3-a456-426614174000";
 const sourceJob={
  id:sourceDraftJobId,owner_id:owner,project_id:project,job_type:"video.generate",status:"succeeded",
  created_at:new Date().toISOString(),
  input:{provider:"runway",model:"seedance2_5",operation:"text-to-video",draft:true,resolution:"480p",durationSeconds:8,aspectRatio:"16:9",audio:true},
  output:{provider:"runway",model:"seedance2_5",providerTaskId:draftTaskId,assetIds:["723e4567-e89b-42d3-a456-426614174000"]}
 };
 let quoteArgs;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(String(url).includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify([sourceJob]);}};
   if(String(url).endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){
    quoteArgs=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify(quoteArgs.p_quote_id);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,env:{CLOUD_VIDEO_WORKER_ENABLED:"false",RUNWAY_VIDEO_ALLOW_REMOTE:"false"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"seedance-enhance-quote-001",
  node:{kind:"video.generate",config:{provider:"runway",model:"seedance2_5",operation:"draft-enhancement",sourceDraftJobId}},
  values:{}
 }});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.quote.operation,"text-to-video");
 assert.equal(result.body.quote.estimatedCredits,544);
 assert.equal(quoteArgs.p_model,"seedance2_5");
 assert.equal(quoteArgs.p_operation,"text-to-video");
 assert.equal(quoteArgs.p_estimated_credits,544);
 assert.equal(quoteArgs.p_estimated_amount,5.44);
});

test("Seedance video-to-video draft enhancement quote includes the verified input-video billing duration",async()=>{
 const sourceDraftJobId="323e4567-e89b-42d3-a456-426614174000";
 const draftTaskId="223e4567-e89b-42d3-a456-426614174000";
 const sourceVideoAssetId="423e4567-e89b-42d3-a456-426614174000";
 let quoteArgs,metadataCalls=0;
 const sourceJob={
  id:sourceDraftJobId,owner_id:owner,project_id:project,job_type:"video.generate",status:"succeeded",
  created_at:new Date().toISOString(),
  input:{provider:"runway",model:"seedance2_5",operation:"video-to-video",mode:"reference",sourceVideoAssetId,draft:true,resolution:"480p",durationSeconds:8,aspectRatio:"16:9",audio:true},
  output:{provider:"runway",model:"seedance2_5",providerTaskId:draftTaskId,assetIds:["723e4567-e89b-42d3-a456-426614174000"]}
 };
 const sourceResolver={async resolveMetadata(args){metadataCalls++;return{...args,assetId:sourceVideoAssetId,mediaType:"video/mp4",durationSeconds:6,width:1920,height:1080,frameRate:30};}};
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",runwaySourceResolver:sourceResolver,
  fetchImpl:async(url,options)=>{
   if(String(url).includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify([sourceJob]);}};
   if(String(url).endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){
    quoteArgs=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify(quoteArgs.p_quote_id);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"seedance-enhance-video-quote",
  node:{kind:"video.generate",config:{provider:"runway",model:"seedance2_5",operation:"draft-enhancement",sourceDraftJobId}},
  values:{}
 }});
 assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(metadataCalls,1);
 assert.equal(quoteArgs.p_estimated_credits,748);
 assert.equal(quoteArgs.p_estimated_amount,7.48);
});

test("Seedance draft enhancement rejects a source job from another project",async()=>{
 const sourceDraftJobId="323e4567-e89b-42d3-a456-426614174000";
 const draftTaskId="223e4567-e89b-42d3-a456-426614174000";
 let databaseWrites=0;
 const sourceJob={
  id:sourceDraftJobId,owner_id:owner,project_id:editor,job_type:"video.generate",status:"succeeded",
  created_at:new Date().toISOString(),
  input:{provider:"runway",model:"seedance2_5",draft:true,resolution:"480p",durationSeconds:8,aspectRatio:"16:9",audio:true},
  output:{provider:"runway",model:"seedance2_5",providerTaskId:draftTaskId,assetIds:["723e4567-e89b-42d3-a456-426614174000"]}
 };
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(String(url).includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify([sourceJob]);}};
   databaseWrites++;
   return{ok:true,status:200,async text(){return"";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"seedance-enhance-cross-project",
  node:{kind:"video.generate",config:{provider:"runway",model:"seedance2_5",operation:"draft-enhancement",sourceDraftJobId}},
  values:{}
 }});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"SEEDANCE_DRAFT_SOURCE_INVALID");
 assert.equal(databaseWrites,0);
});

test("Seedance draft enhancement approval revalidates the source and atomically queues the 1080p follow-on",async()=>{
 const sourceDraftJobId="323e4567-e89b-42d3-a456-426614174000";
 const draftTaskId="223e4567-e89b-42d3-a456-426614174000";
 const sourceVideoAssetId="423e4567-e89b-42d3-a456-426614174000";
 let approvalArgs;
 const sourceJob={
  id:sourceDraftJobId,owner_id:owner,project_id:project,job_type:"video.generate",status:"succeeded",
  created_at:new Date().toISOString(),
  input:{provider:"runway",model:"seedance2_5",operation:"video-to-video",mode:"reference",sourceVideoAssetId,draft:true,resolution:"480p",durationSeconds:8,aspectRatio:"16:9",audio:true},
  output:{provider:"runway",model:"seedance2_5",providerTaskId:draftTaskId,assetIds:["723e4567-e89b-42d3-a456-426614174000"]}
 };
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  runwaySourceResolver:{async resolveMetadata(args){return{...args,assetId:sourceVideoAssetId,mediaType:"video/mp4",durationSeconds:6,width:1920,height:1080,frameRate:30};}},
  fetchImpl:async(url,options)=>{
   if(String(url).includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify([sourceJob]);}};
   if(String(url).endsWith("/rpc/approve_and_enqueue_video_workflow")){
    approvalArgs=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify([{
     job_id:"823e4567-e89b-42d3-a456-426614174000",job_status:"queued",idempotent_replay:false,
     budget_reservation_id:"923e4567-e89b-42d3-a456-426614174000",approval_id:"a23e4567-e89b-42d3-a456-426614174000"
    }]);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,
  env:{SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service-secret",
   CLOUD_WORKER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.example.com",
   VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",
   RUNWAY_VIDEO_MODELS:"seedance2_5",RUNWAY_API_KEY:"test-key"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:true,projectId:project,quoteId:"723e4567-e89b-42d3-a456-426614174000",requestId:"seedance-enhance-approve-001",
  node:{kind:"video.generate",config:{provider:"runway",model:"seedance2_5",operation:"draft-enhancement",sourceDraftJobId}},
  values:{},approvedMaxAmount:7.48,approvalNote:"Approve this separately priced Seedance draft enhancement."
 }});
 assert.equal(result.status,202,JSON.stringify(result.body));
 assert.equal(approvalArgs.p_input.resolution,"1080p");
 assert.equal(approvalArgs.p_input.draftTaskId,draftTaskId);
 assert.equal(approvalArgs.p_input.sourceDraftJobId,sourceDraftJobId);
 assert.equal(approvalArgs.p_input.sourceDraftVideoAssetId,sourceVideoAssetId);
 assert.equal(approvalArgs.p_input.draftEnhancement,true);
 assert.equal(approvalArgs.p_config_id,"runway-direct-seedance2-5");
});

test("direct Runway approval uses the exact worker allowlist and stable model config ID",async()=>{
 let approvalArgs;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(url.endsWith("/rpc/approve_and_enqueue_video_workflow")){
    approvalArgs=JSON.parse(options.body);
    return{ok:true,status:200,async text(){return JSON.stringify([{job_id:"e23e4567-e89b-42d3-a456-426614174000",job_status:"queued",idempotent_replay:false,budget_reservation_id:"f23e4567-e89b-42d3-a456-426614174000",approval_id:"a23e4567-e89b-42d3-a456-426614174000"}]);}};
   }
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,
  env:{SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service-secret",CLOUD_WORKER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_VIDEO_MODELS:"seedance2_5",RUNWAY_API_KEY:"test-key",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.example.com"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:true,projectId:project,quoteId:"723e4567-e89b-42d3-a456-426614174000",requestId:"seedance-direct-approve-001",
  node:{kind:"video.generate",config:{provider:"runway",model:"seedance2_5",draft:true,durationSeconds:8,resolution:"1080p",aspectRatio:"16:9"}},
  values:{prompt:"A cinematic product reveal"},approvedMaxAmount:1.6,approvalNote:"Approve this exact Seedance draft."
 }});
 assert.equal(result.status,202,JSON.stringify(result.body));
 assert.equal(approvalArgs.p_config_id,"runway-direct-seedance2-5");
 assert.equal(approvalArgs.p_input.provider,"runway");
 assert.equal(approvalArgs.p_input.model,"seedance2_5");
 assert.equal(approvalArgs.p_input.draft,true);
 assert.equal(approvalArgs.p_input.resolution,"480p");
});


test("unreleased direct Runway models are rejected by quote and approval APIs even when environment flags attempt to enable them", async () => {
  for (const model of ["kling_4_flash", "gemini_omni_flash_1.2"]) {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-secret",
      CLOUD_WORKER_ENABLED: "true",
      CLOUD_VIDEO_WORKER_ENABLED: "true",
      CLOUD_VIDEO_OUTPUT_HOSTS: "cdn.example.com",
      VIDEO_GATEWAY_ENABLED: "true",
      VIDEO_GATEWAY_ALLOW_REMOTE: "true",
      RUNWAY_VIDEO_ALLOW_REMOTE: "true",
      RUNWAY_VIDEO_MODELS: model,
      RUNWAY_API_KEY: "test-key",
      RUNWAY_MODEL_ROUTER_ENABLED: "true",
      RUNWAY_VIDEO_ROUTER_CONFIG: "studio-video"
    };
    const f = setup({ env });
    const node = { id: "video-node", kind: "video.generate", config: {
      provider: "runway", model, durationSeconds: 8, aspectRatio: "16:9",
      resolution: "provider_default", audioMode: "generated"
    }, inputs: [], outputs: [] };
    const quote = await f.api.handle({
      method: "POST", path: "/api/cloud/workflows/video/quote", ownerId: owner,
      body: { projectId: project, requestId: "blocked-quote-" + model, node, values: { prompt: "A cinematic product launch" } }
    });
    assert.equal(quote.status, 422, model);
    assert.equal(quote.body.error.code, "VIDEO_WORKFLOW_MODEL_DISABLED", model);
    assert.equal(f.calls.some(call => call[0] === "fetch" && call[1].includes("record_video_workflow_quote")), false, model);

    const approval = await f.api.handle({
      method: "POST", path: "/api/cloud/workflows/video/approve", ownerId: owner,
      body: {
        confirmed: true, projectId: project,
        quoteId: "723e4567-e89b-42d3-a456-426614174000",
        requestId: "blocked-approval-" + model, node,
        values: { prompt: "A cinematic product launch" },
        approvedMaxAmount: 2.75, approvalNote: "Test release gate"
      }
    });
    assert.equal(approval.status, 422, model);
    assert.equal(approval.body.error.code, "VIDEO_WORKFLOW_MODEL_DISABLED", model);
    assert.equal(f.calls.some(call => call[0] === "fetch" && call[1].includes("approve_and_enqueue_video_workflow")), false, model);
  }
});


test("Neon workflow approval validates the persisted exact quote before durable dispatch and consumes it after enqueue",async()=>{
 const quoteId="723e4567-e89b-42d3-a456-426614174000",requestId="workflow-neon-node-001";
 const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",durationSeconds:8,aspectRatio:"16:9",resolution:"provider_default",audioMode:"generated"},inputs:[],outputs:[]};
 const values={prompt:"A cinematic product launch"};
 const contract=createVideoWorkflowCloudRequest({node,values,projectId:project,requestId});
 const calls=[],dispatched=[];
 const expiresAt=new Date(Date.now()+60000).toISOString();
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   calls.push({url,options});
   if(url.includes("/video_workflow_quotes?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify([{
    id:quoteId,owner_id:owner,project_id:project,request_id:requestId,request_hash:contract.requestHash,
    provider:"runway",model:"model-router",operation:contract.operation,routed_provider:"runway",
    routed_model:"seedance2_5",estimated_credits:275,estimated_customer_credits:2750,estimated_amount:"2.750000",currency:"USD",
    config_id:"studio-video",pricing_source:"runway_model_router_dry_run",state:"quoted",expires_at:expiresAt
   }]);}};
   if(url.includes("/video_workflow_quotes?")&&options.method==="PATCH")return{ok:true,status:200,async text(){return"[]";}};
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async({ownerId,projectId:pid,action})=>ownerId===owner&&pid===project&&action==="write",
  runwayRouterAdapter:{async prepareInput(input){return input;},async preflight(){throw new Error("approval must not run a provider preflight");}},
  workflowNodeDispatchEnabled:()=>true,workflowNodeDispatch:async input=>{dispatched.push(input);return{status:202,body:{job:{id:"823e4567-e89b-42d3-a456-426614174000",status:"queued"},backend:"neon-postgres"}};},
  env:{SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service-secret",CLOUD_WORKER_ENABLED:"true",
   CLOUD_VIDEO_WORKER_ENABLED:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.example.com",RUNWAY_MODEL_ROUTER_ENABLED:"true",
   RUNWAY_VIDEO_ALLOW_REMOTE:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
   RUNWAY_VIDEO_ROUTER_CONFIG:"studio-video",RUNWAY_API_KEY:"test-key"}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
  confirmed:true,projectId:project,quoteId,requestId,node,values,approvedMaxAmount:3.25,
  approvalNote:"Approved for the exact quoted workflow"
 }});
 assert.equal(result.status,202);
 assert.equal(result.body.backend,"neon-postgres");
 assert.equal(dispatched.length,1);
 assert.equal(dispatched[0].requestHash,contract.requestHash);
 assert.equal(dispatched[0].estimatedAmount,2.75);
 assert.equal(dispatched[0].approvedMaxAmount,3.25);
 assert.equal(dispatched[0].expiresAt,expiresAt);
 assert.equal(calls.some(call=>call.url.endsWith("/rpc/approve_and_enqueue_video_workflow")),false);
 assert.ok(calls.some(call=>call.options.method==="PATCH"&&call.url.includes("video_workflow_quotes")));
});

test("Neon workflow approval rejects a mismatched quote and delegates expiry replay rules to the durable ledger",async()=>{
 const quoteId="723e4567-e89b-42d3-a456-426614174000",requestId="workflow-neon-node-002";
 const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",durationSeconds:8},inputs:[],outputs:[]};
 const values={prompt:"A cinematic product launch"};
 const contract=createVideoWorkflowCloudRequest({node,values,projectId:project,requestId});
 for(const quote of [
  {id:quoteId,owner_id:owner,project_id:project,request_id:requestId,request_hash:"f".repeat(64),provider:"runway",model:"model-router",operation:contract.operation,routed_provider:"runway",routed_model:"seedance2_5",estimated_credits:100,estimated_customer_credits:1000,estimated_amount:"1.000000",currency:"USD",config_id:"studio-video",pricing_source:"runway_model_router_dry_run",state:"quoted",expires_at:new Date(Date.now()+60000).toISOString()},
  {id:quoteId,owner_id:owner,project_id:project,request_id:requestId,request_hash:contract.requestHash,provider:"runway",model:"model-router",operation:contract.operation,routed_provider:"runway",routed_model:"seedance2_5",estimated_credits:100,estimated_customer_credits:1000,estimated_amount:"1.000000",currency:"USD",config_id:"studio-video",pricing_source:"runway_model_router_dry_run",state:"quoted",expires_at:new Date(Date.now()-1000).toISOString()}
 ]){
  let dispatched=0;
  const api=createCloudTimelineApi({
   url:"https://example.supabase.co",serviceRoleKey:"service-secret",
   fetchImpl:async(url)=>({ok:true,status:200,async text(){return JSON.stringify(url.includes("video_workflow_quotes")?[quote]:[]);}}),
   timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
   authorize:async()=>true,workflowNodeDispatchEnabled:()=>true,workflowNodeDispatch:async input=>{dispatched++;return Date.parse(input.expiresAt)<=Date.now()?{status:422,body:{error:{code:"VIDEO_WORKFLOW_QUOTE_EXPIRED"}}}:{status:202,body:{}};},
   runwayRouterAdapter:{async prepareInput(input){return input;}},
   env:{SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"service-secret",CLOUD_WORKER_ENABLED:"true",
    CLOUD_VIDEO_WORKER_ENABLED:"true",CLOUD_VIDEO_OUTPUT_HOSTS:"cdn.example.com",RUNWAY_MODEL_ROUTER_ENABLED:"true",
    RUNWAY_VIDEO_ALLOW_REMOTE:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",
    RUNWAY_VIDEO_ROUTER_CONFIG:"studio-video",RUNWAY_API_KEY:"test-key"}
  });
  const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:owner,body:{
   confirmed:true,projectId:project,quoteId,requestId,node,values,approvedMaxAmount:1.5
  }});
  if(quote.request_hash==="f".repeat(64)){
   assert.equal(result.status,409);
   assert.equal(dispatched,0);
  }else{
   assert.equal(result.status,422);
   assert.equal(result.body.error.code,"VIDEO_WORKFLOW_QUOTE_EXPIRED");
   assert.equal(dispatched,1);
  }
 }
});

test("cloud job status and cancellation can be served by the gated Neon workflow worker",async()=>{
 const calls=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>{calls.push("supabase-fallback");return{ok:true,status:200,async text(){return"[]";}};},
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  workflowJobLookup:async({jobId,ownerId})=>({id:jobId,owner_id:ownerId,project_id:project,job_type:"video.generate",status:"running",input:{workflowQuoteId:"723e4567-e89b-42d3-a456-426614174000"},output:null}),
  workflowJobCancel:async()=>({status:409,body:{error:{code:"VIDEO_JOB_SUBMISSION_POSSIBLE",message:"Provider submission may have started."}}})
 });
 const status=await api.handle({method:"GET",path:"/api/cloud/jobs/823e4567-e89b-42d3-a456-426614174000",ownerId:owner});
 assert.equal(status.status,200);assert.equal(status.body.job.status,"running");
 const cancelled=await api.handle({method:"POST",path:"/api/cloud/jobs/823e4567-e89b-42d3-a456-426614174000/cancel",ownerId:owner});
 assert.equal(cancelled.status,409);
 assert.deepEqual(calls,[]);
});

test("cloud workflow quote fails closed when customer-credit pricing is not configured",async()=>{
 let writes=0,preflights=0;
 const api=createCloudTimelineApi({
  quoteCustomerCredits:null,
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url)=>{if(String(url).includes("/rpc/record_video_workflow_quote_with_customer_credits"))writes++;return{ok:true,status:200,async text(){return"[]";}};},
  timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
  authorize:async()=>true,
  runwayRouterAdapter:{async prepareInput(input){return input;},async preflight(){preflights++;return{billable:false,estimatedCredits:100,estimatedUsd:1,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,body:{
  projectId:project,requestId:"workflow-credit-policy-missing",
  node:{kind:"video.generate",config:{provider:"runway",model:"model-router"}},values:{prompt:"A cinematic launch"}
 }});
 assert.equal(result.status,503);
 assert.equal(result.body.error.code,"CUSTOMER_CREDIT_PRICING_UNCONFIGURED");
 assert.equal(preflights,1);
 assert.equal(writes,0);
});

test("generation quote previews the exact personal or project-pool balance without reserving credits",async()=>{
 const cases=[
  {name:"personal wallet can cover quote",balance:{ledger_balance:5000,reserved_credits:500,available_credits:4500,funding_source:"personal",pool_status:"active"},status:"sufficient",canCover:true},
  {name:"project pool can exactly cover quote",balance:{ledger_balance:3000,reserved_credits:250,available_credits:2750,funding_source:"project_pool",pool_status:"active"},status:"sufficient",canCover:true},
  {name:"insufficient project pool",balance:{ledger_balance:1000,reserved_credits:100,available_credits:900,funding_source:"project_pool",pool_status:"active"},status:"insufficient",canCover:false},
  {name:"suspended project pool",balance:{ledger_balance:9000,reserved_credits:0,available_credits:9000,funding_source:"project_pool",pool_status:"suspended"},status:"suspended",canCover:false},
  {name:"balance service unavailable",balance:null,status:"unavailable",canCover:null}
 ];
 for(const item of cases){
  const quoteId="623e4567-e89b-42d3-a456-426614174000";
  const api=createCloudTimelineApi({
   url:"https://example.supabase.co",serviceRoleKey:"service-secret",
   fetchImpl:async(url,options)=>{
    if(url.endsWith("/rpc/get_generation_credit_balance_for_project"))
     return{ok:true,status:200,async text(){return JSON.stringify(item.balance?[item.balance]:[]);}};
    if(url.endsWith("/rpc/record_video_workflow_quote_with_customer_credits")){
     const args=JSON.parse(options.body);
     return{ok:true,status:200,async text(){return JSON.stringify(args.p_quote_id);}};
    }
    return{ok:true,status:200,async text(){return"[]";}};
   },
   timelineService:{timelines:{},assets:{},projects:{async get(){return{id:project,ownerId:owner};}}},
   authorize:async({ownerId:requestedOwner,projectId:requestedProject,action})=>requestedOwner===owner&&requestedProject===project&&action==="write",
   runwayRouterAdapter:{
    async prepareInput(input){return{...input};},
    async preflight(){return{billable:false,estimatedCredits:275,estimatedUsd:2.75,currency:"USD",provider:"runway",model:"gen4.5",configId:"studio-video"};}
   },
   env:{RUNWAY_MODEL_ROUTER_ENABLED:"false",RUNWAY_VIDEO_ALLOW_REMOTE:"false"}
  });
  const node={id:"video-node",kind:"video.generate",config:{provider:"runway",model:"model-router",durationSeconds:8,aspectRatio:"16:9",resolution:"provider_default",audioMode:"generated"},inputs:[],outputs:[]};
  const result=await api.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:owner,
   body:{projectId:project,requestId:"workflow-credit-preview-"+item.status,node,values:{prompt:"A cinematic product launch"}}});
  assert.equal(result.status,200,item.name);
  assert.equal(result.body.quote.creditAvailability.status,item.status,item.name);
  assert.equal(result.body.quote.creditAvailability.canCoverQuote,item.canCover,item.name);
  assert.equal(result.body.quote.creditAvailability.requiredCredits,2750,item.name);
  assert.equal(result.body.quote.billable,false,item.name);
  assert.equal(result.body.quote.requiresExplicitApproval,true,item.name);
  if(item.balance){
   assert.equal(result.body.quote.creditAvailability.availableCredits,item.balance.available_credits,item.name);
   assert.equal(result.body.quote.creditAvailability.fundingSource,item.balance.funding_source,item.name);
  }else{
   assert.equal(result.body.quote.creditAvailability.availableCredits,null,item.name);
  }
 }
});
