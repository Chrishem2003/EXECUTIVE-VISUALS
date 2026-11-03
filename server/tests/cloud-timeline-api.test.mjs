import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";
import { createDeliveryManifest, verifyDeliveryPackage } from "../delivery-manifest.mjs";
import { createRenderManifest } from "../render-manifest.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",project="423e4567-e89b-42d3-a456-426614174000",timelineId="523e4567-e89b-42d3-a456-426614174000";
const timelineDoc={width:1280,height:720,frameRate:{numerator:24,denominator:1},tracks:[],markers:[]};
function setup({canWrite=true,projectId=project,existing=[],timelineDocOverride=timelineDoc,assetOverride=null,signedAssetOverride=null,authorizeOverride=null,duplicateReview=false}={}){
 const calls=[],created=[];
 const timeline={id:timelineId,ownerId:owner,projectId,name:"Test timeline",revision:2,timeline:timelineDocOverride,otio:null};
 const timelines={
  async create(input){created.push(input);return{...timeline,...input,revision:1};},
  async get(input){calls.push(["get",input]);return input.ownerId===owner?timeline:null;},
  async list(input){calls.push(["timeline-list",input]);return[{...timeline}];},
  async update(input){calls.push(["update",input]);return{...timeline,revision:input.expectedRevision+1,timeline:input.timeline};}
 };
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.includes("/job_events")&&options.method==="POST"&&duplicateReview)return{ok:false,status:409,async text(){return JSON.stringify({code:"23505",message:"duplicate key"})}};if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{id:JSON.parse(options.body).id,owner_id:owner,project_id:projectId,job_type:JSON.parse(options.body).job_type,status:"queued",input:JSON.parse(options.body).input}])}};if(url.includes("/jobs?")&&options.method==="PATCH"){const row=existing.find(item=>url.includes("id=eq."+item.id));if(!row)return{ok:true,status:200,async text(){return"[]"}};Object.assign(row,JSON.parse(options.body));return{ok:true,status:200,async text(){return JSON.stringify([row])}};}if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{async list(input){calls.push(["asset-list",input]);return[{id:"asset-1",projectId:input.projectId}];},async retryCleanup(input){calls.push(["asset-cleanup-retry",input]);return{id:input.assetId,deleted:true,storageRemoved:true,cleanupPending:false};},async get(input){calls.push(["asset-get",input]);if(input.assetId==="published-asset")return assetOverride||{id:"published-asset",ownerId:owner,projectId:project,name:"master.mp4",mediaType:"video/mp4",size:2048,sha256:"a".repeat(64),metadata:{}};return assetOverride||{id:"723e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"generated.mp4",mediaType:"video/mp4",sha256:"a".repeat(64),metadata:{generated:true,jobId:"823e4567-e89b-42d3-a456-426614174000",mediaVerification:{status:"passed",readable:true,sha256:"a".repeat(64)},probe:{format:{duration:"2.51"},streams:[{codec_type:"video"}]}}};},async createSignedUrl(input){calls.push(["signed-url",input]);return{asset:signedAssetOverride||{id:input.assetId,projectId:project,size:2048,sha256:"a".repeat(64)},url:"https://storage.example.test/private/master?token=short-lived"};},async createFromFile(input){calls.push(["asset-create-from-file",input]);return{id:"923e4567-e89b-42d3-a456-426614174000",ownerId:input.ownerId,projectId:input.projectId,name:input.originalName,mediaType:input.mediaType,size:4,sha256:"a".repeat(64)};},async softDelete(input){calls.push(["asset-soft-delete",input]);return{id:input.assetId,deleted:true};}},projects:{async create(input){calls.push(["project-create",input]);return{id:"project-1",...input};},async list(input){calls.push(["project-list",input]);return[{id:project}];},async get(input){calls.push(["project-get",input]);return{id:project,...input};},async update(input){calls.push(["project-update",input]);return{id:project,...input};},async archive(input){calls.push(["project-archive",input]);return{id:project,archived:true};}}},authorize:authorizeOverride|| (async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"||canWrite))});
 return{api,calls,created};
}

const reviewJobId="623e4567-e89b-42d3-a456-426614174000";
function deliveryReviewFixture({jobOwner=owner,receiptValid=true,deliveryStatus="passed"}={}){
 const renderManifest=createRenderManifest({timeline:{tracks:[]},assets:new Map(),timelineRevision:2,output:{width:1920,height:1080,codec:"h264"}});
 const receipt=createDeliveryManifest({timelineId,timelineRevision:2,outputAsset:"published-asset",sha256:"a".repeat(64),byteSize:2048,mediaType:"video/mp4",profileId:"youtube-1080p",deliveryReport:{status:deliveryStatus,findings:[]},renderManifest,createdAt:"2026-11-02T09:00:00.000Z"});
 const job={id:reviewJobId,owner_id:jobOwner,project_id:project,job_type:"timeline.render",status:"succeeded",input:{timelineId,timelineRevision:2},output:{deliveryManifest:receipt,outputAsset:{id:"published-asset"},sha256:"a".repeat(64),deliveryReport:{status:deliveryStatus},qualityReport:{schemaVersion:2,status:"review",counts:{errors:0,warnings:1},findings:[{code:"TEMPORAL_LUMA_FLICKER",severity:"warning",message:"Possible luminance flicker",startSeconds:1,endSeconds:2}],limitations:["Bounded scan"]}}};
 if(!receiptValid)job.output.deliveryManifest={...receipt,fingerprint:"0".repeat(64)};
 return{job,receipt};
}
test("cloud job listing is project-authorized and owner-filtered with bounded pagination",async()=>{
 const jobs=[
  {id:"623e4567-e89b-42d3-a456-426614174001",owner_id:owner,project_id:project,job_type:"timeline.render",status:"running",progress:42,input:{timelineId},output:null,error:null,attempt_count:1,created_at:"2026-11-03T10:00:00Z",updated_at:"2026-11-03T10:01:00Z"},
  {id:"623e4567-e89b-42d3-a456-426614174002",owner_id:owner,project_id:project,job_type:"media.ai-upscale",status:"queued",progress:0,input:{sourceAssetId:"asset"},output:null,error:null,attempt_count:0,created_at:"2026-11-03T09:00:00Z",updated_at:"2026-11-03T09:00:00Z"}
 ];
 const f=setup({existing:jobs});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project,limit:"1",offset:"0",status:"running"}});
 assert.equal(result.status,200);
 assert.equal(result.body.jobs.length,1);
 assert.equal(result.body.jobs[0].type,"timeline.render");
 assert.equal(result.body.jobs[0].progress,42);
 assert.deepEqual(result.body.page,{limit:1,offset:0,hasMore:true,nextOffset:1});
 const url=f.calls.find(call=>call[0]==="fetch")[1];
 assert.ok(url.includes("owner_id=eq."+owner));
 assert.ok(url.includes("project_id=eq."+project));
 assert.ok(url.includes("status=eq.running"));
});
test("cloud job listing rejects unauthorized projects and malformed filters",async()=>{
 const denied=setup({authorizeOverride:async()=>false});
 const hidden=await denied.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project}});
 assert.equal(hidden.status,404);
 const f=setup();
 const invalid=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project,status:"secret"}});
 assert.equal(invalid.status,400);
 assert.equal(invalid.body.error.code,"JOB_STATUS_INVALID");
 assert.equal(f.calls.some(call=>call[0]==="fetch"),false);
});
test("delivery package verifies receipt and published asset before issuing a private master link",async()=>{
 const {job,receipt}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],authorizeOverride:async({ownerId,projectId:pid,action})=>ownerId===editor&&pid===project&&action==="read"});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-package",ownerId:editor});
 assert.equal(result.status,200);
 assert.equal(result.body.deliveryPackage.deliveryReceipt.fingerprint,receipt.fingerprint);
 assert.equal(result.body.deliveryPackage.qualityReport.findings[0].code,"TEMPORAL_LUMA_FLICKER");
 assert.equal(verifyDeliveryPackage(JSON.parse(JSON.stringify(result.body.deliveryPackage))),true);
 assert.equal(result.body.deliveryPackage.master.sha256,receipt.sha256);
 assert.equal(result.body.deliveryPackage.master.downloadUrlExpiresInSeconds,300);
 assert.match(result.body.deliveryPackage.packageFingerprint,/^[a-f0-9]{64}$/);
 assert.ok(f.calls.some(call=>call[0]==="signed-url"&&call[1].assetId==="published-asset"));
});
test("delivery package refuses an asset whose checksum differs from the receipt",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],assetOverride:{id:"published-asset",ownerId:owner,projectId:project,name:"master.mp4",mediaType:"video/mp4",size:2048,sha256:"b".repeat(64)},authorizeOverride:async()=>true});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-package",ownerId:editor});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"DELIVERY_ASSET_MISMATCH");
 assert.equal(f.calls.some(call=>call[0]==="signed-url"),false);
});

