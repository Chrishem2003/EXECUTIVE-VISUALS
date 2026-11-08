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


function mediaJobApi({asset={id:"823e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"scene.mp4",mediaType:"video/mp4",size:100,sha256:"a".repeat(64)},canWrite=true,existing=[]}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("/jobs?")&&options.method==="GET")return{ok:true,status:200,async text(){return JSON.stringify(existing);}};
  if(url.includes("/jobs?")&&options.method==="POST"){
   const body=JSON.parse(options.body);
   return{ok:true,status:201,async text(){return JSON.stringify([{...body,created_at:"2026-11-08T00:00:00.000Z"}]);}};
  }
  return{ok:true,status:201,async text(){return"[]";}};
 };
 const api=createCloudTimelineApi({
  url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,
  timelineService:{timelines:{},assets:{async get(input){calls.push({assetGet:input});return asset;}}},
  authorize:async input=>input.ownerId===owner&&(!input.projectId||input.projectId===project)&&(input.action==="read"||canWrite)
 });
 return{api,calls};
}

test("Asset Library cloud media job endpoint enqueues an authorized lease-scoped job with idempotency",async()=>{
 const f=mediaJobApi();
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/823e4567-e89b-42d3-a456-426614174000/media-jobs",ownerId:owner,idempotencyKey:"media-color-001",body:{jobType:"media.color",options:{brightness:0.1,contrast:1.1,saturation:0.9,owner_id:editor}}});
 assert.equal(result.status,400,"caller-controlled identity fields must be rejected");
 assert.equal(f.calls.some(call=>call.options?.method==="POST"),false);
 const accepted=await f.api.handle({method:"POST",path:"/api/cloud/assets/823e4567-e89b-42d3-a456-426614174000/media-jobs",ownerId:owner,idempotencyKey:"media-color-002",body:{jobType:"media.color",options:{brightness:0.1,contrast:1.1,saturation:0.9}}});
 assert.equal(accepted.status,202);
 assert.equal(accepted.body.job.owner_id,undefined,"job receipt is the database representation and should not synthesize caller identity");
 const created=JSON.parse(f.calls.find(call=>call.url.includes("/jobs?")&&call.options.method==="POST").options.body);
 assert.equal(created.owner_id,owner);
 assert.equal(created.project_id,project);
 assert.equal(created.job_type,"media.color");
 assert.deepEqual(created.input,{sourceAssetId:"823e4567-e89b-42d3-a456-426614174000",brightness:0.1,contrast:1.1,saturation:0.9});
 assert.equal(created.status,"queued");
 assert.equal(f.calls.some(call=>call.url.includes("job_events")),true);
});

test("Asset Library media jobs enforce editor access, media compatibility and operation option schemas",async()=>{
 const denied=mediaJobApi({canWrite:false});
 const path="/api/cloud/assets/823e4567-e89b-42d3-a456-426614174000/media-jobs";
 const forbidden=await denied.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-denied-1",body:{jobType:"media.color"}});
 assert.equal(forbidden.status,403);
 assert.equal(denied.calls.some(call=>call.options?.method==="POST"),false);
 const image=mediaJobApi({asset:{id:"823e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,mediaType:"image/png"}});
 const unsupported=await image.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-type-01",body:{jobType:"media.color"}});
 assert.equal(unsupported.status,415);
 const invalid=await image.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-option-1",body:{jobType:"media.ai-upscale",options:{format:"exe"}}});
 assert.equal(invalid.status,400);
 assert.equal(image.calls.some(call=>call.options?.method==="POST"),false);
});

test("Asset Library media job idempotency replays identical requests and rejects key reuse",async()=>{
 const input={sourceAssetId:"823e4567-e89b-42d3-a456-426614174000",brightness:0.2};
 const row={id:"923e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"media.color",status:"queued",input};
 const replay=mediaJobApi({existing:[row]});
 const same=await replay.api.handle({method:"POST",path:"/api/cloud/assets/823e4567-e89b-42d3-a456-426614174000/media-jobs",ownerId:owner,idempotencyKey:"media-replay-1",body:{jobType:"media.color",options:{brightness:0.2}}});
 assert.equal(same.status,200);
 assert.equal(same.body.idempotentReplay,true);
 const conflict=await replay.api.handle({method:"POST",path:"/api/cloud/assets/823e4567-e89b-42d3-a456-426614174000/media-jobs",ownerId:owner,idempotencyKey:"media-replay-1",body:{jobType:"media.color",options:{brightness:0.4}}});
 assert.equal(conflict.status,409);
});

test("Asset Library cloud media jobs require idempotency keys and reject unknown operations",async()=>{
 const f=mediaJobApi();
 const path="/api/cloud/assets/823e4567-e89b-42d3-a456-426614174000/media-jobs";
 const missing=await f.api.handle({method:"POST",path,ownerId:owner,body:{jobType:"media.probe"}});
 assert.equal(missing.status,400);
 const unknown=await f.api.handle({method:"POST",path,ownerId:owner,idempotencyKey:"media-unknown",body:{jobType:"shell.exec"}});
 assert.equal(unknown.status,400);
});
