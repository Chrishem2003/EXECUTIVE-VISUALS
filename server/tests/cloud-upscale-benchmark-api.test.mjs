import test from "node:test";
import assert from "node:assert/strict";
import {createCloudTimelineApi} from "../cloud-timeline-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const reviewer="223e4567-e89b-42d3-a456-426614174000";
const reviewerTwo="323e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const sourceId="523e4567-e89b-42d3-a456-426614174000";
const outputId="623e4567-e89b-42d3-a456-426614174000";
const fixtureId="723e4567-e89b-42d3-a456-426614174000";
const hash=char=>char.repeat(64);

function setup({memberRole="reviewer",runCount=1}={}){
 const calls=[],rows={fixture:null,run:null,jobs:[]};
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
  else if(path.startsWith("upscale_benchmark_runs")&&method==="GET"){
   if(rows.run&&runCount>1){
    const all=Array.from({length:runCount},(_,index)=>({...rows.run,id:"823e4567-e89b-42d3-a456-"+String(index+1).padStart(12,"0"),record:{...rows.run.record,fixtureId:"923e4567-e89b-42d3-a456-"+String(index+1).padStart(12,"0")}}));
    const offset=Number(url.searchParams.get("offset")||0),limit=Number(url.searchParams.get("limit")||all.length);
    result=all.slice(offset,offset+limit);
   }else result=rows.run?[{id:rows.run.id,owner_id:rows.run.owner_id,record:rows.run.record,reviewer_id:rows.run.reviewer_id,asset_id:rows.run.asset_id,fixture_id:rows.run.fixture_id,review_decision:rows.run.review_decision,review_note:rows.run.review_note,reviewed_at:rows.run.reviewed_at,created_at:rows.run.created_at}]:[];
  }
  else if(path.startsWith("upscale_benchmark_runs")&&method==="PATCH"){const b=JSON.parse(options.body);if(rows.run&&!rows.run.reviewer_id){Object.assign(rows.run,b);result=[rows.run];}}
  else if(path==="jobs"&&method==="POST"){const b=JSON.parse(options.body);const row={...b,output:null,error:null,created_at:"2026-11-02T12:03:00.000Z",updated_at:"2026-11-02T12:03:00.000Z"};rows.jobs.push(row);result=[row];}
  else if(path==="jobs"&&method==="GET"){result=rows.jobs;}
  else if(path==="job_events"&&method==="POST")result=[];
  else if(path==="projects")result=[{owner_id:owner}];
  else if(path==="project_members")result=memberRole?[{role:memberRole}]:[];
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

test("cloud benchmark API paginates evidence while keeping the report complete",async()=>{
 const f=setup({runCount:120});
 const fixture=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/fixtures",ownerId:owner,query:{projectId:project},body:{sourceAssetId:sourceId,category:"portrait"}});
 const run=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project},body:{assetId:outputId,fixtureId:fixture.body.fixture.id}});
 assert.equal(run.status,201);
 const first=await f.api.handle({method:"GET",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project,limit:"50",offset:"0"}});
 assert.equal(first.status,200);assert.equal(first.body.runs.length,50);assert.equal(first.body.page.hasMore,true);assert.equal(first.body.page.nextOffset,50);assert.equal(first.body.report.evidenceTruncated,false);
 const second=await f.api.handle({method:"GET",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project,limit:"50",offset:"50"}});
 assert.equal(second.body.page.offset,50);assert.equal(second.body.runs.length,50);assert.equal(second.body.page.hasMore,true);
 const third=await f.api.handle({method:"GET",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project,limit:"50",offset:"100"}});
 assert.equal(third.body.runs.length,20);assert.equal(third.body.page.hasMore,false);
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


test("cloud AI upscale queues a rights-confirmed idempotent job and lists durable worker status",async()=>{
 const f=setup();
 const body={projectId:project,sourceAssetId:sourceId,model:"realesrgan-x4plus",scale:4,tile:0,format:"png",rightsConfirmed:true};
 const queued=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:owner,body,idempotencyKey:"upscale-test-key-01"});
 assert.equal(queued.status,202);assert.equal(queued.body.job.job_type,"media.ai-upscale");assert.equal(queued.body.job.status,"queued");
 assert.equal(queued.body.job.input.sourceAssetId,sourceId);assert.equal(queued.body.job.input.sourceSha256,hash("c"));
 assert.ok(f.calls.some(call=>call.path==="job_events"&&call.method==="POST"));
 const replay=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:owner,body,idempotencyKey:"upscale-test-key-01"});
 assert.equal(replay.status,200);assert.equal(replay.body.idempotentReplay,true);assert.equal(replay.body.job.id,queued.body.job.id);
 const conflict=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:owner,body:{...body,scale:2},idempotencyKey:"upscale-test-key-01"});
 assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,"IDEMPOTENCY_CONFLICT");
 const list=await f.api.handle({method:"GET",path:"/api/cloud/upscale-jobs",ownerId:owner,query:{projectId:project}});
 assert.equal(list.status,200);assert.equal(list.body.jobs.length,1);assert.equal(list.body.jobs[0].status,"queued");
});


