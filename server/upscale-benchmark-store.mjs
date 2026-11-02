import { randomUUID } from "node:crypto";
import { parseJson, json } from "./db.mjs";
import { REQUIRED_UPSCALE_FIXTURE_CATEGORIES, buildUpscaleBenchmarkRecordFromAsset, compareUpscaleBenchmarkCandidates } from "./upscale-benchmark.mjs";

const CATEGORIES = new Set(REQUIRED_UPSCALE_FIXTURE_CATEGORIES);
const problem = (code,message,status=400) => Object.assign(new Error(message),{code,status});

export function createUpscaleBenchmarkFixture(db,{ownerId,projectId,sourceAssetId,category,label}={}) {
  if(!ownerId||!projectId||!sourceAssetId||!CATEGORIES.has(category)) throw problem("UPSCALE_FIXTURE_INVALID","A project, source image and supported fixture category are required.");
  const asset=db.prepare("SELECT * FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL").get(sourceAssetId,projectId);
  if(!asset||asset.owner_id!==ownerId&&!db.prepare("SELECT 1 FROM project_members WHERE project_id=? AND member_id=? AND role IN ('editor','owner')").get(projectId,ownerId)) throw problem("UPSCALE_FIXTURE_SOURCE_UNAVAILABLE","The fixture source must be an accessible image in this project.",404);
  if(!String(asset.media_type||"").startsWith("image/")) throw problem("UPSCALE_FIXTURE_SOURCE_INVALID","Benchmark fixtures must be still images.");
  const id=randomUUID();
  try {
    db.prepare("INSERT INTO upscale_benchmark_fixtures(id,owner_id,project_id,source_asset_id,source_sha256,fixture_category,label) VALUES(?,?,?,?,?,?,?)")
      .run(id,ownerId,projectId,asset.id,asset.sha256,category,String(label||asset.original_name||category).trim().slice(0,120));
  } catch(error) {
    if(String(error.message||"").includes("UNIQUE")) throw problem("UPSCALE_FIXTURE_EXISTS","This source asset is already registered as a fixture in this project.",409);
    throw error;
  }
  return getUpscaleBenchmarkFixture(db,id,projectId);
}

export function getUpscaleBenchmarkFixture(db,id,projectId) {
  const row=db.prepare("SELECT * FROM upscale_benchmark_fixtures WHERE id=? AND project_id=?").get(id,projectId);
  return row?{id:row.id,projectId:row.project_id,sourceAssetId:row.source_asset_id,sourceSha256:row.source_sha256,category:row.fixture_category,label:row.label,createdAt:row.created_at}:null;
}

export function listUpscaleBenchmarkFixtures(db,projectId) {
  return db.prepare("SELECT * FROM upscale_benchmark_fixtures WHERE project_id=? ORDER BY created_at DESC").all(projectId)
    .map(row=>({id:row.id,projectId:row.project_id,sourceAssetId:row.source_asset_id,sourceSha256:row.source_sha256,category:row.fixture_category,label:row.label,createdAt:row.created_at}));
}