test("delivery package refuses a signed download ticket for a different asset",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],signedAssetOverride:{id:"different-asset",projectId:project,size:2048,sha256:"a".repeat(64)},authorizeOverride:async()=>true});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-package",ownerId:editor});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"DELIVERY_SIGNED_ASSET_MISMATCH");
});
test("delivery package hides private render evidence from unauthorized project members",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],authorizeOverride:async()=>false});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-package",ownerId:editor});
 assert.equal(result.status,404);
 assert.equal(f.calls.some(call=>call[0]==="signed-url"),false);
});

test("delivery approval requires independent project reviewer and records fingerprint-bound decision",async()=>{
 const {job,receipt}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],authorizeOverride:async({ownerId,projectId:pid,action})=>ownerId===editor&&pid===project&&action==="write"});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved",note:"Visual review passed."}});
 assert.equal(result.status,201);
 assert.equal(result.body.approval.fingerprint,receipt.fingerprint);
 assert.equal(result.body.approval.reviewerId,editor);
 const inserted=f.calls.find(call=>call[0]==="fetch"&&call[1].includes("/job_events")&&call[2].method==="POST");
 assert.equal(JSON.parse(inserted[2].body).event_type,"delivery.reviewed");
 assert.equal(JSON.parse(inserted[2].body).event_data.outputAsset,"published-asset");
});
test("delivery creator cannot approve own output",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job]});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:owner,body:{decision:"approved",note:"Reviewed output and acknowledge the flagged quality warning."}});
 assert.equal(result.status,403);
});
test("delivery approval fails closed for modified receipt fingerprints",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner,receiptValid:false});
 const f=setup({existing:[job],authorizeOverride:async()=>true});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved",note:"Reviewed output and acknowledge the flagged quality warning."}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"DELIVERY_EVIDENCE_UNVERIFIED");
});
test("delivery approval blocks validation failures and invalid decisions",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner,deliveryStatus:"needs-attention"});
 const f=setup({existing:[job],authorizeOverride:async()=>true});
 const blocked=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved"}});
 assert.equal(blocked.status,409);
 const invalid=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"ship-it"}});
 assert.equal(invalid.status,400);
});

