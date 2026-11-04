import test from "node:test";
import assert from "node:assert/strict";
import { createFalAsyncVideoClient } from "../fal-video-async.mjs";

const base = {
  apiKey: "test-only-key",
  model: "fal-ai/wan/v2.7/text-to-video",
  enabled: true,
  allowRemote: true,
  timeoutMs: 3000
};
const requestId = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const root = "https://queue.fal.run/fal-ai/wan/requests/" + requestId;
const taskBody = {
  request_id: requestId,
  status_url: root + "/status",
  response_url: root,
  cancel_url: root + "/cancel"
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("submits once and returns a provider task descriptor without waiting for generation", async () => {
  const calls = [];
  const client = createFalAsyncVideoClient({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(taskBody);
    }
  });
  const task = await client.submit({ prompt: "A cinematic sunrise", duration: 5 });
  assert.equal(task.provider, "fal");
  assert.equal(task.requestId, requestId);
  assert.equal(task.statusUrl, root + "/status");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].url, "https://queue.fal.run/fal-ai/wan/v2.7/text-to-video");
  assert.equal(calls[0].options.headers.authorization, "Key test-only-key");
  assert.equal(calls[0].options.headers["X-Fal-No-Retry"], "true");
  assert.equal(JSON.parse(calls[0].options.body).prompt, "A cinematic sunrise");
});

test("polls status and retrieves results as separate operations", async () => {
  const calls = [];
  const client = createFalAsyncVideoClient({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/status")) return jsonResponse({ status: "IN_PROGRESS", queue_position: 2 });
      return jsonResponse({ video: { url: "https://fal.media/files/output.mp4" } });
    }
  });
  const task = { model: base.model, requestId, statusUrl: root + "/status", resultUrl: root, cancelUrl: root + "/cancel" };
  const status = await client.status(task);
  assert.equal(status.status, "IN_PROGRESS");
  assert.equal(status.queuePosition, 2);
  const result = await client.result(task);
  assert.equal(result.video.url, "https://fal.media/files/output.mp4");
  assert.deepEqual(calls.map(call => call.options.method || "GET"), ["GET", "GET"]);
});

test("refuses unsafe provider task URLs before making a network request", async () => {
  let calls = 0;
  const client = createFalAsyncVideoClient({
    ...base,
    fetchImpl: async () => { calls += 1; return jsonResponse(taskBody); }
  });
  await assert.rejects(
    () => client.status({ model: base.model, requestId, statusUrl: "https://attacker.example/status", resultUrl: root, cancelUrl: root + "/cancel" }),
    error => error.code === "VIDEO_GATEWAY_INVALID_RESPONSE"
  );
  assert.equal(calls, 0);
});

test("marks ambiguous submission failures and never retries a potentially accepted generation", async () => {
  let calls = 0;
  const client = createFalAsyncVideoClient({
    ...base,
    fetchImpl: async () => { calls += 1; throw new TypeError("connection reset"); }
  });
  await assert.rejects(
    () => client.submit({ prompt: "A cinematic sunrise" }),
    error => error.code === "VIDEO_GATEWAY_SUBMISSION_UNKNOWN"
  );
  assert.equal(calls, 1);
});

test("remote generation remains disabled unless both server gates are enabled", async () => {
  let calls = 0;
  const client = createFalAsyncVideoClient({
    ...base,
    allowRemote: false,
    fetchImpl: async () => { calls += 1; return jsonResponse(taskBody); }
  });
  await assert.rejects(
    () => client.submit({ prompt: "A cinematic sunrise" }),
    error => error.code === "VIDEO_GATEWAY_REMOTE_DISABLED"
  );
  assert.equal(calls, 0);
});

test("keeps an early result response retryable while the provider task is still running", async () => {
  const task = { model: base.model, requestId, statusUrl: root + "/status", resultUrl: root, cancelUrl: root + "/cancel" };
  const client = createFalAsyncVideoClient({ ...base, fetchImpl: async () => jsonResponse({ detail: "Request is still in progress" }) });
  await assert.rejects(() => client.result(task), error => error.code === "VIDEO_GATEWAY_RESULT_NOT_READY");
});

test("rejects malformed provider task states and provider failures", async () => {
  const task = { model: base.model, requestId, statusUrl: root + "/status", resultUrl: root, cancelUrl: root + "/cancel" };
  const unknown = createFalAsyncVideoClient({ ...base, fetchImpl: async () => jsonResponse({ status: "MAYBE" }) });
  await assert.rejects(() => unknown.status(task), error => error.code === "VIDEO_GATEWAY_INVALID_RESPONSE");
  const failed = createFalAsyncVideoClient({ ...base, fetchImpl: async () => jsonResponse({ detail: "model failed" }) });
  await assert.rejects(() => failed.result(task), error => error.code === "VIDEO_GATEWAY_JOB_FAILED");
});
