import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCloudTimelineApi } from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000",editor="223e4567-e89b-42d3-a456-426614174000",project="423e4567-e89b-42d3-a456-426614174000",timelineId="523e4567-e89b-42d3-a456-426614174000";
const timelineDoc={width:1280,height:720,frameRate:{numerator:24,denominator:1},tracks:[],markers:[]};
function setup({canWrite=true,canRead=true,projectId=project,existing=[]}={}){
 const calls=[],created=[];
 const timeline={id:timelineId,ownerId:owner,projectId,name:"Test timeline",revision:2,timeline:timelineDoc,otio:null};
 const timelines={
  async create(input){created.push(input);return{...timeline,...input,revision:1};},
  async get(input){calls.push(["get",input]);return input.ownerId===owner?timeline:null;},
  async list(input){calls.push(["timeline-list",input]);return[{...timeline}];},
  async update(input){calls.push(["update",input]);return{...timeline,revision:input.expectedRevision+1,timeline:input.timeline};}
 };
 const fetchImpl=async(url,options)=>{calls.push(["fetch",url,options]);if(url.includes("/jobs")&&options.method==="POST")return{ok:true,status:201,async text(){return JSON.stringify([{id:JSON.parse(options.body).id,owner_id:owner,project_id:projectId,job_type:"timeline.render",status:"queued",input:JSON.parse(options.body).input}])}};if(url.includes("/jobs?"))return{ok:true,status:200,async text(){return JSON.stringify(existing)}};return{ok:true,status:201,async text(){return""}};};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{timelines,assets:{async list(input){calls.push(["asset-list",input]);return[{id:"asset-1",projectId:input.projectId}];}},projects:{async create(input){calls.push(["project-create",input]);return{id:"project-1",...input};},async list(input){calls.push(["project-list",input]);return[{id:project}];},async get(input){calls.push(["project-get",input]);return{id:project,...input};},async update(input){calls.push(["project-update",input]);return{id:project,...input};},async archive(input){calls.push(["project-archive",input]);return{id:project,archived:true};}}},authorize:async({ownerId,projectId:pid,action})=>ownerId===owner&&(!pid||pid===project)&&(action==="read"?canRead:canWrite)});
 return{api,calls,created};
}
test("cloud timeline create binds ownership to verified identity, not request body",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines",ownerId:owner,body:{ownerId:editor,projectId:project,name:"Test",timeline:timelineDoc}});assert.equal(result.status,201);assert.equal(f.created[0].ownerId,owner);assert.equal(f.created[0].projectId,project);});
test("cloud timeline get and update use verified owner and optimistic revision",async()=>{const f=setup();const got=await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:owner});assert.equal(got.status,200);const updated=await f.api.handle({method:"PUT",path:"/api/cloud/timelines/"+timelineId,ownerId:owner,body:{expectedRevision:2,timeline:timelineDoc}});assert.equal(updated.status,200);assert.equal(f.calls.find(c=>c[0]==="update")[1].expectedRevision,2);});
test("cloud render submission queues a durable job using current saved timeline revision",async()=>{const f=setup();const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{ownerId:editor,timelineId:"bad"},idempotencyKey:"render-1"});assert.equal(result.status,202);const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");const body=JSON.parse(inserted[2].body);assert.equal(body.owner_id,owner);assert.equal(body.input.timelineId,timelineId);assert.equal(body.input.timelineRevision,2);assert.equal(body.job_type,"timeline.render");});
test("cloud render submission persists validated opt-in mastering settings",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{mastering:{enabled:true,integratedLufs:-16,loudnessRange:11,truePeakDbtp:-1.5,dualMono:false}},idempotencyKey:"mastering-1"});
 assert.equal(result.status,202);
 const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");
 assert.deepEqual(JSON.parse(inserted[2].body).input.mastering,{enabled:true,integratedLufs:-16,loudnessRange:11,truePeakDbtp:-1.5,dualMono:false});
});
test("cloud render submission persists an allow-listed delivery profile",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{deliveryProfile:"vertical-1080p"}});
 assert.equal(result.status,202);
 const inserted=f.calls.find(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST");
 assert.equal(JSON.parse(inserted[2].body).input.deliveryProfile,"vertical-1080p");
});
test("cloud render submission rejects unsupported delivery profiles before queuing",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{deliveryProfile:"custom-8192x8192"}});
 assert.equal(result.status,422);
 assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);
});
test("cloud render submission rejects unsafe mastering targets",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{mastering:{enabled:true,truePeakDbtp:-12}}});
 assert.equal(result.status,422);
 assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);
});
test("cloud render submission requires project editor authorization",async()=>{const f=setup({canWrite:false});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,body:{}});assert.equal(result.status,404);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].includes("/jobs")&&c[2].method==="POST"),false);});
test("cloud render idempotency replays only the exact same timeline revision",async()=>{const existing=[{id:"623e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,job_type:"timeline.render",status:"queued",input:{timelineId,timelineRevision:2}}];const f=setup({existing});const result=await f.api.handle({method:"POST",path:"/api/cloud/timelines/"+timelineId+"/render",ownerId:owner,idempotencyKey:"render-1"});assert.equal(result.status,200);assert.equal(result.body.idempotentReplay,true);assert.equal(f.calls.some(c=>c[0]==="fetch"&&c[1].endsWith("/jobs")),false);});
test("cloud timeline API rejects unverified or malformed owner IDs and ignores unrelated routes",async()=>{const f=setup();assert.equal((await f.api.handle({method:"GET",path:"/api/cloud/timelines/"+timelineId,ownerId:"not-uuid"})).status,401);assert.equal(await f.api.handle({method:"GET",path:"/api/not-cloud",ownerId:owner}),null);});

test("cloud render history is project-scoped and requires project read access",async()=>{
 const job={id:"623e4567-e89b-42d3-a456-426614174000",owner_id:editor,project_id:project,job_type:"timeline.render",status:"succeeded",progress:100,input:{timelineId,timelineRevision:2,mastering:{enabled:true}},output:{mastering:{enabled:true,verified:true}},error:null};
 const f=setup({existing:[job]});
 const result=await f.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project,limit:"10"}});
 assert.equal(result.status,200);
 assert.deepEqual(result.body.jobs,[job]);
 const request=f.calls.find(call=>call[0]==="fetch"&&call[1].includes("/jobs?"));
 assert.match(request[1],/project_id=eq\.423e4567-e89b-42d3-a456-426614174000/);
 assert.match(request[1],/job_type=eq\.timeline.render/);
});
test("cloud render history rejects missing project and hides projects without read access",async()=>{
 const missing=setup();
 assert.equal((await missing.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{}})).status,400);
 const denied=setup({canRead:false});
 assert.equal((await denied.api.handle({method:"GET",path:"/api/cloud/jobs",ownerId:owner,query:{projectId:project}})).status,404);
 assert.equal(denied.calls.some(call=>call[0]==="fetch"&&call[1].includes("/jobs?")),false);
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

test("cloud waveform endpoint authorizes source, verifies hash and persists a private content-addressed derivative",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-waveform-")),source=Buffer.from("cloud-audio-source"),png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("waveform")]);
 const sha=createHash("sha256").update(source).digest("hex"),assetId="623e4567-e89b-42d3-a456-426614174000",objectPath=project+"/"+assetId+"/original.wav",uploads=[];
 const asset={id:assetId,ownerId:owner,projectId:project,name:"song.wav",mediaType:"audio/wav",size:source.length,sha256:sha,storageBucket:"executive-visuals-media",objectPath};
 const storage={
  async downloadToFile(path,file,limit){
   if(path!==objectPath)throw Object.assign(new Error("Not found"),{code:"CLOUD_STORAGE_HTTP_404"});
   await writeFile(file,source);return{size:source.length,sha256:sha};
  },
  async uploadFile(path,file,mime,upsert){uploads.push({path,file,mime,upsert});return{bucket:"executive-visuals-media",path,size:png.length,contentType:mime,sha256:createHash("sha256").update(png).digest("hex")};}
 };
 const waveformCache={async get(localAsset,sourcePath){
  assert.equal(localAsset.sha256,sha);assert.equal(localAsset.media_type,"audio/wav");
  const dir=join(root,"derived","waveforms");await mkdir(dir,{recursive:true});const output=join(dir,"waveform.png");await writeFile(output,png);return output;
 }};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"test-service-key",timelineService:{assets:{async get(input){assert.deepEqual(input,{ownerId:owner,assetId});return asset;}},storage},waveformCache,mediaRoot:root});
 try{
  const result=await api.handle({method:"GET",path:"/api/cloud/assets/"+assetId+"/waveform",ownerId:owner});
  assert.equal(result.status,200);assert.equal(result.body.sourceSha256,sha);
  assert.equal(uploads.length,1);assert.equal(uploads[0].path,project+"/"+assetId+"/waveform-v1-"+sha+".png");
  assert.equal(uploads[0].mime,"image/png");assert.equal(uploads[0].upsert,true);
  assert.deepEqual(await readFile(result.waveformPath),png);
  await rm(result.cleanupDirectory,{recursive:true,force:true});
 }finally{await rm(root,{recursive:true,force:true});}
});
test("cloud waveform endpoint rejects non-audio sources before storage access",async()=>{
 let storageCalled=false;
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"test-service-key",timelineService:{assets:{async get(){return{id:"623e4567-e89b-42d3-a456-426614174000",ownerId:owner,projectId:project,name:"clip.mp4",mediaType:"video/mp4",size:10,sha256:"a".repeat(64),storageBucket:"executive-visuals-media",objectPath:project+"/623e4567-e89b-42d3-a456-426614174000/original.mp4"};}},storage:{async downloadToFile(){storageCalled=true;},async uploadFile(){storageCalled=true;}}},waveformCache:{},mediaRoot:tmpdir()});
 const result=await api.handle({method:"GET",path:"/api/cloud/assets/623e4567-e89b-42d3-a456-426614174000/waveform",ownerId:owner});
 assert.equal(result.status,415);assert.equal(storageCalled,false);
});

