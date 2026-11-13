import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../db.mjs";
import { createEvidenceRecord, listEvidenceRecords, reviewEvidenceRecord, listEvidenceEvents, evidencePersistenceReady } from "../evidence-ledger.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),"ev-evidence-"));
  t.after(async()=>{ db.close(); await rm(dir,{recursive:true,force:true}); });
  const db = openDatabase(join(dir,"test.sqlite"));
  for (const [id,email] of [["owner","owner@example.test"],["reviewer","reviewer@example.test"],["viewer","viewer@example.test"]]) {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(id,email);
  }
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run("project-1","owner","Evidence project");
  db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run("project-1","reviewer","reviewer","owner");
  db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run("project-1","viewer","viewer","owner");
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,?,?,?,?,?,?)")
    .run("asset-1","owner","project-1","field-recording.mp4","video/mp4",128,"a".repeat(64),"asset-1.mp4");
  return {db,asset:{id:"asset-1",sha256:"a".repeat(64)}};
}
const submission = asset => ({
  ownerId:"owner",projectId:"project-1",sourceAsset:asset,targetType:"shot",targetId:"shot-12",
  kind:"performance_observation",claim:"The presenter demonstrates the approved product workflow.",
  method:"reviewed footage",sourceRef:"capture://field-day-01",observedAt:"2026-11-08T09:00:00Z",note:"Take 3"
});

test("submits evidence against an immutable source hash and creates an audit event",async t=>{
  const {db,asset}=await fixture(t);
  const record=createEvidenceRecord(db,submission(asset));
  assert.equal(record.status,"submitted");
  assert.equal(record.sourceSha256,"a".repeat(64));
  assert.deepEqual(record.target,{type:"shot",id:"shot-12"});
  assert.equal(record.kind,"performance_observation");
  const events=listEvidenceEvents(db,record.id);
  assert.equal(events.length,1);
  assert.equal(events[0].type,"submitted");
  assert.equal(listEvidenceRecords(db,{sourceAssetId:asset.id})[0].id,record.id);
});

test("review records reviewer identity and preserves an append-only event history",async t=>{
  const {db,asset}=await fixture(t);
  const record=createEvidenceRecord(db,submission(asset));
  const reviewed=reviewEvidenceRecord(db,{evidenceId:record.id,reviewerId:"reviewer",status:"verified",reviewNote:"Relevant source reviewed; claim scope accepted."});
  assert.equal(reviewed.status,"verified");
  assert.equal(reviewed.reviewedBy,"reviewer");
  assert.equal(reviewed.reviewNote,"Relevant source reviewed; claim scope accepted.");
  const events=listEvidenceEvents(db,record.id);
  assert.deepEqual(events.map(event=>event.type),["submitted","reviewed"]);
  assert.equal(events[1].actorId,"reviewer");
  assert.throws(()=>reviewEvidenceRecord(db,{evidenceId:record.id,reviewerId:"owner",status:"rejected",reviewNote:"A second final decision must be rejected."}),/EVIDENCE_ALREADY_REVIEWED/);
  assert.equal(listEvidenceEvents(db,record.id).length,2);
});

test("does not allow invalid evidence kinds, empty claims or invalid targets",async t=>{
  const {db,asset}=await fixture(t);
  assert.throws(()=>createEvidenceRecord(db,{...submission(asset),kind:"Bad Kind"}),/EVIDENCE_KIND_INVALID/);
  assert.throws(()=>createEvidenceRecord(db,{...submission(asset),claim:"short"}),/EVIDENCE_CLAIM_REQUIRED/);
  assert.throws(()=>createEvidenceRecord(db,{...submission(asset),targetType:"user"}),/EVIDENCE_TARGET_INVALID/);
  assert.throws(()=>createEvidenceRecord(db,{...submission(asset),observedAt:"not-a-date"}),/EVIDENCE_OBSERVED_AT_INVALID/);
});

test("does not allow client-selected review states",async t=>{
  const {db}=await fixture(t);
  assert.throws(()=>reviewEvidenceRecord(db,{evidenceId:"missing",reviewerId:"owner",status:"submitted"}),/EVIDENCE_REVIEW_STATE_INVALID/);
});


test("requires a meaningful reviewer reason before changing evidence status",async t=>{
 const {db,asset}=await fixture(t);
 const record=createEvidenceRecord(db,submission(asset));
 assert.throws(()=>reviewEvidenceRecord(db,{evidenceId:record.id,reviewerId:"reviewer",status:"verified",reviewNote:"ok"}),/EVIDENCE_REVIEW_REASON_REQUIRED/);
 assert.equal(listEvidenceEvents(db,record.id).length,1);
});

test("evidence source identity and audit events are append-only at the database boundary",async t=>{
  const {db,asset}=await fixture(t);
  const record=createEvidenceRecord(db,submission(asset));
  assert.throws(()=>db.prepare("UPDATE evidence_records SET source_sha256=? WHERE id=?").run("b".repeat(64),record.id),/EVIDENCE_RECORD_SOURCE_IMMUTABLE/);
  assert.throws(()=>db.prepare("DELETE FROM evidence_record_events WHERE evidence_id=?").run(record.id),/EVIDENCE_EVENTS_APPEND_ONLY/);
  assert.equal(listEvidenceEvents(db,record.id).length,1);
});

test("production evidence writes require an operator-confirmed persistent data volume",()=>{
 assert.equal(evidencePersistenceReady({nodeEnv:"production",persistence:"ephemeral"}),false);
 assert.equal(evidencePersistenceReady({nodeEnv:"production",persistence:"unverified"}),false);
 assert.equal(evidencePersistenceReady({nodeEnv:"production",persistence:"operator-confirmed-volume"}),true);
 assert.equal(evidencePersistenceReady({nodeEnv:"development",persistence:"unverified"}),true);
});
