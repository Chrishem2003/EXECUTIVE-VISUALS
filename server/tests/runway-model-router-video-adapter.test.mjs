import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayModelRouterVideoAdapter } from "../runway-model-router-video-adapter.mjs";

const id = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
const routing = {
  configId: "production-video",
  model: "gen4.5",
  provider: "runway",
  resolvedSettings: { optimizeFor: "cost", priceCeiling: 100 },
  estimatedCost: { credits: 50 }
};
const base = {
  configId: "production-video",
  apiKey: "test-key",
  enabled: true,
  allowRemote: true,
  ingestOutputs: async () => ({ assetIds: ["asset-1"] })
};

test("submits a live routed task and durably returns the complete routing decision", async () => {
  let request;
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ id, routing }), { status: 200 });
    }
  });
  const result = await adapter.submit({
    provider: "runway", model: "model-router", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  });
  assert.equal(request.url, "https://api.dev.runwayml.com/v1/generate/video");
  assert.equal(request.options.headers["X-Runway-Version"], "2024-11-06");
  assert.deepEqual(JSON.parse(request.options.body), {
    configId: "production-video",
    input: { promptText: "A cinematic sunrise", duration: 5, aspectRatio: "16:9" }
  });
  assert.equal(result.taskId, id);
  assert.deepEqual(result.metadata, { routeType: "runway-model-router", configId: "production-video", routing });
});

test("never treats dry-run estimates as actual customer/provider settlement", async () => {
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({ id, routing }))
  });
  const submitted = await adapter.submit({ provider: "runway", model: "model-router", prompt: "Test" });
  const cost = await adapter.resolveActualCost({
    submissionMetadata: submitted.metadata,
    providerTaskId: id,
    task: { taskId: id, status: "succeeded", estimatedCost: { credits: 50 }, cost: { credits: 48 } }
  });
  assert.equal(cost.amount, 0.48);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.model, "gen4.5");
  assert.match(cost.evidenceReference, /credits:48$/);
});

test("holds settlement when durable route metadata or completed task cost is missing", async () => {
  const adapter = createRunwayModelRouterVideoAdapter({ ...base });
  await assert.rejects(
    adapter.resolveActualCost({ submissionMetadata: {}, providerTaskId: id, task: {} }),
    error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED"
  );
  await assert.rejects(
    adapter.resolveActualCost({
      submissionMetadata: { routeType: "runway-model-router", configId: "production-video", routing },
      providerTaskId: id, task: { taskId: id, status: "succeeded", estimatedCost: { credits: 50 } }
    }),
    error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED"
  );
  await assert.rejects(
    adapter.resolveActualCost({
      submissionMetadata: { routeType: "runway-model-router", configId: "production-video", routing },
      providerTaskId: id, task: { taskId: id, status: "succeeded", estimatedCost: { credits: 50 }, cost: { credits: 51 } }
    }),
    error => error.code === "VIDEO_BUDGET_COST_UNRESOLVED"
  );
});

test("rejects mismatched router config and missing task identity", async () => {
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({ id, routing: { ...routing, configId: "other-router" } }))
  });
  await assert.rejects(
    adapter.submit({ provider: "runway", model: "model-router", prompt: "Test" }),
    error => error.code === "RUNWAY_ROUTER_RESPONSE_INVALID"
  );
});

test("is disabled by default and requires private output ingestion", async () => {
  const disabled = createRunwayModelRouterVideoAdapter({ ...base, enabled: false });
  await assert.rejects(
    disabled.submit({ provider: "runway", model: "model-router", prompt: "Test" }),
    error => error.code === "RUNWAY_ROUTER_DISABLED"
  );
  assert.throws(
    () => createRunwayModelRouterVideoAdapter({ configId: "production-video", apiKey: "key", ingestOutputs: async () => ({}) }),
    error => error.code === "RUNWAY_ROUTER_EXECUTION_GATES_MISSING"
  );
});

test("polls a routed task and returns only validated HTTPS output URLs", async () => {
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({ id, status: "SUCCEEDED", output: ["https://cdn.example.test/video.mp4"] }))
  });
  assert.deepEqual(await adapter.getStatus(id), {
    status: "succeeded", taskId: id, outputUrls: ["https://cdn.example.test/video.mp4"], provider: "runway", model: "model-router"
  });
});
