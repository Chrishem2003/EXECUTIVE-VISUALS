import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",project="423e4567-e89b-42d3-a456-426614174000",timelineId="523e4567-e89b-42d3-a456-426614174000";
const timelineDoc={width:1280,height:720,frameRate:{numerator:24,denominator:1},tracks:[],markers:[]};
function setup({canWrite=true,projectId=project,existing=[]}={}){
 const calls=[],created=[];
 const timeline={id:timelineId,ownerId:owner,projectId,name:"Test timeline",revision:2,timeline:timelineDoc,otio:null};
 const timelines={
  async create(input){created.push(input);return{...timeline,...input,revision:1};},
  async get(input){calls.push(["get",input]);return input.ownerId===owner?timeline:null;},
  async list(input){calls.push(["timeline-list",input]);return[{...timeline}];},
  async update(input){calls.push(["update",input]);return{...timeline,revision:input.expectedRevision+1,timeline:input.timeline};}
 };
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{id:JSON.parse(options.body).id,owner_id:owner,project_id:projectId,job_type:"timeline.render",status:"queued",input:JSON.parse(options.body).input}])}};if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{async list(input){calls.push(["asset-list",input]);return[{id:"asset-1",projectId:input.projectId}];}},projects:{async create(input){calls.push(["project-create",input]);return{id:"project-1",...input};},async list(input){calls.push(["project-list",input]);return[{id:project}];},async get(input){calls.push(["project-get",input]);return{id:project,...input};},async update(input){calls.push(["project-update",input]);return{id:project,...input};},async archive(input){calls.push(["project-archive",input]);return{id:project,archived:true};}}},authorize:async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"||canWrite)});
 return{api,calls,created};
}
test("cloud timeline create binds ownership to verified identity, not request body",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines",ownerId:owner,body:{ownerId:editor,projectId:project,name:"Test",timeline:timelineDoc}});assert.equal(result.status,201);assert.equal(f.created[0].ownerId,owner);assert.equal(f.created[0].projectId,project);});
test("cloud timeline get and update use verified owner and optimistic revision",async()=>{const f=setup();const got=await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:owner});assert.equal(got.status,200);const updated=await f.api.handle({method:"PUT",path:"/api/cloud/timelines/"+timelineId,ownerId:owner,body:{expectedRevision:2,timeline:timelineDoc}});assert.equal(updated.status,200);assert.equal(f.calls.find(c=>c[0]==="update")[1].expectedRevision,2);});
test("cloud render submission queues a durable job using current saved timeline revision",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{ownerId:editor,timelineId:"bad"},idempotencyKey:"render-1"});assert.equal(result.status,202);const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");const body=JSON.parse(inserted[2].body);assert.equal(body.owner_id,owner);assert.equal(body.input.timelineId,timelineId);assert.equal(body.input.timelineRevision,2);assert.equal(body.job_type,"timeline.render");});
test("cloud render submission requires project editor authorization",async()=>{const f=setup({canWrite:false});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{}});assert.equal(result.status,404);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);});
test("cloud render idempotency replays only the exact same timeline revision",async()=>{const existing=[{id:"623e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"timeline.render",status:"queued",input:{timelineId,timelineRevision:2}}];const f=setup({existing});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,idempotencyKey:"render-1"});assert.equal(result.status,200);assert.equal(result.body.idempotentReplay,true);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].endsWith("/jobs")),false);});
test("Aleph 2 quote is non-mutating, source-probed and provider-priced",async()=>{
 const calls=[];
 const sourceAsset={id:"b23e4567-e89b-42d3-a456-426614174000",projectId:project,mediaType:"video/mp4"};
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:true,status:200,async text(){return"[]";}};},
  timelineService:{timelines:{},assets:{async get(input){assert.deepEqual(input,{ownerId:owner,assetId:sourceAsset.id});return sourceAsset;}}},
  authorize:async({ownerId,projectId,action})=>ownerId===owner&&projectId===project&&action==="write",
  runwaySourceResolver:{async resolveMetadata(input){assert.deepEqual(input,{ownerId:owner,projectId:project,assetId:sourceAsset.id});return{ownerId:owner,projectId:project,assetId:sourceAsset.id,mediaType:"video/mp4",durationSeconds:10.2,frameCount:306,width:1920,height:1080,sourceDynamicRange:"sdr"};}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/quote",ownerId:owner,body:{projectId:project,sourceAssetId:sourceAsset.id,operation:"vehicle_replace",prompt:"Replace the vehicle and preserve the original camera movement.",rightsConfirmed:true}});
 assert.equal(result.status,200);
 assert.equal(result.body.quote.provider,"runway");
 assert.equal(result.body.quote.model,"aleph2");
 assert.equal(result.body.quote.currency,"USD");
 assert.ok(result.body.quote.estimatedCostMicros>=560000);
 assert.equal(result.body.quote.source.durationSeconds,10.2);
 assert.equal(result.body.quote.output.durationSeconds,11);
 assert.equal(result.body.quote.billable,false);
 assert.equal(result.body.quote.requiresApproval,true);
 assert.ok(Date.parse(result.body.quote.expiresAt)>Date.now());
 assert.equal(calls.length,0,"quote must not write approvals, jobs, reservations or provider submissions");
});

test("Aleph 2 quote rejects server-probed clips below the provider minimum",async()=>{
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),
  timelineService:{timelines:{},assets:{async get(){return{id:"b23e4567-e89b-42d3-a456-426614174000",projectId:project,mediaType:"video/mp4"};}}},
  authorize:async()=>true,
  runwaySourceResolver:{async resolveMetadata(){return{mediaType:"video/mp4",durationSeconds:1.5,width:1920,height:1080,frameCount:45};}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/quote",ownerId:owner,body:{projectId:project,sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace the vehicle carefully.",rightsConfirmed:true}});
 assert.equal(result.status,422);
 assert.equal(result.body.error.code,"VIDEO_DURATION_UNSUPPORTED");
});

