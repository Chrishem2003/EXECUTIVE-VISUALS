import test from "node:test";
import assert from "node:assert/strict";
import { createCloudTimelineRepository } from "../cloud-timelines.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const project="22222222-2222-4222-8222-222222222222";
const timelineId="33333333-3333-4333-8333-333333333333";
const assetId="44444444-4444-4444-8444-444444444444";
const base={url:"https://cloud.example",serviceRoleKey:"server-secret"};
const document={frameRate:{numerator:30,denominator:1},tracks:[{id:"video-1",kind:"video",clips:[{id:"clip-1",assetId,timelineStart:{value:0,rate:30},duration:{value:30,rate:30},sourceRange:{start:{value:0,rate:30},duration:{value:30,rate:30}}}]}],markers:[]};
const asset={id:assetId,name:"scene.mp4",mediaType:"video/mp4",size:12,sha256:"a".repeat(64)};
function response(rows,status=200){return{ok:status>=200&&status<300,status,async text(){return JSON.stringify(rows);}};}
function setup({authorize=async()=>true,assetLookup=async()=>asset,fetchImpl}={}){
 const calls=[];let row=null,versionCounter=0;const versions=[];
 const nextVersionId=()=> "55555555-5555-4555-8555-"+String(++versionCounter).padStart(12,"0");
 const fetcher=fetchImpl||(async(url,options)=>{
  calls.push({url,options});
  const parsed=new URL(url),path=parsed.pathname,body=options.body?JSON.parse(options.body):{};
  if(path.endsWith("/rpc/ev_create_timeline_with_version")){
   row={id:body.p_timeline_id,owner_id:body.p_owner_id,project_id:body.p_project_id,name:body.p_name,revision:1,timeline:body.p_timeline,otio:body.p_otio,created_at:"2026-11-01T00:00:00Z",updated_at:"2026-11-01T00:00:00Z"};
   versions.push({id:nextVersionId(),timeline_id:row.id,owner_id:row.owner_id,project_id:row.project_id,revision:1,parent_version_id:null,restored_from_version_id:null,name:row.name,summary:body.p_summary,content_hash:body.p_content_hash,timeline:row.timeline,otio:row.otio,created_by:body.p_actor_id,created_at:row.created_at});
   return response([row]);
  }
  if(path.endsWith("/rpc/ev_update_timeline_with_version")){
   if(!row||row.revision!==body.p_expected_revision)return response({message:"revision conflict"},409);
   const parent=versions.find(version=>version.revision===row.revision);
   row={...row,name:body.p_name,revision:row.revision+1,timeline:body.p_timeline,otio:body.p_otio,updated_at:"2026-11-01T00:01:00Z"};
   versions.push({id:nextVersionId(),timeline_id:row.id,owner_id:row.owner_id,project_id:row.project_id,revision:row.revision,parent_version_id:parent?.id||null,restored_from_version_id:null,name:row.name,summary:body.p_summary,content_hash:body.p_content_hash,timeline:row.timeline,otio:row.otio,created_by:body.p_actor_id,created_at:row.updated_at});
   return response([row]);
  }
  if(path.endsWith("/rpc/ev_restore_timeline_version")){
   if(!row||row.revision!==body.p_expected_revision)return response({message:"revision conflict"},409);
   const source=versions.find(version=>version.id===body.p_source_version_id&&version.timeline_id===row.id);
   if(!source)return response({message:"source missing"},404);
   const parent=versions.find(version=>version.revision===row.revision);
   row={...row,name:source.name,revision:row.revision+1,timeline:source.timeline,otio:source.otio,updated_at:"2026-11-01T00:02:00Z"};
   versions.push({id:nextVersionId(),timeline_id:row.id,owner_id:row.owner_id,project_id:row.project_id,revision:row.revision,parent_version_id:parent?.id||null,restored_from_version_id:source.id,name:row.name,summary:body.p_summary,content_hash:body.p_content_hash,timeline:row.timeline,otio:row.otio,created_by:body.p_actor_id,created_at:row.updated_at});
   return response([row]);
  }
  if(path.endsWith("/timeline_versions")&&options.method==="GET"){
   const id=parsed.searchParams.get("id")?.replace("eq.","");
   const found=versions.filter(version=>version.timeline_id===parsed.searchParams.get("timeline_id")?.replace("eq.","")&&version.owner_id===parsed.searchParams.get("owner_id")?.replace("eq.","")&&(!id||version.id===id));
   return response(found.sort((a,b)=>b.revision-a.revision));
  }
  if(path.endsWith("/timelines")&&options.method==="GET")return response(row?[row]:[]);
  if(path.endsWith("/timelines")&&options.method==="PATCH"){
   const expected=Number(parsed.searchParams.get("revision")?.replace("eq.",""));
   if(!row||row.revision!==expected)return response([]);
   row={...row,...body};return response([row]);
  }
  return response([],405);
 });
 const repo=createCloudTimelineRepository({...base,authorize,getAsset:assetLookup,fetchImpl:fetcher});
 return{repo,calls,get row(){return row;},get versions(){return versions;}};
}

