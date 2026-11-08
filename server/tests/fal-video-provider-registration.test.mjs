import test from "node:test";
import assert from "node:assert/strict";
import { createFalVideoProviderAdapter } from "../fal-video-provider-registration.mjs";

const model = "fal-ai/wan/v2.7/text-to-video";
const requestId = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const event = {
  request_id: requestId, endpoint_id: model,
  timestamp: "2026-11-04T10:00:00.000Z",
  cost_total: 0.225, cost_estimate_nano_usd: 225000000
};

function fixture(overrides = {}) {
  const calls = [];
  const queueClient = {
    async submit(input) { calls.push(["submit", input]); return { requestId }; },
    async status() { calls.push(["status"]); return { status: "IN_QUEUE" }; },
    async result() { calls.push(["result"]); return { video: { url: "https://fal.media/output.mp4" } }; }
  };
  const env = {
    FAL_VIDEO_MODEL: model, FAL_KEY: "queue-test-key",
    FAL_BILLING_KEY: "billing-test-key",
    VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true"
  };
  const adapter = createFalVideoProviderAdapter({
    env,
    queueClient,
    fetchImpl: async (url, options) => {
      calls.push(["billing", new URL(url).pathname, options.headers.authorization]);
      return new Response(JSON.stringify({ billing_events: [event] }), { status: 200 });
    },
    ingestOutputs: async args => ({ assetIds: ["asset-1"], args }),
    ...overrides
  });
  return { adapter, calls };
}

test("registers one exact FAL model and routes billing through request-specific evidence", async () => {
  const { adapter, calls } = fixture();
  assert.equal(adapter.provider, "fal");
  assert.equal(adapter.model, model);
  const cost = await adapter.resolveActualCost({ providerTaskId: requestId, model, job: { created_at: event.timestamp } });
  assert.equal(cost.amount, 0.225);
  assert.equal(cost.evidenceReference, "fal-billing-event:" + requestId + ":" + event.timestamp);
  assert.deepEqual(calls, [["billing", "/v1/models/billing-events", "Key billing-test-key"]]);
});

test("does not construct FAL registration without an exact model or private ingestion", () => {
  assert.throws(() => createFalVideoProviderAdapter({ env: {}, ingestOutputs: async () => ({ assetIds: [] }) }), /exact FAL endpoint/);
  assert.throws(() => createFalVideoProviderAdapter({ env: { FAL_VIDEO_MODEL: model, FAL_KEY: "key" } }), /private output ingestor/);
});

test("provider adapter preserves exact-model and remote-execution gates", async () => {
  const { adapter, calls } = fixture({ env: {
    FAL_VIDEO_MODEL: model, FAL_KEY: "queue-test-key",
    FAL_BILLING_KEY: "billing-test-key",
    VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "false"
  }});
  await assert.rejects(() => adapter.submit({ provider: "fal", model, prompt: "test" }), error => error.code === "VIDEO_GATEWAY_REMOTE_DISABLED");
  assert.deepEqual(calls, []);
});
