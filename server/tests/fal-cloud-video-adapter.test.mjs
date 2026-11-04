import test from "node:test";
import assert from "node:assert/strict";
import { createFalCloudVideoAdapter } from "../fal-cloud-video-adapter.mjs";

const model = "fal-ai/wan/v2.7/text-to-video";
const requestId = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const outputUrl = "https://fal.media/files/video.mp4";
function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    async submit(input) { calls.push(["submit", input]); return { requestId }; },
    async status(task) { calls.push(["status", task.requestId]); return { status: "COMPLETED" }; },
    async result(task) { calls.push(["result", task.requestId]); return { video: { url: outputUrl } }; },
    ...overrides
  };
}
const gates = {
  model, enabled: true, allowRemote: true, client: client(),
  ingestOutputs: async () => ({ assetIds: ["private-asset-1"] }),
  resolveActualCost: async () => ({ amount: 0.5, currency: "USD", evidenceReference: "provider-usage:fal-1" })
};
const jobInput = {
  provider: "fal", model, requestHash: "a".repeat(64),
  prompt: "A cinematic sunrise", durationSeconds: 5, aspectRatio: "16:9",
  referenceAssetIds: []
};

test("implements durable cloud worker adapter contract with a short persisted task ID", async () => {
  const fake = client();
  const adapter = createFalCloudVideoAdapter({ ...gates, client: fake });
  const prepared = await adapter.prepareInput(jobInput, { job: { id: "job-1" } });
  const submitted = await adapter.submit(prepared, { job: { id: "job-1" } });
  assert.deepEqual(submitted, { taskId: requestId, status: "queued" });
  const status = await adapter.getStatus(submitted.taskId, { job: { id: "job-1" } });
  assert.equal(status.status, "succeeded");
  assert.equal(status.taskId, requestId);
  assert.deepEqual(status.outputUrls, [outputUrl]);
  assert.deepEqual(fake.calls.map(call => call[0]), ["submit", "status", "result"]);
});

test("requires authenticated private input preparation when reference asset IDs are supplied", async () => {
  const adapter = createFalCloudVideoAdapter({ ...gates, client: client() });
  await assert.rejects(
    () => adapter.prepareInput({ ...jobInput, referenceAssetIds: ["private-reference-1"] }, {}),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED"
  );
});

test("routes private input resolution, private ingestion and authoritative cost through injected handlers", async () => {
  const calls = [];
  const adapter = createFalCloudVideoAdapter({
    model, client: client(),
    prepareInput: async input => { calls.push("prepare"); return { ...input, referenceImageDataUrl: "data:image/png;base64,AAAA" }; },
    ingestOutputs: async args => { calls.push(["ingest", args.provider, args.model]); return { assetIds: ["private-asset-1"] }; },
    resolveActualCost: async args => { calls.push(["cost", args.provider, args.model]); return { amount: 0.25, currency: "USD", evidenceReference: "invoice:fal-2" }; }
  });
  const prepared = await adapter.prepareInput(jobInput, {});
  assert.match(prepared.referenceImageDataUrl, /^data:image/);
  const ingested = await adapter.ingestOutputs({ job: {}, input: prepared, task: { outputUrls: [outputUrl] }, providerTaskId: requestId });
  const cost = await adapter.resolveActualCost({ job: {}, input: prepared, task: {}, providerTaskId: requestId });
  assert.deepEqual(ingested.assetIds, ["private-asset-1"]);
  assert.equal(cost.amount, 0.25);
  assert.deepEqual(calls, ["prepare", ["ingest", "fal", model], ["cost", "fal", model]]);
});

test("rejects wrong provider/model identity before provider submission", async () => {
  const fake = client();
  const adapter = createFalCloudVideoAdapter({ ...gates, client: fake });
  await assert.rejects(
    () => adapter.prepareInput({ ...jobInput, model: "fal-ai/other-model" }, {}),
    error => error.code === "VIDEO_JOB_INPUT_MISMATCH"
  );
  assert.equal(fake.calls.length, 0);
});

test("maps queued and running provider states without blocking or sleeping", async () => {
  for (const [providerState, expected] of [["IN_QUEUE", "queued"], ["IN_PROGRESS", "running"]]) {
    const adapter = createFalCloudVideoAdapter({
      ...gates, client: client({ async status() { return { status: providerState, queuePosition: 3 }; } })
    });
    assert.equal((await adapter.getStatus(requestId)).status, expected);
  }
});

test("server opt-in gates remain enforced even when a client is injected", async () => {
  const fake = client();
  const adapter = createFalCloudVideoAdapter({ ...gates, client: fake, allowRemote: false });
  await assert.rejects(() => adapter.submit(jobInput), error => error.code === "VIDEO_GATEWAY_REMOTE_DISABLED");
  await assert.rejects(() => adapter.getStatus(requestId), error => error.code === "VIDEO_GATEWAY_REMOTE_DISABLED");
  assert.equal(fake.calls.length, 0);
});

test("rejects unsafe or missing output URLs and missing cost/ingestion gates", async () => {
  const unsafe = createFalCloudVideoAdapter({
    ...gates, client: client({ async result() { return { video: { url: "https://attacker.example/video.mp4" } }; } })
  });
  await assert.rejects(() => unsafe.getStatus(requestId), error => error.code === "VIDEO_OUTPUT_URL_REJECTED");
  assert.throws(() => createFalCloudVideoAdapter({ model, client: client(), resolveActualCost: async () => ({}) }), error => error.code === "VIDEO_EXECUTION_GATES_MISSING");
});