test("creates and reads a validated timeline using the shared authorized asset registry",async()=>{
 const f=setup();const created=await f.repo.create({ownerId:owner,projectId:project,name:"Episode master",timeline:document});
 assert.equal(created.revision,1);assert.equal(created.projectId,project);assert.equal(created.timeline.tracks[0].clips[0].assetId,assetId);
 assert.equal(f.calls[0].options.headers["content-profile"],"executive_visuals");
 assert.equal(f.calls[0].options.headers.authorization,"Bearer server-secret");
 const loaded=await f.repo.get({ownerId:owner,timelineId:created.id});
 assert.equal(loaded.id,created.id);assert.equal(loaded.revision,1);
});

test("updates timelines with optimistic revision fencing and detects stale editors",async()=>{
 const f=setup();const created=await f.repo.create({ownerId:owner,name:"Master",timeline:document});
 const updated=await f.repo.update({ownerId:owner,timelineId:created.id,expectedRevision:1,timeline:{...document,markers:[{id:"marker-1",start:{value:30,rate:30}}]}});
 assert.equal(updated.revision,2);
 await assert.rejects(()=>f.repo.update({ownerId:owner,timelineId:created.id,expectedRevision:1,timeline:document}),error=>error.code==="CLOUD_TIMELINE_REVISION_CONFLICT");
});

test("rejects unauthorized collaborators and invalid asset references before persistence",async()=>{
 const denied=setup({authorize:async({action})=>action!=="write"});
 await assert.rejects(()=>denied.repo.create({ownerId:owner,projectId:project,timeline:document}),error=>error.code==="CLOUD_TIMELINE_ACCESS_DENIED");
 assert.equal(denied.calls.length,0);
 const missing=setup({assetLookup:async()=>{throw new Error("not found");}});
 await assert.rejects(()=>missing.repo.create({ownerId:owner,timeline:document}),error=>error.code==="CLOUD_TIMELINE_INVALID");
 assert.equal(missing.calls.length,0);
});

test("rejects malformed timeline structure and mismatched media types",async()=>{
 const f=setup({assetLookup:async()=>({...asset,mediaType:"audio/mpeg"})});
 await assert.rejects(()=>f.repo.create({ownerId:owner,timeline:document}),error=>error.code==="CLOUD_TIMELINE_INVALID");
 const invalid={...document,tracks:[{...document.tracks[0],clips:[{...document.tracks[0].clips[0],speed:2}]}]};
 await assert.rejects(()=>f.repo.create({ownerId:owner,timeline:invalid}),error=>error.code==="CLOUD_TIMELINE_INVALID");
});

