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
 const calls=[];let row=null;
 const fetcher=fetchImpl||(async(url,options)=>{
  calls.push({url,options});
  if(options.method==="POST"){row={...JSON.parse(options.body),created_at:"2026-11-01T00:00:00Z",updated_at:"2026-11-01T00:00:00Z"};return response([row]);}
  if(options.method==="GET")return response(row?[row]:[]);
  if(options.method==="PATCH"){
   const expected=Number(new URL(url).searchParams.get("revision")?.replace("eq.",""));
   if(!row||row.revision!==expected)return response([]);
   row={...row,...JSON.parse(options.body)};return response([row]);
  }
  return response([],405);
 });
 const repo=createCloudTimelineRepository({...base,authorize,getAsset:assetLookup,fetchImpl:fetcher});
 return{repo,calls,get row(){return row;}};
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

test("accepts valid adjacent dip-to-black transitions and rejects invalid transition contracts",async()=>{
 const f=setup();
 const first={...document.tracks[0].clips[0],transitionToNext:{type:"dip-to-black",fadeFrames:6}};
 const second={...document.tracks[0].clips[0],id:"clip-2",timelineStart:{value:30,rate:30}};
 const transitioned={...document,tracks:[{...document.tracks[0],clips:[first,second]}]};
 const created=await f.repo.create({ownerId:owner,timeline:transitioned});
 assert.deepEqual(created.timeline.tracks[0].clips[0].transitionToNext,{type:"dip-to-black",fadeFrames:6});
 const invalidFade={...transitioned,tracks:[{...transitioned.tracks[0],clips:[{...first,transitionToNext:{type:"dip-to-black",fadeFrames:0}},second]}]};
 await assert.rejects(()=>setup().repo.create({ownerId:owner,timeline:invalidFade}),error=>error.code==="CLOUD_TIMELINE_INVALID");
 const gap={...transitioned,tracks:[{...transitioned.tracks[0],clips:[first,{...second,timelineStart:{value:31,rate:30}}]}]};
 await assert.rejects(()=>setup().repo.create({ownerId:owner,timeline:gap}),error=>error.code==="CLOUD_TIMELINE_INVALID");
 const audio={...transitioned,tracks:[{...transitioned.tracks[0],kind:"audio"}]};
 const audioRepo=setup({assetLookup:async()=>({...asset,mediaType:"audio/mpeg"})});
 await assert.rejects(()=>audioRepo.repo.create({ownerId:owner,timeline:audio}),error=>error.code==="CLOUD_TIMELINE_INVALID");
});
