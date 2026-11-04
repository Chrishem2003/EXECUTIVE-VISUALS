import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { createVideoGenerationJobService } from "../video-generation-jobs.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const model = {
  availability: "enabled",
  capabilities: {
    seed: true, negativePrompt: false, startFrame: false, endFrame: false,
    motionReference: false, referenceImages: false, audioModes: [],
    aspectRatios: ["16:9", "9:16"], resolutions: ["provider_default"],
    minDurationSeconds: 2, maxDurationSeconds: 10
  }
};
const baseInput = { provider: "runway", model: "gen4.5", prompt: "A sunrise over the ocean", durationSeconds: 5, aspectRatio: "16:9" };

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ev-video-jobs-"));
  const db = openDatabase(join(root, "jobs.sqlite"));
  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(ownerId, "video-owner@example.test");
  const budgetCalls = [];
  const service = createVideoGenerationJobService({
    db,
    authorizeProject: (owner, project) => owner === ownerId && project === projectId,
    providerResolver: () => model,
    usageLimit: 3,
    reserveBudget: args => { budgetCalls.push(args); return options.budget || { approved: true, reservationId: "budget-reservation-1" }; }
  });
  return { root, db, service, budgetCalls };
}

test("queues only after explicit budget approval and remote usage reservation", async () => {
  const f = await fixture();
  try {
    const result = f.service.enqueue({ ownerId, projectId, idempotencyKey: "video-001", input: baseInput });
    assert.equal(result.job.jobType, "video.generate");
    assert.equal(result.job.status, "queued");
    assert.equal(result.idempotentReplay, false);
    assert.equal(result.job.input.budgetReservationId, "budget-reservation-1");
    assert.ok(result.job.input.remoteUsageReservationId);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM remote_usage_reservations").get().n, 1);
    assert.equal(f.budgetCalls.length, 1);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("idempotent replay returns the original durable job without reserving budget twice", async () => {
  const f = await fixture();
  try {
    const first = f.service.enqueue({ ownerId, idempotencyKey: "video-002", input: baseInput });
    const replay = f.service.enqueue({ ownerId, idempotencyKey: "video-002", input: baseInput });
    assert.equal(replay.job.id, first.job.id);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(f.budgetCalls.length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM remote_usage_reservations").get().n, 1);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("idempotency conflicts reject different requests without extra reservations", async () => {
  const f = await fixture();
  try {
    f.service.enqueue({ ownerId, idempotencyKey: "video-003", input: baseInput });
    assert.throws(() => f.service.enqueue({ ownerId, idempotencyKey: "video-003", input: { ...baseInput, prompt: "A different prompt" } }), e => e.code === "VIDEO_JOB_IDEMPOTENCY_CONFLICT");
    assert.equal(f.budgetCalls.length, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_type='video.generate'").get().n, 1);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("disabled providers and unsupported model options fail before budget or usage reservation", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.enqueue({ ownerId, input: baseInput }), e => e.code === "VIDEO_JOB_PROVIDER_DISABLED");
    assert.throws(() => f.service.enqueue({ ownerId, input: { ...baseInput, negativePrompt: "blur" } }), e => e.code === "VIDEO_JOB_PROVIDER_DISABLED");
    assert.equal(f.budgetCalls.length, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM remote_usage_reservations").get().n, 0);
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("project authorization, budget approval and usage limits fail closed", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.enqueue({ ownerId, projectId: "323e4567-e89b-42d3-a456-426614174000", input: baseInput }), e => e.code === "VIDEO_JOB_PROJECT_FORBIDDEN");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }

  const noBudget = await fixture({ budget: { approved: false } });
  try {
    assert.throws(() => noBudget.service.enqueue({ ownerId, input: baseInput }), e => e.code === "VIDEO_JOB_BUDGET_NOT_APPROVED");
    assert.equal(noBudget.db.prepare("SELECT COUNT(*) AS n FROM remote_usage_reservations").get().n, 0);
    assert.equal(noBudget.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_type='video.generate'").get().n, 0);
  } finally { noBudget.db.close(); await rm(noBudget.root, { recursive: true, force: true }); }

  const limited = await fixture({ budget: { approved: true, reservationId: "budget-2" } });
  try {
    limited.service.enqueue({ ownerId, idempotencyKey: "one", input: baseInput });
    limited.service.enqueue({ ownerId, idempotencyKey: "two", input: baseInput });
    limited.service.enqueue({ ownerId, idempotencyKey: "three", input: baseInput });
    assert.throws(() => limited.service.enqueue({ ownerId, idempotencyKey: "four", input: baseInput }), e => e.code === "REMOTE_USAGE_LIMIT_REACHED");
    assert.equal(limited.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_type='video.generate'").get().n, 3);
  } finally { limited.db.close(); await rm(limited.root, { recursive: true, force: true }); }
});

test("requires explicit provider/model, safe idempotency keys and budget adapter", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.enqueue({ ownerId, input: { prompt: "No provider" } }), e => e.code === "VIDEO_JOB_PROVIDER_REQUIRED");
    assert.throws(() => f.service.enqueue({ ownerId, idempotencyKey: "bad key", input: baseInput }), e => e.code === "VIDEO_JOB_IDEMPOTENCY_INVALID");
  } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
});
