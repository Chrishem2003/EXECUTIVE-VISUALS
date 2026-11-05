import assert from "node:assert/strict";
import test from "node:test";
import { retryWithBackoff } from "../../src/core/retry.ts";

test("retries transient failures with bounded exponential delays", async () => {
  let calls = 0;
  const delays = [];
  const value = await retryWithBackoff(async () => {
    calls++;
    if (calls < 3) throw new TypeError("network unavailable");
    return "saved";
  }, {
    attempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 250,
    shouldRetry: error => error instanceof TypeError,
    sleep: async delay => { delays.push(delay); }
  });
  assert.equal(value, "saved");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("does not retry revision conflicts or other non-transient failures", async () => {
  let calls = 0;
  const conflict = Object.assign(new Error("revision conflict"), { status: 409 });
  await assert.rejects(() => retryWithBackoff(async () => {
    calls++;
    throw conflict;
  }, { shouldRetry: error => error.status === 429 || error.status >= 500 }));
  assert.equal(calls, 1);
});

test("stops after the configured attempt limit", async () => {
  let calls = 0;
  await assert.rejects(() => retryWithBackoff(async () => {
    calls++;
    throw new TypeError("offline");
  }, {
    attempts: 2,
    shouldRetry: error => error instanceof TypeError,
    sleep: async () => {}
  }));
  assert.equal(calls, 2);
});

test("rejects invalid retry configuration", async () => {
  await assert.rejects(() => retryWithBackoff(async () => "ok", { attempts: 0 }));
});
