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
 const calls=[],storageCalls=[];let publicationReservation=null,publicationAsset=null;
 const storage={
  async upload(path,data,type){storageCalls.push({op:"upload",path,data,type});return{bucket:"executive-visuals-media",path,size:data.byteLength,contentType:type};},
  async uploadFile(path,file,type,options={}){const data=await readFile(file);storageCalls.push({op:"uploadFile",path,file,type,options});return{bucket:"executive-visuals-media",path,size:data.byteLength,sha256:createHash("sha256").update(data).digest("hex"),contentType:type};},
  async createSignedUrl(path,expiry){storageCalls.push({op:"sign",path,expiry});return"https://example.supabase.co/storage/signed";},
  async remove(path){storageCalls.push({op:"remove",path});if(removeError)throw new Error("storage cleanup unavailable");return true;}
 };
 const row={id:assetId,owner_id:ownerId,project_id:projectId,original_name:"final cut.mp4",media_type:"video/mp4",byte_size:4,sha256:createHash("sha256").update(bytes).digest("hex"),storage_bucket:"executive-visuals-media",object_path:projectId+"/"+assetId+"/original.mp4",derivative_of:null,metadata:{role:"master"},created_at:"2026-11-01T00:00:00Z"};
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("/rpc/reserve_asset_publication")){
   const payload=JSON.parse(options.body);
   if(publicationReservation&&(publicationReservation.payload_sha256!==payload.p_payload_sha256||publicationReservation.project_id!==payload.p_project_id))return response({message:"publication conflict"},409);
   if(!publicationReservation)publicationReservation={owner_id:payload.p_owner_id,project_id:payload.p_project_id,publication_key:payload.p_publication_key,payload_sha256:payload.p_payload_sha256,asset_id:payload.p_asset_id,status:"reserved"};
   return response([publicationReservation]);
  }
  if(url.includes("/rpc/complete_asset_publication")){
   publicationReservation={...publicationReservation,status:"published"};
   return response([{owner_id:publicationReservation.owner_id,publication_key:publicationReservation.publication_key,asset_id:publicationReservation.asset_id,status:"published"}]);
  }
  if(url.includes("/assets?")&&options.method==="POST"&&publicationReservation){
   if(publicationAsset)return response({message:"duplicate asset identity"},409);
   const payload=JSON.parse(options.body);publicationAsset={...row,...payload,created_at:row.created_at};return response([publicationAsset]);
  }
  if(url.includes("/assets?")&&url.includes("id=eq.")&&publicationReservation)return response(publicationAsset?[publicationAsset]:[]);
  if(options.method==="POST"){const payload=JSON.parse(options.body);return response(insertResponse===null?[{...row,...payload,created_at:row.created_at}]:insertResponse);}
  if(options.method==="PATCH")return response([row]);
  return response([row]);
 };
 return {repo:createCloudAssetRepository({...config,storage,authorize,fetchImpl}),calls,storageCalls,row,get publicationReservation(){return publicationReservation;},get publicationAsset(){return publicationAsset;}};
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

test("publishes the same logical output once across repeated publication attempts",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-idempotent-publication-")),file=join(root,"render.mp4");
 await writeFile(file,bytes);
 const f=fixture();
 const args={ownerId,projectId,originalName:"render.mp4",mediaType:"video/mp4",filePath:file,publicationKey:"job-123:output:v1",metadata:{operation:"timeline.render"}};
 const first=await f.repo.createFromFileIdempotent(args);
 const second=await f.repo.createFromFileIdempotent(args);
 assert.equal(first.id,second.id);
 assert.equal(first.objectPath,second.objectPath);
 assert.equal(f.storageCalls.filter(call=>call.op==="uploadFile").length,1);
 assert.equal(f.storageCalls[0].options.upsert,false);
 assert.match(first.objectPath,/\\/attempt-[0-9a-f-]{36}\\.mp4$/i);
 assert.equal(f.publicationReservation.status,"published");
 await rm(root,{recursive:true,force:true});
});

test("rejects reuse of a publication key for different output bytes before storage upload",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-idempotent-conflict-")),file=join(root,"render.mp4");
 await writeFile(file,bytes);
 const f=fixture();
 const args={ownerId,projectId,originalName:"render.mp4",mediaType:"video/mp4",filePath:file,publicationKey:"job-123:output:v1"};
 await f.repo.createFromFileIdempotent(args);
 await writeFile(file,Buffer.from("different output"));
 await assert.rejects(()=>f.repo.createFromFileIdempotent(args),error=>error.code==="CLOUD_ASSET_HTTP_409");
 assert.equal(f.storageCalls.filter(call=>call.op==="uploadFile").length,1);
 await rm(root,{recursive:true,force:true});
});

test("concurrent attempts for one publication key converge on the same asset identity",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-idempotent-concurrent-")),file=join(root,"render.mp4");
 await writeFile(file,bytes);
 const f=fixture();
 const args={ownerId,projectId,originalName:"render.mp4",mediaType:"video/mp4",filePath:file,publicationKey:"job-concurrent:output:v1"};
 const [left,right]=await Promise.all([f.repo.createFromFileIdempotent(args),f.repo.createFromFileIdempotent(args)]);
 assert.equal(left.id,right.id);
 assert.equal(left.objectPath,right.objectPath);
 const uploads=f.storageCalls.filter(call=>call.op==="uploadFile");
 assert.equal(uploads.length,2,"concurrent workers write isolated attempt objects");
 assert.equal(new Set(uploads.map(call=>call.path)).size,2,"concurrent workers never share a storage object path");
 assert.ok(uploads.every(call=>call.options.upsert===false),"publication uploads must never overwrite");
 const removals=f.storageCalls.filter(call=>call.op==="remove");
 assert.equal(removals.length,1,"the losing attempt object is removed after the winner is verified");
 assert.ok(uploads.some(call=>call.path===left.objectPath));
 assert.ok(uploads.some(call=>call.path===removals[0].path));
 await rm(root,{recursive:true,force:true});
});
