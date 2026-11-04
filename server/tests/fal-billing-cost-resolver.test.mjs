import test from "node:test";
import assert from "node:assert/strict";
import { createFalBillingCostResolver } from "../fal-billing-cost-resolver.mjs";

const base = { apiKey: "billing-test-key", timeoutMs: 3000 };
const event = {
  request_id: "req-123",
  endpoint_id: "fal-ai/wan/v2.7/text-to-video",
  timestamp: "2026-11-05T10:00:00.000Z",
  quantity: 5,
  unit: "second",
  unit_price: 0.05,
  percent_discount: 10,
  cost_total: 0.225,
  cost_estimate_nano_usd: 225000000
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("resolves exact per-request billed cost using precision-preserving nano-USD", async () => {
  let request;
  const resolve = createFalBillingCostResolver({
    ...base,
    fetchImpl: async (url, options) => { request = { url: new URL(url), options }; return response({ billing_events: [event] }); }
  });
  const result = await resolve({ providerTaskId: "req-123", model: event.endpoint_id });
  assert.equal(result.amount, 0.225);
  assert.equal(result.currency, "USD");
  assert.equal(result.evidenceReference, "fal-billing-event:req-123:" + event.timestamp);
  assert.equal(request.url.origin, "https://api.fal.ai");
  assert.equal(request.url.pathname, "/v1/models/billing-events");
  assert.equal(request.url.searchParams.get("request_id"), "req-123");
  assert.equal(request.url.searchParams.get("endpoint_id"), event.endpoint_id);
  assert.ok(Date.parse(request.url.searchParams.get("start")) <= Date.now());
  assert.ok(Date.now() - Date.parse(request.url.searchParams.get("start")) <= 90 * 24 * 60 * 60 * 1000);
  assert.equal(request.options.headers.authorization, "Key billing-test-key");
});

test("does not match a different request or model and keeps missing events retryable", async () => {
  const resolve = createFalBillingCostResolver({ ...base, fetchImpl: async () => response({ billing_events: [{ ...event, request_id: "other" }] }) });
  await assert.rejects(
    () => resolve({ providerTaskId: "req-123", model: event.endpoint_id }),
    error => error.code === "VIDEO_BILLING_EVENT_NOT_READY"
  );
});

test("rejects duplicate and inconsistent billed events", async () => {
  const duplicate = createFalBillingCostResolver({ ...base, fetchImpl: async () => response({ billing_events: [event, event] }) });
  await assert.rejects(() => duplicate({ providerTaskId: "req-123", model: event.endpoint_id }), error => error.code === "VIDEO_BILLING_EVENT_AMBIGUOUS");
  const mismatch = createFalBillingCostResolver({ ...base, fetchImpl: async () => response({ billing_events: [{ ...event, cost_total: 0.5 }] }) });
  await assert.rejects(() => mismatch({ providerTaskId: "req-123", model: event.endpoint_id }), error => error.code === "VIDEO_BILLING_INVALID_RESPONSE");
});

test("rejects billing lookups outside the FAL 90-day date-range limit", async () => {
  const resolve = createFalBillingCostResolver({ ...base, fetchImpl: async () => response({ billing_events: [] }) });
  await assert.rejects(() => resolve({ providerTaskId: "req-123", model: event.endpoint_id, submittedAt: "2025-01-01T00:00:00.000Z" }), error => error.code === "VIDEO_BILLING_LOOKBACK_EXCEEDED");
});

test("billing permissions and provider failures fail closed", async () => {
  const denied = createFalBillingCostResolver({ ...base, fetchImpl: async () => response({ error: "forbidden" }, 403) });
  await assert.rejects(() => denied({ providerTaskId: "req-123", model: event.endpoint_id }), error => error.code === "VIDEO_BILLING_ACCESS_DENIED");
  const invalid = createFalBillingCostResolver({ ...base, fetchImpl: async () => response({ billing_events: [] }) });
  await assert.rejects(() => invalid({ providerTaskId: "bad id", model: event.endpoint_id }), error => error.code === "VIDEO_BILLING_INPUT_INVALID");
  assert.throws(() => createFalBillingCostResolver({ apiKey: "" }), error => error.code === "VIDEO_BILLING_CONFIG_INVALID");
});