test("database unique-index race returns a stable duplicate-review conflict",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],authorizeOverride:async()=>true,duplicateReview:true});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved",note:"Reviewed output and acknowledge the flagged quality warning."}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"DELIVERY_ALREADY_REVIEWED");
});
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
test("authenticated cloud timeline API exposes streaming asset upload through handle",async()=>{
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("api-route-png")]);
 let stored=null;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{async createFromFile(input){stored={...input,bytes:await readFile(input.filePath)};return{id:"723e4567-e89b-42d3-a456-426614174000",ownerId:input.ownerId,projectId:input.projectId,name:input.originalName,mediaType:input.mediaType,size:bytes.length};}}},authorize:async()=>true});
 const req=Readable.from([bytes]);req.headers={"content-length":String(bytes.length),"x-project-id":project,"x-file-name":"timeline source.png","content-type":"image/png"};
 const result=await api.handle({method:"POST",path:"/api/cloud/assets",ownerId:owner,req});
 assert.equal(result.status,201);assert.equal(stored.ownerId,owner);assert.equal(stored.projectId,project);assert.equal(stored.originalName,"timeline source.png");assert.equal(stored.mediaType,"image/png");assert.deepEqual(stored.bytes,bytes);
});
test("authenticated cloud timeline upload route rejects missing verified identity",async()=>{
 let called=false;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{async createFromFile(){called=true;}}},authorize:async()=>true});
 const req=Readable.from([Buffer.from([137,80,78,71,13,10,26,10])]);req.headers={"content-length":"8","content-type":"image/png"};
 const result=await api.handle({method:"POST",path:"/api/cloud/assets",req});
 assert.equal(result.status,401);assert.equal(result.body.error.code,"AUTH_REQUIRED");assert.equal(called,false);
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