test("cloud waveform endpoint reuses a valid private derivative without downloading source audio",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-waveform-hit-")),png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("cached-waveform")]);
 const assetId="723e4567-e89b-42d3-a456-426614174000",sha="b".repeat(64),objectPath=project+"/"+assetId+"/original.wav";let downloads=0,uploads=0;
 const asset={id:assetId,ownerId:owner,projectId:project,name:"song.wav",mediaType:"audio/wav",size:64,sha256:sha,storageBucket:"executive-visuals-media",objectPath};
 const storage={
  async downloadToFile(path,file){downloads++;if(!path.endsWith("waveform-v1-"+sha+".png"))throw new Error("Source must not be fetched on cache hit.");await writeFile(file,png);return{size:png.length,sha256:createHash("sha256").update(png).digest("hex")};},
  async uploadFile(){uploads++;throw new Error("Cache hit must not upload.");}
 };
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"test-service-key",timelineService:{assets:{async get(){return asset;}},storage},waveformCache:{},mediaRoot:root});
 try{
  const result=await api.handle({method:"GET",path:"/api/cloud/assets/"+assetId+"/waveform",ownerId:owner});
  assert.equal(result.status,200);assert.equal(downloads,1);assert.equal(uploads,0);
  assert.deepEqual(await readFile(result.waveformPath),png);
  await rm(result.cleanupDirectory,{recursive:true,force:true});
 }finally{await rm(root,{recursive:true,force:true});}
});

