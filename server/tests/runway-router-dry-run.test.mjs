import test from "node:test";
import assert from "node:assert/strict";
import { buildRunwayRouterDryRunPayload, createRunwayRouterDryRunClient } from "../runway-router-dry-run.mjs";

const env = { RUNWAY_ROUTER_PREFLIGHT_ENABLED: "true", RUNWAY_VIDEO_ALLOW_REMOTE: "true", RUNWAY_API_KEY: "test-only-key" };
const decision = { routing: { model: "seedance2_5", provider: "bytedance", configId: "creative_low_cost", estimatedCost: { credits: 240 }, resolvedSettings: { optimizeFor: "cost", priceCeiling: 300 }, resolvedInput: { duration: 8, resolution: "720p", aspectRatio: "16:9" } } };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });

test("builds a fixed non-billable Runway Model Router dry-run payload", () => {
  assert.deepEqual(buildRunwayRouterDryRunPayload({ configId: "creative_low_cost", prompt: "A cinematic sunrise", durationSeconds: 8, aspectRatio: "16:9", resolution: "720p", audio: true, seed: 42 }), {
    configId: "creative_low_cost", dryRun: true,
    input: { promptText: "A cinematic sunrise", duration: 8, aspectRatio: "16:9", resolution: "720p", audio: true, seed: 42 }
  });
  for (const input of [
    { configId: "Bad Config", prompt: "test" }, { configId: "good", prompt: " " },
    { configId: "good", prompt: "x".repeat(26001) }, { configId: "good", prompt: "test", durationSeconds: 1 },
    { configId: "good", prompt: "test", durationSeconds: 31 }, { configId: "good", prompt: "test", aspectRatio: "2:1" },
    { configId: "good", prompt: "test", resolution: "8k" }, { configId: "good", prompt: "test", audio: "yes" },
    { configId: "good", prompt: "test", seed: 4294967296 }
  ]) assert.throws(() => buildRunwayRouterDryRunPayload(input));
});

test("preflight is disabled unless both explicit opt-ins and a server key are present", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(200, decision); };
  await assert.rejects(() => createRunwayRouterDryRunClient({ env: {}, fetchImpl }).preflight({ configId: "creative_low_cost", prompt: "test" }), e => e.code === "RUNWAY_ROUTER_PREFLIGHT_DISABLED");
  await assert.rejects(() => createRunwayRouterDryRunClient({ env: { ...env, RUNWAY_VIDEO_ALLOW_REMOTE: "false" }, fetchImpl }).preflight({ configId: "creative_low_cost", prompt: "test" }), e => e.code === "RUNWAY_REMOTE_DISABLED");
  assert.equal(calls, 0);
});

test("calls only the documented dry-run endpoint and returns routing estimates without creating a task", async () => {
  const calls = [];
  const client = createRunwayRouterDryRunClient({ env, fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200, decision); } });
  const result = await client.preflight({ configId: "creative_low_cost", prompt: "A cinematic sunrise", durationSeconds: 8, resolution: "720p" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.dev.runwayml.com/v1/generate/video");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Runway-Version"], "2024-11-06");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-only-key");
  assert.equal(JSON.parse(calls[0].options.body).dryRun, true);
  assert.equal(result.taskCreated, false);
  assert.equal(result.billed, false);
  assert.equal(result.model, "seedance2_5");
  assert.equal(result.estimatedCredits, 240);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(result.budgetCheck, "not_checked");
});

test("quarantines any response contradicting dry-run semantics or omitting routing", async () => {
  for (const body of [{ ...decision, id: "unexpected-task" }, { routing: { ...decision.routing, estimatedCost: { credits: -1 } } }, { routing: { ...decision.routing, configId: "other" } }, {}]) {
    const client = createRunwayRouterDryRunClient({ env, fetchImpl: async () => response(200, body) });
    await assert.rejects(() => client.preflight({ configId: "creative_low_cost", prompt: "test" }));
  }
});

test("resolves reference assets only within an authenticated owner/project scope", async () => {
  const resolved = [];
  const client = createRunwayRouterDryRunClient({
    env,
    getAuthorizedAssetContext: async ({ projectId }) => ({ ownerId: "owner-1", projectId }),
    resolvePrivateAsset: async args => { resolved.push(args); return { uri: "https://private-assets.example.com/" + args.assetId + ".png?sig=temporary" }; },
    fetchImpl: async (_url, options) => {
      const sent = JSON.parse(options.body);
      assert.equal(sent.input.referenceImages[0].role, "first");
      assert.equal(sent.input.referenceImages[0].uri, "https://private-assets.example.com/asset-1.png?sig=temporary");
      return response(200, decision);
    }
  });
  await client.preflight({ configId: "creative_low_cost", prompt: "Animate", projectId: "project-1", referenceImages: [{ assetId: "asset-1", role: "first" }] });
  assert.deepEqual(resolved, [{ assetId: "asset-1", ownerId: "owner-1", projectId: "project-1", mediaType: "image" }]);
});