test("generated media handoff resolves verified project asset and saves with revision fencing",async()=>{
 const track={id:"track-video",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[]};
 const f=setup({timelineDocOverride:{...timelineDoc,tracks:[track]}});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/handoff",ownerId:owner,body:{assetId:"723e4567-e89b-42d3-a456-426614174000",jobId:"823e4567-e89b-42d3-a456-426614174000",trackId:"track-video",clipId:"clip-generated-1",playheadSeconds:1.25,expectedRevision:2}});
 assert.equal(result.status,200);
 const update=f.calls.find(c=>c[0]==="update")[1];
 assert.equal(update.expectedRevision,2);
 const clip=update.timeline.tracks[0].clips[0];
 assert.equal(clip.assetId,"723e4567-e89b-42d3-a456-426614174000");
 assert.equal(clip.metadata.generationJobId,"823e4567-e89b-42d3-a456-426614174000");
 assert.equal(clip.duration.value/clip.duration.rate,2.51);
});
test("generated media handoff fails closed for stale revision, unverified assets and locked tracks",async()=>{
 const track={id:"track-video",name:"Video 1",kind:"video",enabled:true,locked:true,clips:[]};
 const f=setup({timelineDocOverride:{...timelineDoc,tracks:[track]}});
 const body={assetId:"723e4567-e89b-42d3-a456-426614174000",jobId:"823e4567-e89b-42d3-a456-426614174000",trackId:"track-video",clipId:"clip-generated-1",playheadSeconds:0,expectedRevision:1};
 assert.equal((await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/handoff",ownerId:owner,body})).status,409);
 const locked=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/handoff",ownerId:owner,body:{...body,expectedRevision:2}});
 assert.equal(locked.status,422);
 const badAsset={id:"723e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"generated.mp4",mediaType:"video/mp4",sha256:"a".repeat(64),metadata:{generated:true,jobId:"823e4567-e89b-42d3-a456-426614174000",probe:{format:{duration:"2.5"}}}};
 const unverified=setup({timelineDocOverride:{...timelineDoc,tracks:[{...track,locked:false}]},assetOverride:badAsset});
 const rejected=await unverified.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/handoff",ownerId:owner,body:{...body,expectedRevision:2}});
 assert.equal(rejected.status,422);
});
test("generated media handoff rejects overlap and never overwrites a clip",async()=>{
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const track={id:"track-video",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[{id:"existing",assetId:"other",name:"Existing",timelineStart:{value:0,rate:24},duration:{value:3,rate:1},sourceRange:{start:{value:0,rate:1},duration:{value:3,rate:1}},enabled:true}]};
 const f=setup({timelineDocOverride:{...timelineDoc,tracks:[track]}});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/handoff",ownerId:owner,body:{assetId,jobId:"823e4567-e89b-42d3-a456-426614174000",trackId:"track-video",clipId:"new-clip",playheadSeconds:1,expectedRevision:2}});
 assert.equal(result.status,409);
 assert.equal(f.calls.some(c=>c[0]==="update"),false);
});


test("timeline preview tickets are revision-aware and limited to enabled timeline assets",async()=>{
 const assetId="723e4567-e89b-42d3-a456-426614174000",calls=[];
 const timeline={id:timelineId,ownerId:owner,projectId:project,name:"Preview",revision:9,timeline:{tracks:[{id:"v1",enabled:true,clips:[{id:"clip-1",assetId,enabled:true}]}]},otio:null};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  timelineService:{timelines:{async get(input){calls.push(["timeline",input]);return input.ownerId===owner?timeline:null;}},assets:{
   async get(input){calls.push(["asset",input]);return{id:assetId,ownerId:owner,projectId:project,mediaType:"video/mp4"};},
   async createSignedUrl(input){calls.push(["sign",input]);return{asset:{id:assetId,mediaType:"video/mp4"},url:"https://signed.example/private-video",expiresIn:300};}
  }},
  authorize:async({ownerId:who,projectId:pid,action})=>who===owner&&pid===project&&action==="read"
 });
 const path="/api/cloud/timelines/"+timelineId+"/preview/"+assetId;
 const result=await api.handle({method:"GET",path,ownerId:owner,query:{revision:"9"}});
 assert.equal(result.status,200);assert.equal(result.body.preview.timelineRevision,9);assert.equal(result.body.preview.expiresIn,300);
 assert.deepEqual(calls.filter(x=>x[0]==="sign")[0][1],{ownerId:owner,assetId,expiresIn:300});
 const stale=await api.handle({method:"GET",path,ownerId:owner,query:{revision:"8"}});
 assert.equal(stale.status,409);
 const unrelated=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/preview/823e4567-e89b-42d3-a456-426614174000",ownerId:owner});
 assert.equal(unrelated.status,404);
});
test("timeline preview prefers a same-project validated proxy while retaining the original timeline asset",async()=>{
 const sourceId="723e4567-e89b-42d3-a456-426614174000",proxyId="823e4567-e89b-42d3-a456-426614174001",calls=[];
 const source={id:sourceId,ownerId:owner,projectId:project,mediaType:"video/mp4",sha256:"a".repeat(64)};
 const proxy={id:proxyId,ownerId:owner,projectId:project,mediaType:"video/mp4",sha256:"b".repeat(64),derivativeOf:sourceId,metadata:{operation:"media.proxy",sourceSha256:source.sha256}};
 const timeline={id:timelineId,ownerId:owner,projectId:project,revision:12,timeline:{tracks:[{enabled:true,clips:[{enabled:true,assetId:sourceId}]}]}};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{
  timelines:{async get(){return timeline;}},
  assets:{async get(input){assert.equal(input.assetId,sourceId);return source;},async list(input){calls.push(["list",input]);return[proxy];},async createSignedUrl(input){calls.push(["sign",input]);return{asset:{id:input.assetId,mediaType:"video/mp4"},url:"https://signed.example/proxy",expiresIn:300};}}
 },authorize:async({ownerId:who,projectId:pid,action})=>who===owner&&pid===project&&action==="read"});
 const result=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/preview/"+sourceId,ownerId:owner,query:{revision:"12"}});
 assert.equal(result.status,200);assert.equal(result.body.preview.sourceAssetId,sourceId);assert.equal(result.body.preview.usingProxy,true);assert.equal(result.body.preview.asset.id,proxyId);
 assert.deepEqual(calls.find(x=>x[0]==="sign")[1],{ownerId:owner,assetId:proxyId,expiresIn:300});
});
test("timeline preview ignores proxy derivatives without matching SHA-256 provenance",async()=>{
 const sourceId="723e4567-e89b-42d3-a456-426614174000",proxyId="823e4567-e89b-42d3-a456-426614174002",signed=[];
 const source={id:sourceId,ownerId:owner,projectId:project,mediaType:"video/mp4",sha256:"a".repeat(64)};
 const proxy={id:proxyId,ownerId:owner,projectId:project,mediaType:"video/mp4",sha256:"b".repeat(64),derivativeOf:sourceId,metadata:{operation:"media.proxy",sourceSha256:"c".repeat(64)}};
 const timeline={id:timelineId,ownerId:owner,projectId:project,revision:13,timeline:{tracks:[{clips:[{assetId:sourceId}]}]}};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{
  timelines:{async get(){return timeline;}},
  assets:{async get(){return source;},async list(){return[proxy];},async createSignedUrl(input){signed.push(input);return{asset:{id:input.assetId},url:"https://signed.example/original",expiresIn:300};}}
 },authorize:async()=>true});
 const result=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/preview/"+sourceId,ownerId:owner,query:{revision:"13"}});
 assert.equal(result.status,200);assert.equal(result.body.preview.usingProxy,false);assert.equal(result.body.preview.asset.id,sourceId);
 assert.deepEqual(signed[0],{ownerId:owner,assetId:sourceId,expiresIn:300});
});
test("timeline preview tickets fail closed for users without project read access",async()=>{
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  timelineService:{timelines:{async get(){return{id:timelineId,ownerId:owner,projectId:project,revision:1,timeline:{tracks:[{clips:[{assetId}]}]}};}},assets:{async get(){throw new Error("must not be reached");}}},
  authorize:async()=>false
 });
 const result=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/preview/"+assetId,ownerId:owner});
 assert.equal(result.status,404);
});