export function registerUpscaleBenchmarkRun(db,{ownerId,projectId,assetId,fixtureId}={}) {
  const fixture=db.prepare("SELECT * FROM upscale_benchmark_fixtures WHERE id=? AND project_id=?").get(fixtureId,projectId);
  const asset=db.prepare("SELECT * FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL").get(assetId,projectId);
  if(!fixture||!asset) throw problem("UPSCALE_BENCHMARK_ASSET_UNAVAILABLE","The fixture or output asset is unavailable in this project.",404);
  if(asset.owner_id!==ownerId&&!db.prepare("SELECT 1 FROM project_members WHERE project_id=? AND member_id=? AND role IN ('editor','owner')").get(projectId,ownerId)) throw problem("UPSCALE_BENCHMARK_WRITE_DENIED","Editor access is required to register benchmark evidence.",403);
  const outputAsset={id:asset.id,mediaType:asset.media_type,sha256:asset.sha256,derivativeOf:asset.derivative_of,createdAt:asset.created_at,metadata:parseJson(asset.metadata_json,{})};
  const record=buildUpscaleBenchmarkRecordFromAsset({outputAsset,fixtureId:fixture.id,fixtureCategory:fixture.fixture_category});
  if(record.inputSha256!==fixture.source_sha256||outputAsset.derivativeOf!==fixture.source_asset_id) throw problem("UPSCALE_BENCHMARK_FIXTURE_MISMATCH","The derivative does not originate from the exact registered fixture source.",409);
  const id=randomUUID();
  try {
    db.prepare("INSERT INTO upscale_benchmark_runs(id,owner_id,project_id,asset_id,fixture_id,fixture_category,model,model_version,record_json) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id,ownerId,projectId,asset.id,fixture.id,fixture.fixture_category,record.model,record.modelVersion,json(record));
  } catch(error) {
    if(String(error.message||"").includes("UNIQUE")) throw problem("UPSCALE_BENCHMARK_ALREADY_REGISTERED","This derivative is already registered for this fixture.",409);
    throw error;
  }
  return {id,assetId:asset.id,fixtureId:fixture.id,record,review:{decision:null,reviewerId:null,reviewedAt:null}};
}

export function listUpscaleBenchmarkRuns(db,projectId) {
  return db.prepare("SELECT * FROM upscale_benchmark_runs WHERE project_id=? ORDER BY created_at DESC").all(projectId).map(row=>({
    id:row.id,assetId:row.asset_id,fixtureId:row.fixture_id,record:parseJson(row.record_json,{}),
    review:{decision:row.review_decision,reviewerId:row.reviewer_id,reviewedAt:row.reviewed_at,note:row.review_note},
    createdAt:row.created_at
  }));
}

export function reviewUpscaleBenchmarkRun(db,{runId,projectId,reviewerId,decision,note}={}) {
  if(!["reviewed_pass","reviewed_fail"].includes(decision)) throw problem("UPSCALE_BENCHMARK_REVIEW_INVALID","Review decision must be reviewed_pass or reviewed_fail.");
  const row=db.prepare("SELECT * FROM upscale_benchmark_runs WHERE id=? AND project_id=?").get(runId,projectId);
  if(!row) throw problem("UPSCALE_BENCHMARK_RUN_NOT_FOUND","Benchmark run not found.",404);
  if(row.reviewer_id) throw problem("UPSCALE_BENCHMARK_ALREADY_REVIEWED","Benchmark evidence already has an immutable reviewer decision.",409);
  if(row.owner_id===reviewerId) throw problem("UPSCALE_BENCHMARK_INDEPENDENT_REVIEW_REQUIRED","The person who registered this run cannot review their own evidence.",403);
  const record=parseJson(row.record_json,{});
  record.qualityReview=decision;
  const reviewedAt=new Date().toISOString();
  const reviewNote=String(note||"").trim().slice(0,2000);
  const changed=db.prepare("UPDATE upscale_benchmark_runs SET record_json=?,reviewer_id=?,review_decision=?,review_note=?,reviewed_at=? WHERE id=? AND reviewer_id IS NULL")
    .run(json(record),reviewerId,decision,reviewNote,reviewedAt,row.id);
  if(changed.changes!==1) throw problem("UPSCALE_BENCHMARK_ALREADY_REVIEWED","Benchmark evidence was reviewed by another user.",409);
  return {id:row.id,record,review:{decision,reviewerId,reviewedAt,note:reviewNote}};
}

export function getUpscaleBenchmarkReport(db,projectId) {
  const runs=listUpscaleBenchmarkRuns(db,projectId);
  return {runCount:runs.length,report:compareUpscaleBenchmarkCandidates(runs.map(run=>run.record)),runs};
}
