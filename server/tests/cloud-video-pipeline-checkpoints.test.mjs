import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoPipelineCheckpointStore } from "../cloud-video-pipeline-checkpoints.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";
const output = "44444444-4444-4444-8444-444444444444";
const baseRecord = {
  pipelineId: "pipeline-episode-01", stepId: "upscale", status: "succeeded",
  inputAssetId: source, inputSha256: "a".repeat(64), idempotencyKey: "b".repeat(64),
  outputAsset: { id: output, mediaType: "video/mp4", sha256: "c".repeat(64), derivativeOf: source },
  approvalId: "approval-42"
};
function harness() {
  const rows = new Map();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    const key = ["owner_id", "project_id", "pipeline_id", "step_id"].map(name => (parsed.searchParams.get(name) || "").replace(/^eq\\./, "")).join(":");
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      const rowKey = body.owner_id + ":" + body.project_id + ":" + body.pipeline_id + ":" + body.step_id;
      if (!rows.has(rowKey)) rows.set(rowKey, {
        ...body, created_at: "2026-11-02T10:00:00.000Z"
      });
      return new Response("", { status: 201 });
    }
    if (options.method === "GET") {
      const row = rows.get(key);
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "unsupported" }), { status: 405 });
  };
  const store = createCloudVideoPipelineCheckpointStore({
    url: "https://db.example.test", serviceRoleKey: "server-secret", fetchImpl
  });
  return { store, rows, requests };
}

test("writes and reads durable project-scoped checkpoints through the private schema", async () => {
  const { store, requests } = harness();
  const saved = await store.save({ ownerId: owner, projectId: project, record: baseRecord });
  assert.equal(saved.outputAsset.id, output);
  assert.equal(saved.approvalId, "approval-42");
  assert.equal(requests[0].options.headers["content-profile"], "executive_visuals");
  assert.equal(requests[0].options.headers.authorization, "Bearer server-secret");
  assert.match(requests[0].options.prefer, /resolution=ignore-duplicates/);
  assert.equal((await store.get({ ownerId: owner, projectId: project, pipelineId: baseRecord.pipelineId, stepId: baseRecord.stepId })).idempotencyKey, baseRecord.idempotencyKey);
});

test("rejects a conflicting immutable checkpoint instead of overwriting it", async () => {
  const { store } = harness();
  await store.save({ ownerId: owner, projectId: project, record: baseRecord });
  await assert.rejects(
    () => store.save({ ownerId: owner, projectId: project, record: { ...baseRecord, idempotencyKey: "d".repeat(64) } }),
    error => error.code === "CLOUD_CHECKPOINT_CONFLICT"
  );
});

test("requires valid owner/project scope and a valid derivative receipt", async () => {
  const { store, requests } = harness();
  await assert.rejects(() => store.get({ ownerId: "not-a-uuid", projectId: project, pipelineId: "p", stepId: "s" }), error => error.code === "CLOUD_CHECKPOINT_SCOPE_INVALID");
  await assert.rejects(() => store.save({ ownerId: owner, projectId: project, record: { ...baseRecord, outputAsset: { ...baseRecord.outputAsset, derivativeOf: output } } }), error => error.code === "CLOUD_CHECKPOINT_INVALID");
  assert.equal(requests.length, 0);
});

test("requires secure server endpoint configuration", () => {
  assert.throws(() => createCloudVideoPipelineCheckpointStore({ url: "http://db.example.test", serviceRoleKey: "secret" }), /HTTPS/);
  assert.throws(() => createCloudVideoPipelineCheckpointStore({ url: "https://db.example.test", serviceRoleKey: "" }), /credentials/);
});