test("delivery approval rejects internally inconsistent media-quality evidence",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 job.output.qualityReport={status:"passed",counts:{errors:0,warnings:0},findings:[{code:"BELOW_HD",severity:"warning",message:"Output is below HD."}],limitations:[]};
 const f=setup({existing:[job],authorizeOverride:async()=>true});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved",note:"Reviewed output."}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"MEDIA_QUALITY_EVIDENCE_INVALID");
 assert.equal(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/job_events")&&call[2].method==="POST"),false);
});
test("media-quality warnings require an explicit acknowledgement note before approval",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 job.output.qualityReport={status:"review",counts:{errors:0,warnings:1},findings:[{code:"TEMPORAL_LUMA_FLICKER",severity:"warning",message:"Possible flicker"}],limitations:[]};
 const f=setup({existing:[job],authorizeOverride:async()=>true});
 const missing=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved"}});
 assert.equal(missing.status,400);
 assert.equal(missing.body.error.code,"QUALITY_ACKNOWLEDGEMENT_REQUIRED");
 const acknowledged=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved",note:"Reviewed the flagged luminance interval; acceptable for this intended creative use."}});
 assert.equal(acknowledged.status,201);
});

test("blocking media-quality errors prevent independent delivery approval",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner});
 job.output.qualityReport={status:"needs-attention",counts:{errors:1,warnings:0},findings:[{code:"INVALID_DURATION",severity:"error",message:"Invalid duration"}],limitations:[]};
 const f=setup({existing:[job],authorizeOverride:async()=>true});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved",note:"I reviewed this."}});
 assert.equal(result.status,409);
 assert.equal(result.body.error.code,"MEDIA_QUALITY_BLOCKED");
});


