import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCloudAssetRepository } from "../cloud-assets.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const projectId="223e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const bytes=new Uint8Array([1,2,3,4]);
const config={url:"https://example.supabase.co",serviceRoleKey:"private-service-key"};
function response(body,status=200){return{ok:status>=200&&status<300,status,async text(){return JSON.stringify(body);}};}
function fixture({authorize=async()=>true,insertResponse=null,removeError=false}={}) {
 const calls=[],storageCalls=[];
 const storage={
  async upload(path,data,type){storageCalls.push({op:"upload",path,data,type});return{bucket:"executive-visuals-media",path,size:data.byteLength,contentType:type};},
  async uploadFile(path,file,type){const data=await readFile(file);storageCalls.push({op:"uploadFile",path,file,type});return{bucket:"executive-visuals-media",path,size:data.byteLength,sha256:createHash("sha256").update(data).digest("hex"),contentType:type};},
  async createSignedUrl(path,expiry){storageCalls.push({op:"sign",path,expiry});return"https://example.supabase.co/storage/signed";},
  async remove(path){storageCalls.push({op:"remove",path});if(removeError)throw new Error("storage cleanup unavailable");return true;}
 };
 const row={id:assetId,owner_id:ownerId,project_id:projectId,original_name:"final cut.mp4",media_type:"video/mp4",byte_size:4,sha256:createHash("sha256").update(bytes).digest("hex"),storage_bucket:"executive-visuals-media",object_path:projectId+"/"+assetId+"/original.mp4",derivative_of:null,metadata:{role:"master"},created_at:"2026-11-01T00:00:00Z"};
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(options.method==="POST"){const payload=JSON.parse(options.body);return response(insertResponse===null?[{...row,...payload,created_at:row.created_at}]:insertResponse);}
  if(options.method==="PATCH")return response([row]);
  return response([row]);
 };
 return {repo:createCloudAssetRepository({...config,storage,authorize,fetchImpl}),calls,storageCalls,row};
}

test("creates a cloud asset only after project authorization and verifies metadata ownership",async()=>{
 let authorized=null;const f=fixture({authorize:async value=>{authorized=value;return true;}});
 const asset=await f.repo.create({ownerId,projectId,originalName:"final cut.mp4",mediaType:"video/mp4",bytes,metadata:{role:"master"}});
 assert.equal(authorized.action,"write");assert.equal(authorized.projectId,projectId);
 assert.equal(asset.sha256,createHash("sha256").update(bytes).digest("hex"));
 assert.equal(f.storageCalls[0].op,"upload");assert.equal(f.calls[0].options.method,"POST");
 assert.equal(f.calls[0].options.headers["content-profile"],"executive_visuals");
 assert.equal(f.calls[0].options.headers.authorization,"Bearer "+config.serviceRoleKey);
 assert.equal(JSON.parse(f.calls[0].options.body).object_path,asset.objectPath);
});

test("creates a cloud asset from a file using the streaming storage boundary",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-asset-file-test-")),file=join(root,"master.mp4");await writeFile(file,bytes);
 const f=fixture();const asset=await f.repo.createFromFile({ownerId,projectId,originalName:"master.mp4",mediaType:"video/mp4",filePath:file,metadata:{role:"master"}});
 assert.equal(asset.size,bytes.length);assert.equal(asset.sha256,createHash("sha256").update(bytes).digest("hex"));
 assert.equal(f.storageCalls[0].op,"uploadFile");assert.equal(JSON.parse(f.calls[0].options.body).sha256,asset.sha256);
 await rm(root,{recursive:true,force:true});
});
test("denies upload before touching storage when project role authorization fails",async()=>{
 const f=fixture({authorize:async()=>false});
 await assert.rejects(()=>f.repo.create({ownerId,projectId,originalName:"x.mp4",mediaType:"video/mp4",bytes}),e=>e.code==="CLOUD_ASSET_ACCESS_DENIED");
 assert.equal(f.storageCalls.length,0);assert.equal(f.calls.length,0);
});

test("compensates an uploaded object when metadata persistence fails",async()=>{
 const f=fixture({insertResponse:[]});
 await assert.rejects(()=>f.repo.create({ownerId,projectId,originalName:"x.mp4",mediaType:"video/mp4",bytes}),/expected record/);
 assert.deepEqual(f.storageCalls.map(x=>x.op),["upload","remove"]);
});

test("reports cleanup pending when metadata insert fails and object removal also fails",async()=>{
 const f=fixture({insertResponse:[],removeError:true});
 await assert.rejects(()=>f.repo.create({ownerId,projectId,originalName:"x.mp4",mediaType:"video/mp4",bytes}),e=>e.cleanupPending===true);
});

test("signed URL lookup checks record owner and project authorization",async()=>{
 let authorized=null;const f=fixture({authorize:async value=>{authorized=value;return true;}});
 const result=await f.repo.createSignedUrl({ownerId,assetId,expiresIn:300});
 assert.equal(result.url,"https://example.supabase.co/storage/signed");
 assert.equal(authorized.action,"read");assert.equal(authorized.projectId,projectId);
 assert.equal(f.storageCalls[0].op,"sign");
});

