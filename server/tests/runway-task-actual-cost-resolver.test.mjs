import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayTaskActualCostResolver } from "../runway-task-actual-cost-resolver.mjs";

const id = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
const submittedAt = "2026-11-16T10:00:00.000Z";
const current = new Date("2026-11-16T10:02:00.000Z");
const job = { created_at: submittedAt };
const input = { provider: "runway", model: "veo3.1" };
const task = { status: "succeeded", taskId: id, provider: "runway", model: "veo3.1" };
const row = (overrides = {}) => ({
  transactionId: "txn-001", taskId: id, timestamp: "2026-11-16T10:01:00.000Z",
  tool: "Veo 3.1", credits: 160, unit: "credits", type: "charge", ...overrides
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

function resolver(fetchImpl, model = "veo3.1") {
  return createRunwayTaskActualCostResolver({
    apiKey: "server-test-key", enabled: true, fetchImpl, now: () => current
  });
}

test("billing readiness verifies linked Enterprise workspace access before generation", async () => {
  let requested;
  const resolve = createRunwayTaskActualCostResolver({
    apiKey: "server-test-key", enabled: true, now: () => current,
    fetchImpl: async url => {
      requested = new URL(url);
      return response({ data: [], hasMore: false, nextCursor: null });
    }
  });
  assert.equal(await resolve.assertAvailable(), true);
  assert.equal(requested.pathname, "/v1/organization/webapp/usage");
  assert.equal(requested.searchParams.get("limit"), "1");
});

test("billing readiness blocks Veo generation if Enterprise workspace usage is not authorized", async () => {
  const resolve = createRunwayTaskActualCostResolver({
    apiKey: "server-test-key", enabled: true, now: () => current,
    fetchImpl: async () => response({ error: "enterprise required" }, 403)
  });
  await assert.rejects(() => resolve.assertAvailable(), error => error.code === "RUNWAY_TASK_BILLING_ENTERPRISE_REQUIRED");
});

test("billing readiness rejects malformed pagination envelopes", async () => {
  const resolve = createRunwayTaskActualCostResolver({
    apiKey: "server-test-key", enabled: true, now: () => current,
    fetchImpl: async () => response({ data: [], hasMore: true, nextCursor: null })
  });
  await assert.rejects(() => resolve.assertAvailable(), error => error.code === "RUNWAY_TASK_BILLING_RESPONSE_INVALID");
});

test("settles Veo task cost from the exact Enterprise per-generation usage row", async () => {
  let url;
  const resolve = resolver(async value => {
    url = new URL(value);
    return response({ data: [row()], hasMore: false, nextCursor: null });
  });
  const cost = await resolve({
    job, input, task, providerTaskId: id,
    submissionMetadata: { submittedAt }
  });
  assert.equal(cost.amount, 1.6);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.creditsCharged, 160);
  assert.equal(cost.evidenceReference, "runway-workspace-task-usage:" + id + ":160credits");
  assert.equal(url.pathname, "/v1/organization/webapp/usage");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("from"), "2026-11-16T09:55:00.000Z");
  assert.equal(url.searchParams.get("to"), "2026-11-16T10:07:00.000Z");
});

test("paginates all task transactions and nets explicit refunds", async () => {
  let page = 0;
  const resolve = resolver(async () => {
    page += 1;
    if (page === 1) return response({ data: [row()], hasMore: true, nextCursor: "opaque-next" });
    return response({ data: [row({ transactionId: "txn-refund", credits: 20, type: "refund" })], hasMore: false, nextCursor: null });
  });
  const cost = await resolve({ job, input, task, providerTaskId: id, submissionMetadata: { submittedAt } });
  assert.equal(page, 2);
  assert.equal(cost.creditsCharged, 140);
  assert.equal(cost.amount, 1.4);
  assert.equal(cost.transactionCount, 2);
});

test("keeps budget unresolved when the Enterprise workspace usage row has not settled", async () => {
  const resolve = resolver(async () => response({ data: [], hasMore: false, nextCursor: null }));
  await assert.rejects(
    () => resolve({ job, input, task, providerTaskId: id, submissionMetadata: { submittedAt } }),
    error => error.code === "RUNWAY_TASK_BILLING_NOT_SETTLED"
  );
});

test("requires exact task ID, model, provider and successful task state", async () => {
  const resolve = resolver(async () => response({ data: [row()], hasMore: false, nextCursor: null }));
  await assert.rejects(
    () => resolve({ job, input, task: { ...task, taskId: "597f6eca-6276-4993-bfeb-53cbbbba6f08" }, providerTaskId: id, submissionMetadata: { submittedAt } }),
    error => error.code === "RUNWAY_TASK_BILLING_INPUT_INVALID"
  );
  await assert.rejects(
    () => resolve({ job, input: { ...input, model: "veo3.1_fast" }, task, providerTaskId: id, submissionMetadata: { submittedAt } }),
    error => error.code === "RUNWAY_TASK_BILLING_INPUT_INVALID"
  );
});

test("rejects usage rows for a different model, task, timestamp or malformed credit schema", async () => {
  for (const bad of [
    row({ taskId: "597f6eca-6276-4993-bfeb-53cbbbba6f08" }),
    row({ tool: "Veo 3.1 Fast" }),
    row({ timestamp: "2026-11-17T10:01:00.000Z" }),
    row({ credits: "160" }),
    row({ unit: "usd" })
  ]) {
    const resolve = resolver(async () => response({ data: [bad], hasMore: false, nextCursor: null }));
    await assert.rejects(
      () => resolve({ job, input, task, providerTaskId: id, submissionMetadata: { submittedAt } }),
      error => error.code === "RUNWAY_TASK_BILLING_NOT_SETTLED" || error.code === "RUNWAY_TASK_BILLING_ROW_INVALID"
    );
  }
});

test("fails closed when linked Enterprise workspace usage is unauthorized", async () => {
  const resolve = resolver(async () => response({ error: "enterprise required" }, 403));
  await assert.rejects(
    () => resolve({ job, input, task, providerTaskId: id, submissionMetadata: { submittedAt } }),
    error => error.code === "RUNWAY_TASK_BILLING_ENTERPRISE_REQUIRED"
  );
});

test("requires explicit workspace usage opt-in and server-side credentials", () => {
  assert.throws(() => createRunwayTaskActualCostResolver({ apiKey: "key", enabled: false }), error => error.code === "RUNWAY_TASK_BILLING_DISABLED");
  assert.throws(() => createRunwayTaskActualCostResolver({ apiKey: "", enabled: true }), error => error.code === "RUNWAY_TASK_BILLING_KEY_REQUIRED");
});