test("transformation approval binds to the exact immutable plan and blocks changed input before dispatch",async()=>{
 const job={id:"923e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"video.transform.plan",status:"draft",input:{projectId:project,sourceAssetId:"723e4567-e89b-42d3-a456-426614174000",operation:"vehicle_replace",prompt:"Replace the vehicle with a blue electric coupe.",durationSeconds:8,referenceAssetIds:[],preservation:["camera_motion"],rightsConfirmed:true,subjectConsentConfirmed:false},estimated_cost:null,approved_by:null,approved_at:null};
 const f=setup({existing:[job]});
 const approved=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+job.id+"/approve",ownerId:owner,body:{estimatedCostMicros:1200,approvedBudgetMicros:1500,currency:"USD",adapterId:"adapter-review-only",capability:"video.transform.vehicle_replace"}});
 assert.equal(approved.status,200);
 assert.match(approved.body.plan.approval.planHash,/^[a-f0-9]{64}$/);
 assert.equal(approved.body.plan.approval.planHash,job.estimated_cost.planHash);
 const blockedAdapter=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+job.id+"/submit",ownerId:owner,body:{}});
 assert.equal(blockedAdapter.status,409);
 assert.equal(blockedAdapter.body.error.code,"TRANSFORMATION_ADAPTER_UNAVAILABLE");
 job.input={...job.input,prompt:"Replace the vehicle with a yellow electric coupe."};
 const changed=await f.api.handle({method:"POST",path:"/api/cloud/transformations/"+job.id+"/submit",ownerId:owner,body:{}});
 assert.equal(changed.status,409);
 assert.equal(changed.body.error.code,"TRANSFORMATION_PLAN_CHANGED");
});