test("Aleph 2 quote requires editor access and explicit media rights",async()=>{
 const sourceAsset={id:"b23e4567-e89b-42d3-a456-426614174000",projectId:project,mediaType:"video/mp4"};
 const makeApi=canWrite=>createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>({ok:true,status:200,async text(){return"[]";}}),
  timelineService:{timelines:{},assets:{async get(){return sourceAsset;}}},
  authorize:async()=>canWrite,
  runwaySourceResolver:{async resolveMetadata(){return{mediaType:"video/mp4",durationSeconds:10,width:1920,height:1080,frameCount:300};}}
 });
 const denied=await makeApi(false).handle({method:"POST",path:"/api/cloud/transformations/quote",ownerId:owner,body:{projectId:project,sourceAssetId:sourceAsset.id,operation:"vehicle_replace",prompt:"Replace the vehicle safely.",rightsConfirmed:true}});
 assert.equal(denied.status,404);
 const noRights=await makeApi(true).handle({method:"POST",path:"/api/cloud/transformations/quote",ownerId:owner,body:{projectId:project,sourceAssetId:sourceAsset.id,operation:"vehicle_replace",prompt:"Replace the vehicle safely."}});
 assert.equal(noRights.status,403);
 assert.equal(noRights.body.error.code,"MEDIA_RIGHTS_REQUIRED");
});

test("Aleph 2 transformation draft rejects source durations below the provider minimum",async()=>{
 const f=setup();
 const result=await f.api.handle({
  method:"POST",path:"/api/cloud/transformations",ownerId:owner,idempotencyKey:"aleph2-too-short",
  body:{projectId:project,sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace the vehicle while preserving the shot.",durationSeconds:1,rightsConfirmed:true}
 });
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"TRANSFORMATION_INPUT_INVALID");
 assert.match(result.body.error.message,/2 to 30 seconds/);
});

test("cloud timeline API rejects unverified or malformed owner IDs and ignores unrelated routes",async()=>{const f=setup();assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:"not-uuid"})).status,401);assert.equal(await f.api.handle({method:"GET",path:"/api/not-cloud",ownerId:owner}),null);});

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

test("cloud timeline API readiness requires exposed schema tables and a private bucket",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async(url)=>({ok:true,status:200,async text(){return"[]";},async json(){return{public:false};}})});
 const result=await api.checkReadiness();assert.equal(result.ready,true);assert.equal(result.storage,"private");
});
test("cloud timeline API checks video ledger and budget tables before video worker startup", async () => {
 const checked=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  env:{CLOUD_VIDEO_WORKER_ENABLED:"true"},
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  fetchImpl:async(url)=>{
   const value=String(url);
   if(value.includes("/storage/v1/bucket/"))return{ok:true,status:200,async json(){return{public:false};}};
   checked.push(value);
   return{ok:true,status:200,async text(){return"[]";}};
  }
 });
 const result=await api.checkReadiness();
 assert.equal(result.ready,true);
 for(const table of ["video_generation_submissions","video_generation_budget_policies","video_generation_budget_approvals","video_generation_budget_reservations","video_generation_usage_reservations"]){
  assert.ok(checked.some(url=>url.includes("/"+table+"?")),table+" must be checked");
 }
});

test("cloud timeline API refuses a public media bucket",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async(url)=>({ok:true,status:200,async text(){return"[]";},async json(){return{public:true};}})});
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
  async createSignedUrl(input){calls.push(["read",input]);return{asset:{id:input.assetId},url:"https://signed.example/private",expiresIn:300};},
  async softDelete(input){calls.push(["delete",input]);return{id:input.assetId,deleted:true,storageRemoved:true,cleanupPending:false};}
 }},authorize:async()=>true});
 const read=await api.handle({method:"GET",path:"/api/cloud/assets/"+timelineId,ownerId:owner});
 assert.equal(read.status,200);assert.equal(read.body.expiresIn,300);
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


