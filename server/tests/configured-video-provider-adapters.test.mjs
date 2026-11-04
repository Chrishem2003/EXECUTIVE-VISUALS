import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredVideoProviderAdapters } from "../configured-video-provider-adapters.mjs";

const base = {
  env: {
    VIDEO_GATEWAY_ENABLED: "true",
    VIDEO_GATEWAY_ALLOW_REMOTE: "true",
    LUMA_VIDEO_ENABLED: "true",
    LUMA_VIDEO_ALLOW_REMOTE: "true",
    LUMA_AGENTS_API_KEY: "luma-test-key"
  },
  ingestOutputs: async () => ({ assetIds: ["asset-1"] }),
  resolveLumaActualCost: async ({ task }) => {
    assert.equal(task.usage.credits_charged, 100);
    return { amount: 0.3, currency: "USD", evidenceReference: "luma:settled-usage:test" };
  },
  fetchImpl: async (url, init) => {
    if (init.method === "POST") return new Response(JSON.stringify({ id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "queued" }), { status: 201 });
    return new Response(JSON.stringify({
      id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "completed",
      output: [{ type: "video", url: "https://cdn.example.test/out.mp4?sig=temporary" }],
      usage: { credits_charged: 100 }
    }), { status: 200 });
  }
};

test("registers Luma only with explicit global/provider gates and authoritative billing", async () => {
  const [adapter] = createConfiguredVideoProviderAdapters(base);
  assert.equal(adapter.provider, "luma");
  assert.equal(adapter.model, "ray-3.2");
  const prepared = await adapter.prepareInput({
    provider: "luma", model: "ray-3.2",
    prompt: "A cinematic aerial view", durationSeconds: 5, resolution: "720p", aspectRatio: "16:9"
  }, { job: { owner_id: "owner-1", project_id: "project-1" } });
  const submitted = await adapter.submit(prepared);
  const task = await adapter.getStatus(submitted.taskId);
  assert.equal(task.status, "succeeded");
  assert.equal((await adapter.resolveActualCost({ task, providerTaskId: submitted.taskId })).amount, 0.3);
  assert.deepEqual(await adapter.ingestOutputs({ task }), { assetIds: ["asset-1"] });
});

test("does not register Luma when both provider-specific opt-ins are absent", () => {
  assert.throws(() => createConfiguredVideoProviderAdapters({
    ...base,
    env: { VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true" }
  }), /No video provider is configured/);
});

test("fails closed when Luma is partially enabled or has no settlement resolver", () => {
  assert.throws(() => createConfiguredVideoProviderAdapters({
    ...base, env: { ...base.env, LUMA_VIDEO_ALLOW_REMOTE: "false" }
  }), error => error.code === "LUMA_VIDEO_REMOTE_DISABLED");
  assert.throws(() => createConfiguredVideoProviderAdapters({
    ...base, resolveLumaActualCost: undefined
  }), error => error.code === "LUMA_BILLING_RESOLVER_REQUIRED");
});

test("requires owner-scoped resolution before Luma reference media is submitted", async () => {
  const [adapter] = createConfiguredVideoProviderAdapters(base);
  await assert.rejects(adapter.prepareInput({
    provider: "luma", model: "ray-3.2", prompt: "Animate", durationSeconds: 5,
    startFrame: { file_id: "private-file" }
  }, { job: { owner_id: "owner-1" } }), error => error.code === "LUMA_VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
});

test("registers Runway only when billing settlement evidence is injected", () => {
  const env = {
    VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true",
    RUNWAY_VIDEO_ENABLED: "true", RUNWAY_VIDEO_ALLOW_REMOTE: "true",
    RUNWAY_VIDEO_MODEL: "gen4.5", RUNWAY_API_KEY: "runway-test-key"
  };
  assert.throws(() => createConfiguredVideoProviderAdapters({
    env, ingestOutputs: base.ingestOutputs, fetchImpl: base.fetchImpl
  }), error => error.code === "RUNWAY_BILLING_RESOLVER_REQUIRED");
  const [adapter] = createConfiguredVideoProviderAdapters({
    env, ingestOutputs: base.ingestOutputs, fetchImpl: base.fetchImpl,
    resolveRunwayActualCost: async () => ({ amount: 0.5, currency: "USD", evidenceReference: "runway:verified-settlement" })
  });
  assert.equal(adapter.provider, "runway");
  assert.equal(adapter.model, "gen4.5");
});

test("requires exact provider/model identity before Luma preparation", async () => {
  const [adapter] = createConfiguredVideoProviderAdapters(base);
  await assert.rejects(adapter.prepareInput({
    provider: "runway", model: "gen4.5", prompt: "wrong provider"
  }), error => error.code === "VIDEO_JOB_INPUT_MISMATCH");
});
