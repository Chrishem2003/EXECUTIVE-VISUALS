import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { createVideoSubmissionLedger } from "../video-generation-submissions.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const jobId = "323e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-video-submission-"));
  const db = openDatabase(join(root, "jobs.sqlite"));
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(ownerId, "submission-owner@example.test");
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(projectId, ownerId, "Submission test project");
  db.prepare(`INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json)
    VALUES(?,?,?,'video.generate','queued',?)`).run(jobId, ownerId, projectId, JSON.stringify({
      provider: "runway", model: "gen4.5", requestHash, prompt: "Test prompt"
    }));
  return { root, db, ledger: createVideoSubmissionLedger({ db }) };
}

test("prepares one immutable provider submission per durable video job", async () => {
  const f = await fixture();
  try {
    const first = f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "gen4.5", requestHash });
    const replay = f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "gen4.5", requestHash });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.submission.id, first.submission.id);
    assert.equal(first.submission.state, "prepared");
    assert.throws(() => f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "different-model", requestHash }), error => error.code === "VIDEO_SUBMISSION_REQUEST_MISMATCH");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a provider submission can start once and cannot be automatically replayed", async () => {
  const f = await fixture();
  try {
    f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "gen4.5", requestHash });
    const started = f.ledger.beginSubmission(jobId);
    const replay = f.ledger.beginSubmission(jobId);
    assert.equal(started.started, true);
    assert.equal(replay.started, false);
    assert.equal(replay.submission.state, "submitting");
    assert.equal(f.ledger.listAmbiguous().length, 1);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("ambiguous provider outcomes are quarantined until explicitly reconciled", async () => {
  const f = await fixture();
  try {
    f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "gen4.5", requestHash });
    f.ledger.beginSubmission(jobId);
    const unknown = f.ledger.markUnknown(jobId, "RUNWAY_TIMEOUT");
    assert.equal(unknown.submission.state, "unknown");
    assert.equal(unknown.submission.lastErrorCode, "RUNWAY_TIMEOUT");
    assert.equal(f.ledger.beginSubmission(jobId).started, false);
    assert.throws(() => f.ledger.recordSubmitted(jobId, "task-123"), error => error.code === "VIDEO_SUBMISSION_STATE_INVALID");
    const reconciled = f.ledger.reconcileSubmitted(jobId, "task-123", { source: "operator_verification" });
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.submission.state, "submitted");
    assert.equal(reconciled.submission.providerTaskId, "task-123");
    assert.equal(f.ledger.listAmbiguous().length, 0);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("provider task acknowledgement and terminal state transitions are idempotent", async () => {
  const f = await fixture();
  try {
    f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "gen4.5", requestHash });
    f.ledger.beginSubmission(jobId);
    assert.equal(f.ledger.recordSubmitted(jobId, "task-456").recorded, true);
    const replay = f.ledger.recordSubmitted(jobId, "task-456");
    assert.equal(replay.idempotentReplay, true);
    assert.throws(() => f.ledger.recordSubmitted(jobId, "task-other"), error => error.code === "VIDEO_SUBMISSION_TASK_CONFLICT");
    assert.equal(f.ledger.markTerminal(jobId, "succeeded", { outputCount: 1 }).submission.state, "succeeded");
    assert.equal(f.ledger.markTerminal(jobId, "succeeded").changed, false);
    assert.throws(() => f.ledger.markTerminal(jobId, "failed"), error => error.code === "VIDEO_SUBMISSION_STATE_INVALID");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("submission ledger rejects unrelated jobs and mismatched request hashes", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.ledger.prepare({ jobId: "missing-job", ownerId, provider: "runway", model: "gen4.5", requestHash }), error => error.code === "VIDEO_SUBMISSION_JOB_FORBIDDEN");
    assert.throws(() => f.ledger.prepare({ jobId, ownerId, provider: "runway", model: "gen4.5", requestHash: "b".repeat(64) }), error => error.code === "VIDEO_SUBMISSION_REQUEST_MISMATCH");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});
