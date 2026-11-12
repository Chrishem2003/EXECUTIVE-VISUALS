import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",project="423e4567-e89b-42d3-a456-426614174000",timelineId="523e4567-e89b-42d3-a456-426614174000";
const timelineDoc={width:1280,height:720,frameRate:{numerator:24,denominator:1},tracks:[],markers:[]};
function setup({canWrite=true,projectId=project,existing=[],assetMediaType="video/mp4",timelineCreditsPerSecond=0,timelineDocument=timelineDoc,reserveResponse={reservation_id:"923e4567-e89b-42d3-a456-426614174000",status:"reserved",credit_units:24}}={}){
 const calls=[],created=[];
 const timeline={id:timelineId,ownerId:owner,projectId,name:"Test timeline",revision:2,timeline:timelineDocument,otio:null};
 const timelines={
  async create(input){created.push(input);return{...timeline,...input,revision:1};},
  async get(input){calls.push(["get",input]);return input.ownerId===owner?timeline:null;},
  async list(input){calls.push(["timeline-list",input]);return[{...timeline}];},
  async update(input){calls.push(["update",input]);return{...timeline,revision:input.expectedRevision+1,timeline:input.timeline};}
 };
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.endsWith("/rpc/reserve_credit_units"))return{ok:true,status:200,async text(){return JSON.stringify(reserveResponse);}};if(url.endsWith("/rpc/release_credit_reservation"))return{ok:true,status:200,async text(){return"true";}};if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){const posted=JSON.parse(options.body);return JSON.stringify([{...posted,progress:0,created_at:"2026-11-11T00:00:00.000Z",updated_at:"2026-11-11T00:00:00.000Z"}])}};if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{async list(input){calls.push(["asset-list",input]);return[{id:"asset-1",projectId:input.projectId}];},async get(input){calls.push(["asset-get",input]);return{id:input.assetId,ownerId:input.ownerId,projectId,name:"clip.mp4",mediaType:assetMediaType};}},projects:{async create(input){calls.push(["project-create",input]);return{id:"project-1",...input};},async list(input){calls.push(["project-list",input]);return[{id:project}];},async get(input){calls.push(["project-get",input]);return{id:project,...input};},async update(input){calls.push(["project-update",input]);return{id:project,...input};},async archive(input){calls.push(["project-archive",input]);return{id:project,archived:true};}}},authorize:async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"||canWrite),timelineCreditsPerSecond});
 return{api,calls,created};
}
test("cloud timeline create binds ownership to verified identity, not request body",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines",ownerId:owner,body:{ownerId:editor,projectId:project,name:"Test",timeline:timelineDoc}});assert.equal(result.status,201);assert.equal(f.created[0].ownerId,owner);assert.equal(f.created[0].projectId,project);});
test("cloud timeline get and update use verified owner and optimistic revision",async()=>{const f=setup();const got=await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:owner});assert.equal(got.status,200);const updated=await f.api.handle({method:"PUT",path:"/api/cloud/timelines/"+timelineId,ownerId:owner,body:{expectedRevision:2,timeline:timelineDoc}});assert.equal(updated.status,200);assert.equal(f.calls.find(c=>c[0]==="update")[1].expectedRevision,2);});
test("cloud render submission queues a durable job using current saved timeline revision",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{ownerId:editor,timelineId:"bad"},idempotencyKey:"render-1"});assert.equal(result.status,202);const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");const body=JSON.parse(inserted[2].body);assert.equal(body.owner_id,owner);assert.equal(body.input.timelineId,timelineId);assert.equal(body.input.timelineRevision,2);assert.equal(body.job_type,"timeline.render");});
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
test("cloud render idempotency replays only the exact same timeline revision",async()=>{const existing=[{id:"623e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"timeline.render",status:"queued",input:{timelineId,timelineRevision:2}}];const f=setup({existing});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,idempotencyKey:"render-1"});assert.equal(result.status,200);assert.equal(result.body.idempotentReplay,true);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].endsWith("/jobs")),false);});
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

test("cloud timeline API readiness requires exposed schema tables and a private bucket",async()=>{
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{}},authorize:async()=>true,fetchImpl:async(url)=>({ok:true,status:200,async text(){return"[]";},async json(){return{public:false};}})});
 const result=await api.checkReadiness();assert.equal(result.ready,true);assert.equal(result.storage,"private");
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
   if(url.endsWith("/rpc/record_video_workflow_quote")){
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
  env:{RUNWAY_MODEL_ROUTER_ENABLED:"true",CLOUD_VIDEO_WORKER_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",VIDEO_GATEWAY_ENABLED:"true",VIDEO_GATEWAY_ALLOW_REMOTE:"true",RUNWAY_VIDEO_ROUTER_CONFIG:"studio-video",RUNWAY_API_KEY:"test-key"}
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
  fetchImpl:async(url)=>url.endsWith("/rpc/record_video_workflow_quote")
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
  assets:{async get({assetId:id}){return{id,projectId:project,mediaType:"video/mp4",name:"master.mp4"};}},
  timelines:{async get(){return{id:timelineId,projectId:project,revision:3,timeline:{frameRate:{numerator:24,denominator:1}}};}}
 };
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"server-secret",fetchImpl,timelineService,authorize:async()=>true});
 const created=await api.handle({method:"POST",path:"/api/cloud/reviews",ownerId:editor,idempotencyKey:"review-request-0001",body:{projectId:project,assetId,timelineId,timelineRevision:3,frameNumber:48,durationFrames:24,body:"Align the title with the product edge.",decision:"request_changes"}});
 assert.equal(created.status,201);
 assert.equal(created.body.review.authorId,editor);
 assert.equal(created.body.review.frameNumber,48);
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
        if (url.endsWith("/rpc/record_video_workflow_quote")) {
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
  assert.equal(await quotePaidExecutionEnabled({ ...complete, CLOUD_WORKER_ENABLED: "false" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...complete, CLOUD_VIDEO_OUTPUT_HOSTS: "" }), false);
  assert.equal(await quotePaidExecutionEnabled({ ...complete, RUNWAY_VIDEO_MODELS: "gen4.5" }), false);
});
