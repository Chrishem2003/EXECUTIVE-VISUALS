import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayCloudVideoAdapter } from "../runway-cloud-video-adapter.mjs";

const id = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
const output = "https://cdn.example.net/generated.mp4?token=temporary";
const base = {
  model: "gen4.5",
  apiKey: "runway-test-key",
  enabled: true,
  allowRemote: true,
  ingestOutputs: async () => ({ assetIds: ["asset-1"] }),
  resolveActualCost: async () => ({ amount: 12, currency: "USD", evidenceReference: "runway:usage-row:1" })
};

test("submits one Gen-4.5 text-to-video task using the pinned API version", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id, estimatedCost: { credits: 60 } }), { status: 200 });
    }
  });
  const result = await adapter.submit({
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  });
  assert.deepEqual(result, { taskId: id, status: "queued" });
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.authorization, "Bearer runway-test-key");
  assert.equal(call.options.headers["X-Runway-Version"], "2024-11-06");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "gen4.5", promptText: "A cinematic sunrise", ratio: "1280:720", duration: 5
  });
});

test("maps queued, running and succeeded task states and exposes only HTTPS output URLs", async () => {
  let current = { id, status: "PENDING" };
  const adapter = createRunwayCloudVideoAdapter({ ...base, fetchImpl: async () => new Response(JSON.stringify(current)) });
  assert.equal((await adapter.getStatus(id)).status, "queued");
  current = { id, status: "RUNNING" };
  assert.equal((await adapter.getStatus(id)).status, "running");
  current = { id, status: "SUCCEEDED", output: [output] };
  assert.deepEqual(await adapter.getStatus(id), {
    status: "succeeded", taskId: id, outputUrls: [output], provider: "runway", model: "gen4.5"
  });
});

test("requires authoritative task-level billing evidence and private ingestion", () => {
  assert.throws(() => createRunwayCloudVideoAdapter({ model: "gen4.5", apiKey: "key", enabled: true, allowRemote: true, ingestOutputs: async () => ({}) }), error => error.code === "RUNWAY_EXECUTION_GATES_MISSING");
  assert.throws(() => createRunwayCloudVideoAdapter({ model: "gen4.5", apiKey: "key", enabled: true, allowRemote: true, resolveActualCost: async () => ({}) }), error => error.code === "RUNWAY_EXECUTION_GATES_MISSING");
});

test("rejects unsupported duration, unresolved references and remote calls without opt-in", async () => {
  const calls = [];
  const adapter = createRunwayCloudVideoAdapter({ ...base, fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify({ id })); } });
  await assert.rejects(() => adapter.submit({ provider: "runway", model: "gen4.5", prompt: "test", durationSeconds: 8 }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ provider: "runway", model: "gen4.5", prompt: "test", referenceAssetIds: ["private-asset"] }), error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
  const disabled = createRunwayCloudVideoAdapter({ ...base, allowRemote: false, fetchImpl: async (...args) => { calls.push(args); } });
  await assert.rejects(() => disabled.submit({ provider: "runway", model: "gen4.5", prompt: "test" }), error => error.code === "RUNWAY_REMOTE_DISABLED");
  assert.equal(calls.length, 0);
});

test("does not mistake Runway's estimated credits for actual billing", async () => {
  let actualResolverCalls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    resolveActualCost: async args => {
      actualResolverCalls += 1;
      assert.equal(args.providerTaskId, id);
      return { amount: 11, currency: "USD", evidenceReference: "runway:verified-task-ledger" };
    },
    fetchImpl: async () => new Response(JSON.stringify({ id, status: "SUCCEEDED", output: [output], estimatedCost: { credits: 60 } }))
  });
  const task = await adapter.getStatus(id);
  const cost = await adapter.resolveActualCost({ providerTaskId: id, task });
  assert.equal(cost.amount, 11);
  assert.equal(actualResolverCalls, 1);
});