test("cloud waveform endpoint repairs a corrupt cached derivative before serving it",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-cloud-waveform-corrupt-")),source=Buffer.from("cloud-audio-source"),png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("repaired-waveform")]);
 const sha=createHash("sha256").update(source).digest("hex"),assetId="823e4567-e89b-42d3-a456-426614174000",objectPath=project+"/"+assetId+"/original.wav",derivativePath=project+"/"+assetId+"/waveform-v1-"+sha+".png";let removed=0,downloaded=0;
 const asset={id:assetId,ownerId:owner,projectId:project,name:"song.wav",mediaType:"audio/wav",size:source.length,sha256:sha,storageBucket:"executive-visuals-media",objectPath};
 const storage={
  async downloadToFile(path,file){downloaded++;if(path===derivativePath){await writeFile(file,Buffer.from("bad-png"));return{size:7,sha256:"bad"};}if(path===objectPath){await writeFile(file,source);return{size:source.length,sha256:sha};}throw new Error("Unexpected object path.");},
  async remove(path){assert.equal(path,derivativePath);removed++;},
  async uploadFile(path,file,mime,upsert){const info=await import("node:fs/promises").then(fs=>fs.stat(file));return{bucket:"executive-visuals-media",path,size:info.size,contentType:mime,sha256:createHash("sha256").update(png).digest("hex")};}
 };
 const waveformCache={async get(){const dir=join(root,"derived","waveforms");await mkdir(dir,{recursive:true});const output=join(dir,"repaired.png");await writeFile(output,png);return output;}};
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"test-service-key",timelineService:{assets:{async get(){return asset;}},storage},waveformCache,mediaRoot:root});
 try{
  const result=await api.handle({method:"GET",path:"/api/cloud/assets/"+assetId+"/waveform",ownerId:owner});
  assert.equal(result.status,200);assert.equal(removed,1);assert.equal(downloaded,2);
  assert.deepEqual(await readFile(result.waveformPath),png);
  await rm(result.cleanupDirectory,{recursive:true,force:true});
 }finally{await rm(root,{recursive:true,force:true});}
});
