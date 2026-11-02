import test from "node:test";
import assert from "node:assert/strict";
import {createCloudTimelineApi} from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const reviewer="223e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const sourceId="523e4567-e89b-42d3-a456-426614174000";
const outputId="623e4567-e89b-42d3-a456-426614174000";
const fixtureId="723e4567-e89b-42d3-a456-426614174000";
const hash=char=>char.repeat(64);

function setup(){
 const calls=[],rows={fixture:null,run:null};
 const assets={
  async get({assetId}){if(assetId===sourceId)return{id:sourceId,ownerId:owner,projectId:project,name:"portrait.png",mediaType:"image/png",sha256:hash("c"),metadata:{},derivativeOf:null};
   if(assetId===outputId)return{id:outputId,ownerId:owner,projectId:project,name:"portrait-upscaled.png",mediaType:"image/png",sha256:hash("d"),derivativeOf:sourceId,createdAt:"2026-11-02T12:00:00.000Z",metadata:{processing:{schemaVersion:1,sourceAssetId:sourceId,inputSha256:hash("c"),outputSha256:hash("d"),model:"realesrgan-x4plus",modelVersion:hash("a")+":"+hash("b"),binarySha256:hash("a"),modelFilesSha256:hash("b"),sourceWidth:320,sourceHeight:240,width:1280,height:960,scale:4,durationMs:1250,dimensionsVerified:true,decoderVerified:true,qualityReview:"not_reviewed"}}};
   throw Object.assign(new Error("missing asset"),{code:"CLOUD_ASSET_NOT_FOUND"});}
 };
 const fetchImpl=async(input,options={})=>{
  const url=new URL(input),path=url.pathname.split("/rest/v1/")[1]||"",method=options.method||"GET";calls.push({path,method,body:options.body?JSON.parse(options.body):null});
  let result=[];
  if(path.startsWith("upscale_benchmark_fixtures")&&method==="POST"){const b=JSON.parse(options.body);rows.fixture={...b,created_at:"2026-11-02T12:01:00.000Z"};result=[{id:b.id,created_at:rows.fixture.created_at}];}
  else if(path.startsWith("upscale_benchmark_fixtures")&&method==="GET"){result=rows.fixture?[{id:rows.fixture.id,source_asset_id:rows.fixture.source_asset_id,source_sha256:rows.fixture.source_sha256,fixture_category:rows.fixture.fixture_category}]:[];}
  else if(path.startsWith("upscale_benchmark_runs")&&method==="POST"){const b=JSON.parse(options.body);rows.run={...b,reviewer_id:null,review_decision:null,created_at:"2026-11-02T12:02:00.000Z"};result=[{id:b.id,created_at:rows.run.created_at}];}
  else if(path.startsWith("upscale_benchmark_runs")&&method==="GET"){result=rows.run?[{id:rows.run.id,owner_id:rows.run.owner_id,record:rows.run.record,reviewer_id:rows.run.reviewer_id}]:[];}
  else if(path.startsWith("upscale_benchmark_runs")&&method==="PATCH"){const b=JSON.parse(options.body);if(rows.run&&!rows.run.reviewer_id){Object.assign(rows.run,b);result=[rows.run];}}
  else if(path==="projects")result=[{owner_id:owner}];
  else if(path==="project_members")result=[{role:"reviewer"}];
  else if(path.startsWith("audit_events"))result=[];
  return{ok:true,status:200,async text(){return JSON.stringify(result);}};
 };
 const api=createCloudTimelineApi({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl,timelineService:{assets,timelines:{},projects:{}},authorize:async({ownerId,projectId,action})=>projectId===project&&(action==="read"||ownerId===owner)});
 return{api,calls,rows};
}

test("cloud benchmark API pins fixture source, registers verified derivative and returns candidate report",async()=>{
 const f=setup();
 const fixture=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/fixtures",ownerId:owner,query:{projectId:project},body:{sourceAssetId:sourceId,category:"portrait"}});
 assert.equal(fixture.status,201);assert.equal(fixture.body.fixture.sourceSha256,hash("c"));
 const run=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project},body:{assetId:outputId,fixtureId:fixture.body.fixture.id}});
 assert.equal(run.status,201);assert.equal(run.body.run.record.outputSha256,hash("d"));
 const list=await f.api.handle({method:"GET",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project}});
 assert.equal(list.status,200);assert.equal(list.body.report.candidateCount,1);
 assert.ok(f.calls.some(call=>call.path.startsWith("audit_events")&&call.method==="POST"));
});

test("cloud benchmark API requires independent assigned review and stores immutable decision",async()=>{
 const f=setup();
 const fixture=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/fixtures",ownerId:owner,query:{projectId:project},body:{sourceAssetId:sourceId,category:"portrait"}});
 const run=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project},body:{assetId:outputId,fixtureId:fixture.body.fixture.id}});
 const self=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:owner,query:{projectId:project},body:{decision:"reviewed_pass"}});
 assert.equal(self.status,403);assert.equal(self.body.error.code,"UPSCALE_BENCHMARK_INDEPENDENT_REVIEW_REQUIRED");
 const reviewed=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewer,query:{projectId:project},body:{decision:"reviewed_pass",note:"Visual check passed."}});
 assert.equal(reviewed.status,200);assert.equal(reviewed.body.run.record.qualityReview,"reviewed_pass");
 const duplicate=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewer,query:{projectId:project},body:{decision:"reviewed_fail"}});
 assert.equal(duplicate.status,409);assert.equal(duplicate.body.error.code,"UPSCALE_BENCHMARK_ALREADY_REVIEWED");
});