test("rejects stale revisions and unsafe identifiers",async()=>{
 const f=setup();
 await assert.rejects(()=>f.repo.get({ownerId:owner,timelineId:"not-a-uuid"}),/Timeline ID/);
 await assert.rejects(()=>f.repo.create({ownerId:owner,timeline:{}}),error=>error.code==="CLOUD_TIMELINE_INVALID");
});

test("fails closed when the cloud API rejects a timeline operation",async()=>{
 const f=setup({fetchImpl:async()=>response({message:"permission denied"},403)});
 await assert.rejects(()=>f.repo.get({ownerId:owner,timelineId}),error=>error.code==="CLOUD_TIMELINE_HTTP_403");
});

test("lists active cloud timelines for an authorized project with bounded pagination",async()=>{
 const f=setup();await f.repo.create({ownerId:owner,projectId:project,name:"Episode master",timeline:document});
 const result=await f.repo.list({ownerId:owner,projectId:project,limit:500,offset:5});
 assert.equal(result.length,1);assert.equal(result[0].projectId,project);
 const listCall=f.calls.find(x=>x.url.includes("timelines?")&&x.options.method==="GET");
 assert.ok(listCall.url.includes("project_id=eq."+project));assert.ok(listCall.url.includes("limit=100"));assert.ok(listCall.url.includes("offset=5"));
});
test("does not list cloud timelines when project read permission is denied",async()=>{
 const f=setup({authorize:async()=>false});
 await assert.rejects(()=>f.repo.list({ownerId:owner,projectId:project}),error=>error.code==="CLOUD_TIMELINE_ACCESS_DENIED");
 assert.equal(f.calls.length,0);
});


test("cloud timeline versions are append-only, integrity checked and restore with two-way lineage",async()=>{
 const f=setup();
 const created=await f.repo.create({ownerId:owner,projectId:project,name:"Episode master",timeline:document});
 const initial=(await f.repo.listVersions({ownerId:owner,timelineId:created.id}))[0];
 assert.equal(initial.revision,1);
 assert.equal(initial.parentVersionId,null);
 const changed={...document,markers:[{id:"marker-1",start:{value:30,rate:30}}]};
 const updated=await f.repo.update({ownerId:owner,timelineId:created.id,expectedRevision:1,timeline:changed,versionSummary:"Added a review marker"});
 assert.equal(updated.revision,2);
 const versions=await f.repo.listVersions({ownerId:owner,timelineId:created.id});
 assert.equal(versions.length,2);
 assert.equal(versions[0].revision,2);
 assert.equal(versions[0].parentVersionId,initial.id);
 const source=await f.repo.getVersion({ownerId:owner,timelineId:created.id,versionId:initial.id});
 assert.deepEqual(source.document,document);
 const restored=await f.repo.restore({ownerId:owner,timelineId:created.id,expectedRevision:2,sourceVersionId:initial.id});
 assert.equal(restored.revision,3);
 assert.deepEqual(restored.timeline,document);
 const lineage=await f.repo.listVersions({ownerId:owner,timelineId:created.id});
 assert.equal(lineage.length,3);
 assert.equal(lineage[0].parentVersionId,versions[0].id);
 assert.equal(lineage[0].restoredFromVersionId,initial.id);
});

test("cloud version snapshots fail closed when their content hash does not match",async()=>{
 const f=setup();
 const created=await f.repo.create({ownerId:owner,name:"Integrity",timeline:document});
 f.versions[0].content_hash="f".repeat(64);
 await assert.rejects(()=>f.repo.getVersion({ownerId:owner,timelineId:created.id,versionId:f.versions[0].id}),error=>error.code==="CLOUD_TIMELINE_VERSION_CORRUPT");
});

test("cloud version history obeys project read authorization",async()=>{
 const f=setup({authorize:async({action})=>action!=="read"});
 const created=await f.repo.create({ownerId:owner,projectId:project,name:"Private history",timeline:document});
 await assert.rejects(()=>f.repo.listVersions({ownerId:owner,timelineId:created.id}),error=>error.code==="CLOUD_TIMELINE_ACCESS_DENIED");
});
