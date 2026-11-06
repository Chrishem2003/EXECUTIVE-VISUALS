import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getJobStageTimeline, recordJobStage } from "../job-observability.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE job_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,owner_id TEXT NOT NULL,event_type TEXT NOT NULL,event_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);");
  return db;
}

test("records a stage lifecycle and derives elapsed duration", () => {
  const db = fixture();
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"execution",label:"Media execution",status:"running",timestamp:"2026-11-06T10:00:00.000Z"});
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"execution",label:"Media execution",status:"succeeded",attributes:{progress:100,durationMs:4200},timestamp:"2026-11-06T10:00:04.200Z"});
  const [stage]=getJobStageTimeline(db,"job-1","owner-1");
  assert.equal(stage.status,"succeeded");
  assert.equal(stage.durationMs,4200);
  assert.equal(stage.attributes.progress,100);
  db.close();
});

test("does not leak stage details across owners", () => {
  const db=fixture();
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"execution",label:"Private stage",status:"running"});
  assert.deepEqual(getJobStageTimeline(db,"job-1","owner-2"),[]);
  db.close();
});

test("only stores allowlisted scalar attributes", () => {
  const db=fixture();
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"node:a",label:"Render node",status:"failed",attributes:{errorCode:"RENDER_FAILED",prompt:"private prompt",token:"secret",nodeKind:"render",retryable:false}});
  const [stage]=getJobStageTimeline(db,"job-1","owner-1");
  assert.equal(stage.attributes.errorCode,"RENDER_FAILED");
  assert.equal(stage.attributes.nodeKind,"render");
  assert.equal(stage.attributes.retryable,false);
  assert.equal("prompt" in stage.attributes,false);
  assert.equal("token" in stage.attributes,false);
  db.close();
});

test("rejects invalid stage states and malformed identifiers", () => {
  const db=fixture();
  assert.throws(()=>recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"",label:"No ID",status:"running"}),e=>e.code==="INVALID_JOB_STAGE");
  assert.throws(()=>recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"execution",label:"Execution",status:"unknown"}),e=>e.code==="INVALID_JOB_STAGE_STATUS");
  db.close();
});

test("restarts stage timing when a retry enters the same stage again", () => {
  const db=fixture();
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"encode",label:"Encode",status:"running",timestamp:"2026-11-06T10:00:00.000Z"});
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"encode",label:"Encode",status:"failed",timestamp:"2026-11-06T10:00:02.000Z"});
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"encode",label:"Encode",status:"running",attributes:{attempt:2},timestamp:"2026-11-06T10:01:00.000Z"});
  recordJobStage(db,{jobId:"job-1",ownerId:"owner-1",stageId:"encode",label:"Encode",status:"succeeded",timestamp:"2026-11-06T10:01:03.000Z"});
  const [stage]=getJobStageTimeline(db,"job-1","owner-1");
  assert.equal(stage.durationMs,3000);
  assert.equal(stage.startedAt,"2026-11-06T10:01:00.000Z");
  db.close();
});