test("does not sign assets belonging to another owner",async()=>{
 const f=fixture({authorize:async()=>false});
 await assert.rejects(()=>f.repo.createSignedUrl({ownerId:"423e4567-e89b-42d3-a456-426614174000",assetId}),e=>e.code==="CLOUD_ASSET_ACCESS_DENIED");
 assert.equal(f.storageCalls.length,0);
});

test("soft-deletes metadata before removing the exact object and reports cleanup state",async()=>{
 const f=fixture();
 const result=await f.repo.softDelete({ownerId,assetId});
 assert.equal(result.deleted,true);assert.equal(result.storageRemoved,true);
 assert.equal(f.calls[1].options.method,"PATCH");
 assert.deepEqual(f.storageCalls.map(x=>x.op),["remove"]);
 assert.equal(f.storageCalls[0].path,f.row.object_path);
});

test("soft deletion remains private and exposes cleanup pending if object removal fails",async()=>{
 const f=fixture({removeError:true});
 const result=await f.repo.softDelete({ownerId,assetId});
 assert.equal(result.deleted,true);assert.equal(result.cleanupPending,true);
});

test("rejects malformed identifiers, unsupported media and non-object metadata",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.repo.create({ownerId:"bad",originalName:"x",mediaType:"video/mp4",bytes}),/UUID/);
 await assert.rejects(()=>f.repo.create({ownerId,originalName:"x",mediaType:"application/x-executable",bytes}),/Unsupported/);
 await assert.rejects(()=>f.repo.create({ownerId,originalName:"x",mediaType:"video/mp4",bytes,metadata:[]}),/JSON object/);
});

test("project collaborators can read and delete shared assets when the role callback authorizes them",async()=>{
 const collaboratorId="423e4567-e89b-42d3-a456-426614174000";
 const f=fixture({authorize:async({ownerId:actor,projectId:project,action})=>actor===collaboratorId&&project===projectId&&["read","write"].includes(action)});
 const signed=await f.repo.createSignedUrl({ownerId:collaboratorId,assetId});
 assert.equal(signed.asset.ownerId,ownerId);
 assert.equal(f.storageCalls[0].op,"sign");
 const deleted=await f.repo.softDelete({ownerId:collaboratorId,assetId});
 assert.equal(deleted.deleted,true);
});

test("lists only active assets within the authorized project and bounded page",async()=>{
 let authorized=null;const f=fixture({authorize:async value=>{authorized=value;return true;}});
 const result=await f.repo.list({ownerId,projectId,limit:500,offset:10});
 assert.equal(result.length,1);assert.equal(result[0].id,assetId);
 assert.equal(authorized.action,"read");assert.equal(authorized.projectId,projectId);
 assert.ok(f.calls[0].url.includes("project_id=eq."+projectId));
 assert.ok(f.calls[0].url.includes("limit=100"));assert.ok(f.calls[0].url.includes("offset=10"));
});
test("does not list project assets without read authorization",async()=>{
 const f=fixture({authorize:async()=>false});
 await assert.rejects(()=>f.repo.list({ownerId,projectId}),e=>e.code==="CLOUD_ASSET_ACCESS_DENIED");
 assert.equal(f.calls.length,0);
});

test("soft-deletes audio waveform sidecars with the original private object",async()=>{
 const f=fixture();f.row.media_type="audio/wav";
 const result=await f.repo.softDelete({ownerId,assetId});
 assert.equal(result.deleted,true);assert.equal(result.storageRemoved,true);
 assert.deepEqual(f.storageCalls.map(x=>x.path),[
  f.row.object_path,
  projectId+"/"+assetId+"/waveform-v1-"+f.row.sha256+".png"
 ]);
 assert.deepEqual(f.storageCalls.map(x=>x.op),["remove","remove"]);
});
test("reports pending cleanup when waveform sidecar removal fails after source deletion",async()=>{
 const f=fixture({removeError:true});f.row.media_type="audio/wav";
 const result=await f.repo.softDelete({ownerId,assetId});
 assert.equal(result.deleted,true);assert.equal(result.storageRemoved,false);assert.equal(result.cleanupPending,true);
 assert.equal(f.storageCalls.length,2);
});

test("updates cloud asset analysis metadata only after project write authorization",async()=>{
 let authorized=null;const f=fixture({authorize:async value=>{authorized=value;return true;}});
 const result=await f.repo.updateMetadata({ownerId,assetId,patch:{probe:{signalAnalysis:{audioActivity:{status:"completed"}}}}});
 assert.equal(authorized.action,"write");assert.equal(authorized.projectId,projectId);
 assert.equal(f.calls[0].options.method,"GET");
 assert.equal(f.calls[1].options.method,"PATCH");
 assert.deepEqual(JSON.parse(f.calls[1].options.body).metadata,{role:"master",probe:{signalAnalysis:{audioActivity:{status:"completed"}}}});
 assert.equal(result.id,assetId);
});
test("rejects cloud asset metadata update without project write authorization",async()=>{
 const f=fixture({authorize:async()=>false});
 await assert.rejects(()=>f.repo.updateMetadata({ownerId,assetId,patch:{probe:{}}}),e=>e.code==="CLOUD_ASSET_ACCESS_DENIED");
});
