import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, recordModelUsage } from "../db.mjs";

test("model usage ledger persists scoped provider events without prompt or credential data",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-model-usage-"));
 const db=openDatabase(join(root,"usage.sqlite"));
 try{
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("usage-owner","usage@example.test");
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run("usage-project","usage-owner","Usage test");
  const event=recordModelUsage(db,{
   ownerId:"usage-owner",projectId:"usage-project",jobId:"usage-job",
   workflowRunId:"usage-run",nodeId:"translate-1",provider:"text-gateway",
   capability:"voice.translate",model:"local-test-model",
   usage:{promptTokens:120,completionTokens:35,totalTokens:155},durationMs:842
  });
  assert.equal(event.promptTokens,120);
  assert.equal(event.completionTokens,35);
  assert.equal(event.totalTokens,155);
  assert.equal(event.estimatedCost,null);
  const row=db.prepare("SELECT * FROM model_usage_events WHERE id=?").get(event.id);
  assert.equal(row.owner_id,"usage-owner");
  assert.equal(row.project_id,"usage-project");
  assert.equal(row.workflow_run_id,"usage-run");
  assert.equal(row.provider,"text-gateway");
  assert.equal(row.duration_ms,842);
  assert.equal(row.estimated_cost_micros,null);
  assert.equal(Object.hasOwn(row,"prompt"),false);
  assert.equal(Object.hasOwn(row,"api_key"),false);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test("usage ledger accepts missing provider token telemetry without inventing usage or cost",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-model-usage-empty-"));
 const db=openDatabase(join(root,"usage.sqlite"));
 try{
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("usage-owner","usage@example.test");
  const event=recordModelUsage(db,{ownerId:"usage-owner",provider:"speech-gateway",capability:"voice.transcribe",model:"speech-local",usage:null,durationMs:0});
  const row=db.prepare("SELECT prompt_tokens,completion_tokens,total_tokens,estimated_cost_micros FROM model_usage_events WHERE id=?").get(event.id);
  assert.deepEqual(row,{prompt_tokens:null,completion_tokens:null,total_tokens:null,estimated_cost_micros:null});
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