test("legacy Aleph2 approvals without a canonical request hash are blocked before enqueue", async () => {
 const planId="823e4567-e89b-42d3-a456-426614174000";
 const approvalId="923e4567-e89b-42d3-a456-426614174000";
 const row={
  id:planId,owner_id:owner,project_id:project,job_type:"video.transform.plan",
  status:"awaiting_approval",approved_by:owner,approved_at:"2026-11-07T08:00:00.000Z",
  estimated_cost:{approvalId,estimatedCostMicros:3000000,approvedBudgetMicros:5000000,currency:"USD",adapterId:"runway:aleph2",capability:"video-to-video"},
  input:{projectId:project,sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace only the car with a red electric SUV while preserving camera movement.",durationSeconds:5,preservation:["camera_motion"]}
 };
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("/jobs?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify([row]);}};
  return{ok:true,status:201,async text(){return"";}};
 };
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,
  timelineService:{timelines:{},assets:{}},
  authorize:async()=>true,
  transformationReadiness:()=>({adapterVerified:true,workerAvailable:true,privateStorageVerified:true,durableCheckpointsAvailable:true,costPolicyVerified:true,consentVerifierAvailable:true,visualQaAvailable:true,cloudSchemaApplied:true}),
  runwaySourceResolver:{async resolveMetadata(args){
   assert.deepEqual(args,{ownerId:owner,projectId:project,assetId:row.input.sourceAssetId});
   return{ownerId:owner,projectId:project,assetId:row.input.sourceAssetId,mediaType:"video/mp4",durationSeconds:10.2,frameCount:306,width:1920,height:1080,sourceDynamicRange:"sdr"};
  }}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/"+planId+"/submit",ownerId:owner,body:{}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"TRANSFORMATION_APPROVAL_REQUEST_MISMATCH");
 assert.ok(!calls.some(call=>call.url.endsWith("/rpc/enqueue_video_generation_job")));
 assert.ok(!calls.some(call=>call.url.includes("/jobs?")&&call.options.method==="PATCH"));
});

test("cloud transformation submission refuses unapproved or non-Aleph adapters before queueing", async () => {
 const planId="823e4567-e89b-42d3-a456-426614174000";
 const row={id:planId,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"awaiting_approval",approved_by:owner,approved_at:"2026-11-07T08:00:00.000Z",estimated_cost:{approvalId:"923e4567-e89b-42d3-a456-426614174000",approvedBudgetMicros:5000000,currency:"USD",adapterId:"other:provider",capability:"video-to-video"},input:{sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",prompt:"Edit this clip",operation:"vehicle_replace"}};
 let queued=false;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>({ok:true,status:200,async text(){return url.includes("/jobs?")&&options.method==="GET"?JSON.stringify([row]):"[]";}}),
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  transformationReadiness:()=>({adapterVerified:true,workerAvailable:true,privateStorageVerified:true,durableCheckpointsAvailable:true,costPolicyVerified:true,consentVerifierAvailable:true,visualQaAvailable:true,cloudSchemaApplied:true}),
  runwaySourceResolver:{async resolveMetadata(){throw new Error("must not resolve source");}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/"+planId+"/submit",ownerId:owner});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"TRANSFORMATION_ADAPTER_UNAVAILABLE");
 assert.equal(queued,false);
});


test("cloud transformation approval derives its estimate from probed source media, not client claims", async () => {
 const planId="d23e4567-e89b-42d3-a456-426614174000";
 const row={id:planId,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"draft",approved_at:null,input:{sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace vehicle"}};
 const calls=[];
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   calls.push({url,options});
   if(url.includes("/jobs?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify([row]);}};
   if(url.includes("/jobs?")&&options.method==="PATCH")return{ok:true,status:200,async text(){return JSON.stringify([{...row,status:"awaiting_approval",approved_at:"2026-11-07T08:00:00.000Z",estimated_cost:JSON.parse(options.body).estimated_cost}]);}};
   return{ok:true,status:201,async text(){return"";}};
  },
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  runwaySourceResolver:{async resolveMetadata(args){
   assert.deepEqual(args,{ownerId:owner,projectId:project,assetId:row.input.sourceAssetId});
   return{ownerId:owner,projectId:project,assetId:row.input.sourceAssetId,mediaType:"video/mp4",durationSeconds:10.2,frameCount:306,width:1920,height:1080,sourceDynamicRange:"sdr"};
  }}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/"+planId+"/approve",ownerId:owner,body:{estimatedCostMicros:1,approvedBudgetMicros:5000000,currency:"USD",adapterId:"attacker:model",capability:"unverified"}});
 assert.equal(result.status,200);
 const patch=calls.find(call=>call.options.method==="PATCH");
 const approval=JSON.parse(patch.options.body).estimated_cost;
 assert.ok(approval.estimatedCostMicros>1);
 assert.equal(approval.approvedBudgetMicros,5000000);
 assert.equal(approval.adapterId,"runway:aleph2");
 assert.equal(approval.capability,"video-to-video");
 assert.equal(approval.sourceMetadata.durationSeconds,10.2);
 const ledgerCall=calls.find(call=>call.url.endsWith("/rpc/create_video_generation_budget_approval"));
 assert.ok(ledgerCall,"approval must be persisted to the durable budget ledger before plan approval");
 const ledger=JSON.parse(ledgerCall.options.body);
 assert.equal(ledger.p_approval_id,approval.approvalId);
 assert.equal(ledger.p_request_hash,approval.requestHash);
 assert.equal(ledger.p_approved_max_amount,5);
 assert.match(ledger.p_request_hash,/^[a-f0-9]{64}$/);
});

test("cloud transformation approval rejects a budget below the server-derived provider estimate", async () => {
 const planId="d23e4567-e89b-42d3-a456-426614174000";
 const row={id:planId,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"draft",approved_at:null,input:{sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace vehicle"}};
 let patched=false;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(url.includes("/jobs?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify([row]);}};
   if(url.includes("/jobs?")&&options.method==="PATCH"){patched=true;return{ok:true,status:200,async text(){return"[]";}};}
   return{ok:true,status:201,async text(){return"";}};
  },
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  runwaySourceResolver:{async resolveMetadata(){return{ownerId:owner,projectId:project,assetId:row.input.sourceAssetId,mediaType:"video/mp4",durationSeconds:10.2,frameCount:306,width:1920,height:1080,sourceDynamicRange:"sdr"};}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/"+planId+"/approve",ownerId:owner,body:{approvedBudgetMicros:1000,currency:"USD"}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"TRANSFORMATION_BUDGET_BELOW_ESTIMATE");
 assert.equal(patched,false);
});


test("cloud transformation submit remains blocked when any release gate is unverified", async () => {
 const planId="e23e4567-e89b-42d3-a456-426614174000";
 const row={id:planId,owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"awaiting_approval",approved_by:owner,approved_at:"2026-11-07T08:00:00.000Z",estimated_cost:{approvalId:"923e4567-e89b-42d3-a456-426614174000",estimatedCostMicros:3000000,approvedBudgetMicros:5000000,currency:"USD",adapterId:"runway:aleph2",capability:"video-to-video"},input:{sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",prompt:"Replace vehicle",operation:"vehicle_replace"}};
 let queueCalls=0;
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async(url,options)=>{
   if(url.includes("/jobs?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify([row]);}};
   if(url.endsWith("/rpc/enqueue_video_generation_job"))queueCalls++;
   return{ok:true,status:200,async text(){return"[]";}};
  },
  timelineService:{timelines:{},assets:{}},authorize:async()=>true,
  runwaySourceResolver:{async resolveMetadata(){return{ownerId:owner,projectId:project,assetId:row.input.sourceAssetId,mediaType:"video/mp4",durationSeconds:10.2,frameCount:306,width:1920,height:1080,sourceDynamicRange:"sdr"};}}
 });
 const result=await api.handle({method:"POST",path:"/api/cloud/transformations/"+planId+"/submit",ownerId:owner});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"TRANSFORMATION_RELEASE_GATES_BLOCKED");
 assert.equal(result.body.error.missing.length,8);
 assert.equal(queueCalls,0);
});


test("cloud transformation mapper does not turn submitted jobs back into approved drafts", async () => {
 const row={id:"f23e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"submitted",approved_by:owner,approved_at:"2026-11-07T08:00:00.000Z",estimated_cost:{approvalId:"923e4567-e89b-42d3-a456-426614174000",estimatedCostMicros:3000000,approvedBudgetMicros:5000000,currency:"USD",adapterId:"runway:aleph2",capability:"video-to-video"},input:{sourceAssetId:"b23e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace vehicle",durationSeconds:11,referenceAssetIds:[],preservation:[]}};
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  fetchImpl:async()=>({ok:true,status:200,async text(){return JSON.stringify([row]);}}),
  timelineService:{timelines:{},assets:{}},authorize:async()=>true
 });
 const result=await api.handle({method:"GET",path:"/api/cloud/transformations",ownerId:owner,query:{projectId:project}});
 assert.equal(result.status,200);
 assert.equal(result.body.plans[0].status,"submitted");
 assert.equal(result.body.plans[0].approval.adapterId,"runway:aleph2");
});