test("rejects private references without authorization/resolution and rejects unsafe URI credentials", async () => {
  const noAuth = createRunwayRouterDryRunClient({ env, resolvePrivateAsset: async () => ({ uri: "https://assets.example.com/image.png" }), fetchImpl: async () => response(200, decision) });
  await assert.rejects(() => noAuth.preflight({ configId: "creative_low_cost", prompt: "test", projectId: "project-1", referenceImages: [{ assetId: "asset-1", role: "first" }] }), e => e.code === "RUNWAY_ROUTER_ASSET_AUTH_REQUIRED");
  const noResolver = createRunwayRouterDryRunClient({ env, getAuthorizedAssetContext: async ({ projectId }) => ({ ownerId: "owner-1", projectId }), fetchImpl: async () => response(200, decision) });
  await assert.rejects(() => noResolver.preflight({ configId: "creative_low_cost", prompt: "test", projectId: "project-1", referenceImages: [{ assetId: "asset-1", role: "first" }] }), e => e.code === "RUNWAY_ROUTER_ASSET_RESOLVER_REQUIRED");
  const unsafe = createRunwayRouterDryRunClient({ env, getAuthorizedAssetContext: async ({ projectId }) => ({ ownerId: "owner-1", projectId }), resolvePrivateAsset: async () => ({ uri: "https://user:pass@assets.example.com/image.png" }), fetchImpl: async () => response(200, decision) });
  await assert.rejects(() => unsafe.preflight({ configId: "creative_low_cost", prompt: "test", projectId: "project-1", referenceImages: [{ assetId: "asset-1", role: "first" }] }), e => e.code === "RUNWAY_ROUTER_ASSET_INVALID");
});

test("validates media roles, count limits, MIME families and provider output fields", () => {
  assert.throws(() => buildRunwayRouterDryRunPayload({ configId: "router", prompt: "test", referenceImages: [{ uri: "https://assets.example.com/a.png", role: "source" }] }));
  assert.throws(() => buildRunwayRouterDryRunPayload({ configId: "router", prompt: "test", referenceVideos: [{ uri: "https://assets.example.com/a.mp4", role: "first" }] }));
  assert.throws(() => buildRunwayRouterDryRunPayload({ configId: "router", prompt: "test", referenceAudio: [{ uri: "https://assets.example.com/a.mp3" }, { uri: "https://assets.example.com/b.mp3" }] }));
  assert.throws(() => buildRunwayRouterDryRunPayload({ configId: "router", prompt: "test", referenceImages: [{ uri: "data:audio/mpeg;base64,AAAA", role: "reference" }] }));
  assert.throws(() => buildRunwayRouterDryRunPayload({ configId: "router", prompt: "test", referenceImages: [{ uri: "https://user:pass@assets.example.com/a.png", role: "reference" }] }));
});


test("binds the router decision to a canonical input fingerprint and enforces an explicit credit ceiling", async () => {
  const client = createRunwayRouterDryRunClient({ env, fetchImpl: async () => response(200, decision) });
  const input = { configId: "creative_low_cost", prompt: "A cinematic sunrise", durationSeconds: 8, resolution: "720p" };
  const accepted = await client.preflight(input, { maxEstimatedCredits: 240 });
  assert.equal(accepted.budgetCheck, "within_limit");
  assert.match(accepted.inputHash, /^[a-f0-9]{64}$/);
  await assert.rejects(() => client.preflight(input, { maxEstimatedCredits: 239 }), error => error.code === "RUNWAY_ROUTER_BUDGET_EXCEEDED");
  await assert.rejects(() => client.preflight(input, { maxEstimatedCredits: -1 }), error => error.code === "RUNWAY_ROUTER_BUDGET_INVALID");
  const reordered = await client.preflight({ resolution: "720p", durationSeconds: 8, prompt: "A cinematic sunrise", configId: "creative_low_cost" });
  assert.equal(reordered.inputHash, accepted.inputHash);
  const changed = await client.preflight({ ...input, prompt: "A different scene" });
  assert.notEqual(changed.inputHash, accepted.inputHash);
});


test("classifies no-eligible-model and inaccessible-router responses without exposing provider payloads", async () => {
  const noEligible = createRunwayRouterDryRunClient({ env, fetchImpl: async () => response(400, { code: "no_eligible_model", message: "provider internals" }) });
  await assert.rejects(() => noEligible.preflight({ configId: "creative_low_cost", prompt: "test" }), error => error.code === "RUNWAY_NO_ELIGIBLE_MODEL" && !error.message.includes("provider internals"));
  const missing = createRunwayRouterDryRunClient({ env, fetchImpl: async () => response(404, { code: "not_found" }) });
  await assert.rejects(() => missing.preflight({ configId: "creative_low_cost", prompt: "test" }), error => error.code === "RUNWAY_ROUTER_CONFIG_NOT_FOUND");
});