test("cloud AI upscale rejects missing rights confirmation, unsupported models and read-only members",async()=>{
 const f=setup();
 const base={projectId:project,sourceAssetId:sourceId,scale:4,tile:0,format:"png"};
 const noRights=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:owner,body:{...base,model:"realesrgan-x4plus",rightsConfirmed:false},idempotencyKey:"upscale-no-rights"});
 assert.equal(noRights.status,403);assert.equal(noRights.body.error.code,"MEDIA_RIGHTS_REQUIRED");
 const invalidModel=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:owner,body:{...base,model:"../untrusted-model",rightsConfirmed:true},idempotencyKey:"upscale-invalid-model"});
 assert.equal(invalidModel.status,400);assert.equal(invalidModel.body.error.code,"UPSCALE_OPTIONS_INVALID");
 const invalidTile=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:owner,body:{...base,model:"realesrgan-x4plus",tile:16,rightsConfirmed:true},idempotencyKey:"upscale-invalid-tile"});
 assert.equal(invalidTile.status,400);assert.equal(invalidTile.body.error.code,"UPSCALE_OPTIONS_INVALID");
 const readOnly=await f.api.handle({method:"POST",path:"/api/cloud/upscale",ownerId:reviewer,body:{...base,model:"realesrgan-x4plus",rightsConfirmed:true},idempotencyKey:"upscale-readonly-user"});
 assert.equal(readOnly.status,404);assert.equal(readOnly.body.error.code,"PROJECT_NOT_FOUND");
});


test("concurrent independent reviewers cannot overwrite the first immutable benchmark decision",async()=>{
 const f=setup();
 const fixture=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/fixtures",ownerId:owner,query:{projectId:project},body:{sourceAssetId:sourceId,category:"portrait"}});
 const run=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project},body:{assetId:outputId,fixtureId:fixture.body.fixture.id}});
 const decisions=await Promise.all([
  f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewer,query:{projectId:project},body:{decision:"reviewed_pass",note:"Reviewer one checked the result."}}),
  f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewerTwo,query:{projectId:project},body:{decision:"reviewed_fail",note:"Reviewer two checked the result."}})
 ]);
 assert.deepEqual(decisions.map(result=>result.status).sort(),[200,409]);
 assert.ok([reviewer,reviewerTwo].includes(f.rows.run.reviewer_id));
 assert.ok(["reviewed_pass","reviewed_fail"].includes(f.rows.run.review_decision));
 assert.equal(f.calls.filter(call=>call.path.startsWith("audit_events")&&call.method==="POST"&&call.body?.event_type==="upscale_benchmark.quality_reviewed").length,1);
});


test("cloud benchmark review rejects project members without the reviewer role",async()=>{
 const f=setup({memberRole:"viewer"});
 const fixture=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/fixtures",ownerId:owner,query:{projectId:project},body:{sourceAssetId:sourceId,category:"portrait"}});
 const run=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project},body:{assetId:outputId,fixtureId:fixture.body.fixture.id}});
 const denied=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewer,query:{projectId:project},body:{decision:"reviewed_pass",note:"Not authorized to review."}});
 assert.equal(denied.status,403);
 assert.equal(denied.body.error.code,"BENCHMARK_REVIEWER_REQUIRED");
 assert.equal(f.rows.run.reviewer_id,null);
 assert.equal(f.calls.filter(call=>call.path.startsWith("audit_events")&&call.body?.event_type==="upscale_benchmark.quality_reviewed").length,0);
});


test("cloud benchmark rejection requires a quality issue note and leaves the run pending otherwise",async()=>{
 const f=setup();
 const fixture=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/fixtures",ownerId:owner,query:{projectId:project},body:{sourceAssetId:sourceId,category:"portrait"}});
 const run=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs",ownerId:owner,query:{projectId:project},body:{assetId:outputId,fixtureId:fixture.body.fixture.id}});
 const missing=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewer,query:{projectId:project},body:{decision:"reviewed_fail",note:"   "}});
 assert.equal(missing.status,400);
 assert.equal(missing.body.error.code,"UPSCALE_BENCHMARK_REVIEW_NOTE_REQUIRED");
 assert.equal(f.rows.run.reviewer_id,null);
 const rejected=await f.api.handle({method:"POST",path:"/api/cloud/upscale-benchmarks/runs/"+run.body.run.id+"/review",ownerId:reviewer,query:{projectId:project},body:{decision:"reviewed_fail",note:"Visible ringing and loss of fine texture."}});
 assert.equal(rejected.status,200);
 assert.equal(rejected.body.run.review.note,"Visible ringing and loss of fine texture.");
});
