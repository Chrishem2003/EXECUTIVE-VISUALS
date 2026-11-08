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

test("preflights a quote without creating a task or charging credits", async () => {
  let body;
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({
        routing: {
          configId: "production-video", model: "gen4.5", provider: "runway",
          resolvedSettings: { optimizeFor: "cost", priceCeiling: 100 },
          estimatedCost: { credits: 50 }
        }
      }), { status: 200 });
    }
  });
  const quote = await adapter.preflight({ prompt: "A cinematic sunrise", durationSeconds: 5 });
  assert.deepEqual(body, {
    configId: "production-video", dryRun: true,
    input: { promptText: "A cinematic sunrise", duration: 5 }
  });
  assert.equal(quote.billable, false);
  assert.equal(quote.estimatedCredits, 50);
  assert.equal(quote.estimatedUsd, 0.5);
  assert.equal(quote.model, "gen4.5");
});

test("rejects a dry-run response that unexpectedly creates a task", async () => {
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({ id, routing }))
  });
  await assert.rejects(
    adapter.preflight({ prompt: "Test" }),
    error => error.code === "RUNWAY_ROUTER_DRY_RUN_INVALID"
  );
});

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
  assert.deepEqual(result.metadata, { routeType: "runway-model-router", configId: "production-video", routing, estimatedCredits: 50 });
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
    () => createRunwayModelRouterVideoAdapter({ configId: "production-video", apiKey: "key" }),
    error => error.code === "RUNWAY_ROUTER_EXECUTION_GATES_MISSING"
  );
});

test("cancels rejected Runway response bodies before returning status errors", async () => {
  for (const [status, code] of [
    [401, "RUNWAY_ACCESS_DENIED"],
    [403, "RUNWAY_ACCESS_DENIED"],
    [422, "RUNWAY_REQUEST_REJECTED"],
    [429, "RUNWAY_RATE_LIMITED"],
    [500, "RUNWAY_SERVER_ERROR"],
    [503, "RUNWAY_SERVER_ERROR"]
  ]) {
    let cancelled = false;
    const adapter = createRunwayModelRouterVideoAdapter({
      ...base,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        cancel() { cancelled = true; }
      }), { status })
    });
    await assert.rejects(
      adapter.getStatus(id),
      error => error.code === code
    );
    assert.equal(cancelled, true, "response body for HTTP " + status + " should be cancelled");
  }
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

test("maps one reference audio asset and rejects invalid reference media roles or counts", async () => {
  let body;
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ routing }));
    }
  });
  await adapter.preflight({
    prompt: "A presenter explaining a product",
    audioMode: "reference",
    referenceAudio: [{ uri: "https://storage.example.test/audio.mp3" }]
  });
  assert.deepEqual(body.input.referenceAudio, [{ uri: "https://storage.example.test/audio.mp3" }]);
  await assert.rejects(
    adapter.preflight({ prompt: "Test", audioMode: "reference" }),
    error => error.code === "RUNWAY_ROUTER_INPUT_INVALID"
  );
  await assert.rejects(
    adapter.preflight({ prompt: "Test", referenceAudio: [{ uri: "https://storage.example.test/audio.mp3" }, { uri: "https://storage.example.test/audio2.mp3" }] }),
    error => error.code === "RUNWAY_ROUTER_INPUT_INVALID"
  );
});

test("Model Router submits a source video with the documented source role", async () => {
  let body;
  const adapter = createRunwayModelRouterVideoAdapter({
    ...base,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ id, routing }));
    }
  });
  const result = await adapter.submit({
    provider: "runway", model: "model-router", operation: "video-to-video",
    prompt: "Replace the background with a modern studio while preserving the presenter and camera motion",
    durationSeconds: 12,
    referenceVideos: [{ uri: "https://storage.example.test/source.mp4", role: "source" }]
  });
  assert.equal(body.input.referenceVideos[0].role, "source");
  assert.equal(body.input.duration, 12);
  assert.equal(result.taskId, id);
  await assert.rejects(
    adapter.submit({ provider: "runway", model: "model-router", operation: "video-to-video", prompt: "Edit this", durationSeconds: 12 }),
    error => error.code === "RUNWAY_ROUTER_INPUT_INVALID"
  );
});