test("cloud asset cleanup retry is scoped to the verified user identity",async()=>{
 const f=setup({authorizeOverride:async({ownerId:actor,projectId:pid,action})=>actor===editor&&pid===project&&action==="write"});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets/723e4567-e89b-42d3-a456-426614174000/retry-cleanup",ownerId:editor});
 assert.equal(result.status,200);
 assert.equal(result.body.asset.cleanupPending,false);
 assert.deepEqual(f.calls.find(call=>call[0]==="asset-cleanup-retry")[1],{ownerId:editor,assetId:"723e4567-e89b-42d3-a456-426614174000"});
});


test("cloud asset lineage endpoint returns only the authorized asset ancestry and descendants",async()=>{
 const original={id:"723e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"original.png",mediaType:"image/png",size:100,sha256:"a".repeat(64),derivativeOf:null,metadata:{}};
 const enhanced={id:"823e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"enhanced.png",mediaType:"image/png",size:200,sha256:"b".repeat(64),derivativeOf:original.id,metadata:{operation:"media.ai-upscale"}};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{
  async get(input){assert.equal(input.ownerId,owner);assert.equal(input.assetId,enhanced.id);return enhanced;},
  async list(input){assert.equal(input.ownerId,owner);assert.equal(input.projectId,project);assert.equal(input.limit,100);return[original,enhanced];}
 }},authorize:async()=>true});
 const result=await api.handle({method:"GET",path:"/api/cloud/assets/"+enhanced.id+"/lineage",ownerId:owner});
 assert.equal(result.status,200);assert.equal(result.body.lineage.asset.id,enhanced.id);
 assert.deepEqual(result.body.lineage.ancestors.map(item=>item.id),[original.id]);
 assert.deepEqual(result.body.lineage.descendants,[]);
});
test("cloud asset lineage endpoint requires a verified account identity",async()=>{
 let called=false;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{timelines:{},assets:{async get(){called=true;},async list(){called=true;}}},authorize:async()=>true});
 const result=await api.handle({method:"GET",path:"/api/cloud/assets/"+timelineId+"/lineage"});
 assert.equal(result.status,401);assert.equal(called,false);
});

test("waveform API queues an idempotent project-scoped job for verified audio only",async()=>{
 const audio={id:"723e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"dialogue.wav",mediaType:"audio/wav",sha256:"d".repeat(64)};
 const f=setup({assetOverride:audio});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/waveforms",ownerId:owner,body:{projectId:project,sourceAssetId:audio.id,width:1200,height:180},idempotencyKey:"waveform-request-001"});
 assert.equal(result.status,202);assert.equal(result.body.job.job_type,"media.waveform");
 const queued=JSON.parse(f.calls.find(call=>call[0]==="fetch"&&call[1].includes("/jobs?")&&call[2].method==="POST")[2].body);
 assert.equal(queued.job_type,"media.waveform");assert.equal(queued.input.sourceSha256,audio.sha256);assert.equal(queued.input.width,1200);assert.equal(queued.input.height,180);
 assert.ok(f.calls.some(call=>call[0]==="fetch"&&call[1].includes("/job_events")));
});
test("waveform API rejects non-audio assets and invalid dimensions",async()=>{
 const video={id:"723e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"clip.mp4",mediaType:"video/mp4",sha256:"d".repeat(64)};
 const f=setup({assetOverride:video});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/waveforms",ownerId:owner,body:{projectId:project,sourceAssetId:video.id},idempotencyKey:"waveform-request-002"});
 assert.equal(result.status,422);assert.equal(result.body.error.code,"WAVEFORM_SOURCE_INVALID");
 const audio=setup({assetOverride:{...video,mediaType:"audio/wav"}});
 const invalid=await audio.api.handle({method:"POST",path:"/api/cloud/waveforms",ownerId:owner,body:{projectId:project,sourceAssetId:video.id,width:20},idempotencyKey:"waveform-request-003"});
 assert.equal(invalid.status,400);assert.equal(invalid.body.error.code,"WAVEFORM_OPTIONS_INVALID");
});

test("audio timeline preview exposes only a same-project waveform derivative with matching source checksum",async()=>{
 const sourceId="723e4567-e89b-42d3-a456-426614174000",waveformId="823e4567-e89b-42d3-a456-426614174003",sourceHash="a".repeat(64),calls=[];
 const source={id:sourceId,ownerId:owner,projectId:project,mediaType:"audio/wav",sha256:sourceHash};
 const waveform={id:waveformId,ownerId:owner,projectId:project,mediaType:"image/png",sha256:"b".repeat(64),derivativeOf:sourceId,metadata:{operation:"media.waveform",sourceSha256:sourceHash}};
 const timeline={id:timelineId,ownerId:owner,projectId:project,revision:14,timeline:{tracks:[{clips:[{assetId:sourceId}]}]}};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",timelineService:{
  timelines:{async get(){return timeline;}},
  assets:{async get(){return source;},async list(){return[waveform];},async createSignedUrl(input){calls.push(input);return{asset:{id:input.assetId},url:"https://signed.example/"+input.assetId,expiresIn:300};}}
 },authorize:async()=>true});
 const result=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/preview/"+sourceId,ownerId:owner,query:{revision:"14"}});
 assert.equal(result.status,200);assert.equal(result.body.preview.waveformUrl,"https://signed.example/"+waveformId);
 assert.equal(calls.length,2);assert.equal(calls[0].assetId,sourceId);assert.equal(calls[1].assetId,waveformId);
});

