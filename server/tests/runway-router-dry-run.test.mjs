import test from "node:test";
import assert from "node:assert/strict";
import { buildRunwayRouterDryRunPayload, createRunwayRouterDryRunClient } from "../runway-router-dry-run.mjs";

const env = {
  RUNWAY_ROUTER_PREFLIGHT_ENABLED: "true",
  RUNWAY_VIDEO_ALLOW_REMOTE: "true",
  RUNWAY_API_KEY: "test-only-key"
};
const decision = {
  routing: {
    model: "seedance2_5",
    provider: "bytedance",
    configId: "creative_low_cost",
    estimatedCost: { credits: 240 },
    resolvedSettings: { optimizeFor: "cost", priceCeiling: 300 },
    resolvedInput: { duration: 8, resolution: "720p", aspectRatio: "16:9" }
  }
};
const response = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body)
});

test("router payload is always a dry run and validates every optional generation constraint", () => {
  assert.deepEqual(buildRunwayRouterDryRunPayload({
    configId: "creative_low_cost", prompt: "A cinematic sunrise",
    durationSeconds: 8, aspectRatio: "16:9", resolution: "720p", audio: true, seed: 42
  }), {
    configId: "creative_low_cost",
    dryRun: true,
    input: {
      promptText: "A cinematic sunrise", duration: 8, aspectRatio: "16:9",
      resolution: "720p", audio: true, seed: 42
    }
  });
  for (const input of [
    { configId: "Bad Config", prompt: "test" },
    { configId: "good", prompt: " " },
    { configId: "good", prompt: "x".repeat(26001) },
    { configId: "good", prompt: "test", durationSeconds: 1 },
    { configId: "good", prompt: "test", durationSeconds: 31 },
    { configId: "good", prompt: "test", aspectRatio: "2:1" },
    { configId: "good", prompt: "test", resolution: "8k" },
    { configId: "good", prompt: "test", audio: "yes" },
    { configId: "good", prompt: "test", seed: 4294967296 }
  ]) assert.throws(() => buildRunwayRouterDryRunPayload(input));
});

test("client is disabled by default and makes no network calls until both opt-ins are set", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(200, decision); };
  const disabled = createRunwayRouterDryRunClient({ env: {}, fetchImpl });
  await assert.rejects(() => disabled.preflight({ configId: "creative_low_cost", prompt: "test" }),
    error => error.code === "RUNWAY_ROUTER_PREFLIGHT_DISABLED");
  const noRemote = createRunwayRouterDryRunClient({
    env: { ...env, RUNWAY_VIDEO_ALLOW_REMOTE: "false" }, fetchImpl
  });
  await assert.rejects(() => noRemote.preflight({ configId: "creative_low_cost", prompt: "test" }),
    error => error.code === "RUNWAY_REMOTE_DISABLED");
  assert.equal(calls, 0);
});

test("preflight sends the documented endpoint and a hard-coded dryRun flag", async () => {
  const calls = [];
  const client = createRunwayRouterDryRunClient({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, decision);
    }
  });
  const result = await client.preflight({
    configId: "creative_low_cost", prompt: "A cinematic sunrise",
    durationSeconds: 8, resolution: "720p"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.dev.runwayml.com/v1/generate/video");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Runway-Version"], "2024-11-06");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-only-key");
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(sent.dryRun, true);
  assert.equal(result.status, "preflighted");
  assert.equal(result.taskCreated, false);
  assert.equal(result.billed, false);
  assert.equal(result.model, "seedance2_5");
  assert.equal(result.provider, "bytedance");
  assert.equal(result.estimatedCredits, 240);
  assert.equal(result.resolvedSettings.optimizeFor, "cost");
});

test("client quarantines responses that contradict dry-run semantics or omit a decision", async () => {
  for (const body of [
    { ...decision, id: "unexpected-task-id" },
    { routing: { ...decision.routing, estimatedCost: { credits: -1 } } },
    { routing: { ...decision.routing, model: null } },
    { routing: { ...decision.routing, configId: "different_config" } },
    {}
  ]) {
    const client = createRunwayRouterDryRunClient({
      env, fetchImpl: async () => response(200, body)
    });
    await assert.rejects(() => client.preflight({ configId: "creative_low_cost", prompt: "test" }));
  }
});

test("provider errors are sanitized and do not disclose response bodies", async () => {
  const rateLimited = createRunwayRouterDryRunClient({
    env, fetchImpl: async () => ({ status: 429, ok: false, text: async () => "secret body" })
  });
  await assert.rejects(() => rateLimited.preflight({ configId: "creative_low_cost", prompt: "test" }),
    error => error.code === "RUNWAY_RATE_LIMITED" && !error.message.includes("secret body"));
});
