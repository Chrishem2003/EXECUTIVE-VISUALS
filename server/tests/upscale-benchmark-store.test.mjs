import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,json} from "../db.mjs";
import {createUpscaleBenchmarkFixture,listUpscaleBenchmarkFixtures,registerUpscaleBenchmarkRun,listUpscaleBenchmarkRuns,reviewUpscaleBenchmarkRun,getUpscaleBenchmarkReport} from "../upscale-benchmark-store.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const reviewer="22222222-2222-4222-8222-222222222222";
const project="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceId="33333333-3333-4333-8333-333333333333";
const outputId="44444444-4444-4444-8444-444444444444";
const digest=char=>char.repeat(64);

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"ev-upscale-benchmark-"));
 const db=openDatabase(join(dir,"test.sqlite"));
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(owner,"owner@example.test");
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(reviewer,"reviewer@example.test");
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(project,owner,"Benchmark Lab");
 db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,reviewer,"reviewer",owner);
 db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,?,?,?,?,?,?)")
  .run(sourceId,owner,project,"portrait.png","image/png",100,digest("c"),"uploads/source.png");
 const metadata={processing:{
  schemaVersion:1,sourceAssetId:sourceId,inputSha256:digest("c"),outputSha256:digest("d"),
  model:"realesrgan-x4plus",modelVersion:digest("a")+":"+digest("b"),
  binarySha256:digest("a"),modelFilesSha256:digest("b"),
  sourceWidth:320,sourceHeight:240,width:1280,height:960,scale:4,durationMs:1250,
  dimensionsVerified:true,decoderVerified:true,qualityReview:"not_reviewed"
 }};
 db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,derivative_of,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run(outputId,owner,project,"portrait-upscaled.png","image/png",200,digest("d"),"derived/output.png",sourceId,json(metadata));
 return {dir,db,close:async()=>{db.close();await rm(dir,{recursive:true,force:true});}};
}

test("registers a controlled fixture and derives benchmark evidence from its exact derivative",async()=>{
 const f=await fixture();try{
  const fixtureRecord=createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"portrait",label:"Portrait detail"});
  assert.equal(fixtureRecord.sourceSha256,digest("c"));
  assert.equal(listUpscaleBenchmarkFixtures(f.db,project).length,1);
  const run=registerUpscaleBenchmarkRun(f.db,{ownerId:owner,projectId:project,assetId:outputId,fixtureId:fixtureRecord.id});
  assert.equal(run.record.inputSha256,digest("c"));
  assert.equal(run.record.outputSha256,digest("d"));
  assert.equal(run.record.qualityReview,"not_reviewed");
  assert.equal(listUpscaleBenchmarkRuns(f.db,project).length,1);
 }finally{await f.close();}
});

test("rejects a derivative whose input hash or parent does not match the registered fixture",async()=>{
 const f=await fixture();try{
  const fixtureRecord=createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"portrait"});
  f.db.prepare("UPDATE assets SET derivative_of=NULL WHERE id=?").run(outputId);
  assert.throws(()=>registerUpscaleBenchmarkRun(f.db,{ownerId:owner,projectId:project,assetId:outputId,fixtureId:fixtureRecord.id}),error=>error.code==="UPSCALE_BENCHMARK_EVIDENCE_INVALID"||error.code==="UPSCALE_BENCHMARK_FIXTURE_MISMATCH");
 }finally{await f.close();}
});

test("requires an independent reviewer and stores an immutable decision with an audit-ready record",async()=>{
 const f=await fixture();try{
  const fixtureRecord=createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"portrait"});
  const run=registerUpscaleBenchmarkRun(f.db,{ownerId:owner,projectId:project,assetId:outputId,fixtureId:fixtureRecord.id});
  assert.throws(()=>reviewUpscaleBenchmarkRun(f.db,{runId:run.id,projectId:project,reviewerId:owner,decision:"reviewed_pass"}),error=>error.code==="UPSCALE_BENCHMARK_INDEPENDENT_REVIEW_REQUIRED");
  assert.throws(()=>reviewUpscaleBenchmarkRun(f.db,{runId:run.id,projectId:project,reviewerId:reviewer,decision:"reviewed_fail"}),error=>error.code==="UPSCALE_BENCHMARK_REVIEW_NOTE_REQUIRED");
  const reviewed=reviewUpscaleBenchmarkRun(f.db,{runId:run.id,projectId:project,reviewerId:reviewer,decision:"reviewed_pass",note:"Source and output detail checked."});
  assert.equal(reviewed.record.qualityReview,"reviewed_pass");
  assert.equal(reviewed.review.reviewerId,reviewer);
  assert.throws(()=>reviewUpscaleBenchmarkRun(f.db,{runId:run.id,projectId:project,reviewerId:reviewer,decision:"reviewed_fail"}),error=>error.code==="UPSCALE_BENCHMARK_ALREADY_REVIEWED");
  assert.equal(getUpscaleBenchmarkReport(f.db,project).runCount,1);
 }finally{await f.close();}
});


test("rejects a derivative with the right parent ID but a different source fingerprint",async()=>{
 const f=await fixture();try{
  const fixtureRecord=createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"portrait"});
  const asset=f.db.prepare("SELECT metadata_json FROM assets WHERE id=?").get(outputId);
  const metadata=JSON.parse(asset.metadata_json);
  metadata.processing.inputSha256=digest("e");
  f.db.prepare("UPDATE assets SET metadata_json=? WHERE id=?").run(json(metadata),outputId);
  assert.throws(()=>registerUpscaleBenchmarkRun(f.db,{ownerId:owner,projectId:project,assetId:outputId,fixtureId:fixtureRecord.id}),error=>error.code==="UPSCALE_BENCHMARK_FIXTURE_MISMATCH");
 }finally{await f.close();}
});

test("rejects unsupported categories and duplicate fixture source registration",async()=>{
 const f=await fixture();try{
  assert.throws(()=>createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"landscape"}),error=>error.code==="UPSCALE_FIXTURE_INVALID");
  createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"portrait"});
  assert.throws(()=>createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:sourceId,category:"portrait"}),error=>error.code==="UPSCALE_FIXTURE_EXISTS");
  const gifId="93333333-3333-4333-8333-333333333333";
  f.db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,?,?,?,?,?,?)")
   .run(gifId,owner,project,"animated.gif","image/gif",100,digest("f"),"uploads/animated.gif");
  assert.throws(()=>createUpscaleBenchmarkFixture(f.db,{ownerId:owner,projectId:project,sourceAssetId:gifId,category:"portrait"}),error=>error.code==="UPSCALE_FIXTURE_SOURCE_INVALID");
 }finally{await f.close();}
});