test("cloud asset listing is scoped to the verified owner and selected project",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/assets",ownerId:owner,query:{projectId:project,limit:"12",offset:"3"}});
 assert.equal(result.status,200);
 assert.equal(result.body.assets.length,1);
 assert.deepEqual(f.calls.find(call=>call[0]==="asset-list")[1],{ownerId:owner,projectId:project,limit:12,offset:3});
});
test("cloud asset download returns a short-lived private signed URL",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/assets/723e4567-e89b-42d3-a456-426614174000",ownerId:owner});
 assert.equal(result.status,200);
 assert.equal(result.body.expiresIn,300);
 assert.match(result.body.url,/^https:\/\//);
 assert.ok(f.calls.some(call=>call[0]==="signed-url"&&call[1].ownerId===owner&&call[1].expiresIn===300));
});
test("cloud asset deletion uses the verified owner identity",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"DELETE",path:"/api/cloud/assets/723e4567-e89b-42d3-a456-426614174000",ownerId:owner});
 assert.equal(result.status,200);
 assert.deepEqual(f.calls.find(call=>call[0]==="asset-soft-delete")[1],{ownerId:owner,assetId:"723e4567-e89b-42d3-a456-426614174000"});
});
test("cloud asset upload streams validated PDF bytes and never trusts a body owner ID",async()=>{
 const f=setup();
 const bytes=Buffer.from("%PDF-1.7\\nfixture");
 const req=Object.assign(Readable.from([bytes]),{headers:{"content-length":String(bytes.length),"content-type":"application/pdf","x-file-name":"private-report.pdf","x-project-id":project}});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets",ownerId:owner,body:{ownerId:editor},req});
 assert.equal(result.status,201);
 const upload=f.calls.find(call=>call[0]==="asset-create-from-file")[1];
 assert.equal(upload.ownerId,owner);
 assert.equal(upload.projectId,project);
 assert.equal(upload.originalName,"private-report.pdf");
 assert.equal(upload.mediaType,"application/pdf");
 assert.equal(upload.metadata.ingest,"cloud-api");
});
test("cloud asset upload rejects invalid file signatures before storage",async()=>{
 const f=setup();
 const bytes=Buffer.from("not a pdf");
 const req=Object.assign(Readable.from([bytes]),{headers:{"content-length":String(bytes.length),"content-type":"application/pdf","x-file-name":"fake.pdf"}});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/assets",ownerId:owner,req});
 assert.equal(result.status,415);
 assert.equal(result.body.error.code,"MEDIA_SIGNATURE_MISMATCH");
 assert.equal(f.calls.some(call=>call[0]==="asset-create-from-file"),false);
});
test("cloud asset routes reject missing verified identity",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"GET",path:"/api/cloud/assets",ownerId:"not-a-user"});
 assert.equal(result.status,401);
 assert.equal(f.calls.length,0);
});
