import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import { claimNextJob } from "../queue.mjs";

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("owner-1","owner@example.test");
  const insert = db.prepare("INSERT INTO jobs(id,owner_id,job_type,status,input_json,created_at) VALUES(?,?,?,'queued','{}',?)");
  insert.run("video-1","owner-1","video.generate","2026-01-01T00:00:00.000Z");
  insert.run("media-1","owner-1","media.probe","2026-01-02T00:00:00.000Z");
  return db;
}

test("worker claims the oldest job only within its supported job types", () => {
  const db = fixture();
  const claimed = claimNextJob(db,"worker-1",90000,"2026-01-03T00:00:00.000Z",["workflow.execute","media.probe"]);
  assert.equal(claimed.id,"media-1");
  assert.equal(claimed.job_type,"media.probe");
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='video-1'").get().status,"queued");
});

test("worker leaves unsupported queued jobs untouched when no supported job exists", () => {
  const db = fixture();
  const claimed = claimNextJob(db,"worker-1",90000,"2026-01-03T00:00:00.000Z",["workflow.execute","media.thumbnail"]);
  assert.equal(claimed,null);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='video-1'").get().status,"queued");
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='media-1'").get().status,"queued");
});

test("worker rejects an empty or malformed supported-type filter", () => {
  const db = fixture();
  assert.throws(()=>claimNextJob(db,"worker-1",90000,"2026-01-03T00:00:00.000Z",[]),/non-empty list/);
  assert.throws(()=>claimNextJob(db,"worker-1",90000,"2026-01-03T00:00:00.000Z",["media.probe",""]),/non-empty list/);
});
