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
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.includes("/job_events")&&options.method==="POST"&&duplicateReview)return{ok:false,status:409,async text(){return JSON.stringify({code:"23505",message:"duplicate key"})}};if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{id:JSON.parse(options.body).id,owner_id:owner,project_id:projectId,job_type:"timeline.render",status:"queued",input:JSON.parse(options.body).input}])}};if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{async list(input){calls.push(["asset-list",input]);return[{id:"asset-1",projectId:input.projectId}];},async get(input){calls.push(["asset-get",input]);if(input.assetId==="published-asset")return assetOverride||{id:"published-asset",ownerId:owner,projectId:project,name:"master.mp4",mediaType:"video/mp4",size:2048,sha256:"a".repeat(64),metadata:{}};return assetOverride||{id:"723e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"generated.mp4",mediaType:"video/mp4",sha256:"a".repeat(64),metadata:{generated:true,jobId:"823e4567-e89b-42d3-a456-426614174000",mediaVerification:{status:"passed",readable:true,sha256:"a".repeat(64)},probe:{format:{duration:"2.51"},streams:[{codec_type:"video"}]}}};},async createSignedUrl(input){calls.push(["signed-url",input]);return{asset:signedAssetOverride||{id:input.assetId,projectId:project,size:2048,sha256:"a".repeat(64)},url:"https://storage.example.test/private/master?token=short-lived"};}},projects:{async create(input){calls.push(["project-create",input]);return{id:"project-1",...input};},async list(input){calls.push(["project-list",input]);return[{id:project}];},async get(input){calls.push(["project-get",input]);return{id:project,...input};},async update(input){calls.push(["project-update",input]);return{id:project,...input};},async archive(input){calls.push(["project-archive",input]);return{id:project,archived:true};}}},authorize:authorizeOverride|| (async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"||canWrite))});
 return{api,calls,created};
}

const reviewJobId="623e4567-e89b-42d3-a456-426614174000";
function deliveryReviewFixture({jobOwner=owner,receiptValid=true,deliveryStatus="passed"}={}){
 const renderManifest=createRenderManifest({timeline:{tracks:[]},assets:new Map(),timelineRevision:2,output:{width:1920,height:1080,codec:"h264"}});
 const receipt=createDeliveryManifest({timelineId,timelineRevision:2,outputAsset:"published-asset",sha256:"a".repeat(64),byteSize:2048,mediaType:"video/mp4",profileId:"youtube-1080p",deliveryReport:{status:deliveryStatus,findings:[]},renderManifest,createdAt:"2026-11-02T09:00:00.000Z"});
 const job={id:reviewJobId,owner_id:jobOwner,project_id:project,job_type:"timeline.render",status:"succeeded",input:{timelineId,timelineRevision:2},output:{deliveryManifest:receipt,outputAsset:{id:"published-asset"},sha256:"a".repeat(64),deliveryReport:{status:deliveryStatus}}};
 if(!receiptValid)job.output.deliveryManifest={...receipt,fingerprint:"0".repeat(64)};
 return{job,receipt};
}
test("delivery package verifies receipt and published asset before issuing a private master link",async()=>{
 const {job,receipt}=deliveryReviewFixture({jobOwner:owner});
 const f=setup({existing:[job],authorizeOverride:async({ownerId,projectId:pid,action})=>ownerId===editor&&pid===project&&action==="read"});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-package",ownerId:editor});
 assert.equal(result.status,200);
 assert.equal(result.body.deliveryPackage.deliveryReceipt.fingerprint,receipt.fingerprint);
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
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:owner,body:{decision:"approved"}});
 assert.equal(result.status,403);
});
test("delivery approval fails closed for modified receipt fingerprints",async()=>{
 const {job}=deliveryReviewFixture({jobOwner:owner,receiptValid:false});
 const f=setup({existing:[job],authorizeOverride:async()=>true});
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved"}});
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
 const result=await f.api.handle({method:"POST",path:"/api/cloud/jobs/"+reviewJobId+"/delivery-approval",ownerId:editor,body:{decision:"approved"}});
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
test("timeline preview tickets fail closed for users without project read access",async()=>{
 const assetId="723e4567-e89b-42d3-a456-426614174000";
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",
  timelineService:{timelines:{async get(){return{id:timelineId,ownerId:owner,projectId:project,revision:1,timeline:{tracks:[{clips:[{assetId}]}]}};}},assets:{async get(){throw new Error("must not be reached");}}},
  authorize:async()=>false
 });
 const result=await api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId+"/preview/"+assetId,ownerId:owner});
 assert.equal(result.status,404);
});
