import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { executeVideoGenerationJob } from "../video-generation-executor.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const jobId = "323e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-video-executor-"));
  const db = openDatabase(join(root, "jobs.sqlite"));
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(ownerId, "executor-owner@example.test");
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(projectId, ownerId, "Executor test project");
  db.prepare(`INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json)
    VALUES(?,?,?,'video.generate','queued',?)`).run(jobId, ownerId, projectId, JSON.stringify({
      provider: "runway", model: "gen4.5", requestHash, prompt: "Test prompt",
      aspectRatio: "16:9", durationSeconds: 5, requestId: "request-1"
    }));
  const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  return { root, db, job };
}
const successTask = { taskId: "123e4567-e89b-42d3-a456-426614174001", status: "succeeded", outputUrls: ["https://cdn.example.test/output.mp4"] };

test("submits once, ingests private assets, and persists a terminal result", async () => {
  const f = await fixture();
  let submits = 0, ingests = 0, adapterContext = null;
  const adapter = {
    provider: "runway", model: "gen4.5", minimumPollIntervalMs: 5000,
    async submit(_input, context) { submits++; adapterContext = context; return { taskId: successTask.taskId, status: "queued" }; },
    async getStatus() { return successTask; }
  };
  try {
    const result = await executeVideoGenerationJob({
      db: f.db, job: f.job, adapter,
      async ingestOutputs({ task }) { ingests++; assert.equal(task.taskId, successTask.taskId); return { assetIds: ["private-asset-1"], usage: { credits: 12 } }; },
      sleep: async () => {}
    });
    assert.deepEqual(result.assetIds, ["private-asset-1"]);
    assert.equal(submits, 1);
    assert.equal(ingests, 1);
    assert.equal(adapterContext.job.id, jobId);
    assert.equal(adapterContext.job.owner_id, ownerId);
    assert.equal(f.db.prepare("SELECT state FROM video_generation_submissions WHERE job_id=?").get(jobId).state, "succeeded");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("resumes polling after a deferred attempt without repeating provider submission", async () => {
  const f = await fixture();
  let submits = 0, polls = 0;
  const adapter = {
    provider: "runway", model: "gen4.5", minimumPollIntervalMs: 5000,
    async submit() { submits++; return { taskId: successTask.taskId, status: "queued" }; },
    async getStatus() { polls++; return polls === 1 ? { taskId: successTask.taskId, status: "running", outputUrls: [] } : successTask; }
  };
  try {
    await assert.rejects(executeVideoGenerationJob({
      db: f.db, job: f.job, adapter, maxPolls: 1,
      async ingestOutputs() { return { assetIds: ["private-asset-2"] }; },
      sleep: async () => {}
    }), error => error.code === "VIDEO_PROVIDER_POLL_DEFERRED");
    const result = await executeVideoGenerationJob({
      db: f.db, job: f.job, adapter,
      async ingestOutputs() { return { assetIds: ["private-asset-2"] }; },
      sleep: async () => {}
    });
    assert.deepEqual(result.assetIds, ["private-asset-2"]);
    assert.equal(submits, 1);
    assert.equal(polls, 2);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("ambiguous provider POST failures are quarantined and never resubmitted", async () => {
  const f = await fixture();
  let submits = 0;
  const adapter = {
    provider: "runway", model: "gen4.5",
    async submit() { submits++; throw Object.assign(new Error("network timeout"), { code: "RUNWAY_TIMEOUT" }); },
    async getStatus() { throw new Error("must not poll"); }
  };
  try {
    const options = { db: f.db, job: f.job, adapter, async ingestOutputs() { return { assetIds: [] }; } };
    await assert.rejects(executeVideoGenerationJob(options), error => error.code === "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    await assert.rejects(executeVideoGenerationJob(options), error => error.code === "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION");
    assert.equal(submits, 1);
    assert.equal(f.db.prepare("SELECT state FROM video_generation_submissions WHERE job_id=?").get(jobId).state, "unknown");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("does not submit unless a secure output-ingestion boundary is supplied", async () => {
  const f = await fixture();
  let submits = 0;
  const adapter = { provider: "runway", model: "gen4.5", async submit() { submits++; }, async getStatus() {} };
  try {
    await assert.rejects(executeVideoGenerationJob({ db: f.db, job: f.job, adapter }), error => error.code === "VIDEO_OUTPUT_INGESTION_UNAVAILABLE");
    assert.equal(submits, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM video_generation_submissions").get().n, 0);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});
