import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableTimelineSaveError, retryTimelineSave } from "../../src/core/timeline-save-retry.ts";

function apiError(status, code = "REQUEST_FAILED") {
  return Object.assign(new Error("request failed"), { status, code });
}

test("transient HTTP statuses are retryable but conflicts and ordinary client errors are not", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 599]) {
    assert.equal(isRetryableTimelineSaveError(apiError(status)), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableTimelineSaveError(apiError(status)), false, String(status));
  }
});

test("browser transport failures are retryable but aborts and arbitrary errors are not", () => {
  assert.equal(isRetryableTimelineSaveError(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableTimelineSaveError(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(isRetryableTimelineSaveError(new Error("validation failed")), false);
});

test("retries only after reconciliation proves the expected revision is still current", async () => {
  let saves = 0;
  let reconciliations = 0;
  const delays = [];
  const result = await retryTimelineSave({
    save: async () => {
      saves++;
      if (saves === 1) throw apiError(503);
      return { revision: 8 };
    },
    reconcile: async () => {
      reconciliations++;
      return { kind: "retry" };
    },
    wait: async milliseconds => { delays.push(milliseconds); }
  });

  assert.deepEqual(result, { revision: 8 });
  assert.equal(saves, 2);
  assert.equal(reconciliations, 1);
  assert.deepEqual(delays, [250]);
});

test("a lost successful response is reconciled as committed without a duplicate PUT", async () => {
  let saves = 0;
  const result = await retryTimelineSave({
    save: async () => { saves++; throw new TypeError("Failed to fetch"); },
    reconcile: async () => ({ kind: "committed", value: { revision: 12 } }),
    wait: async () => { throw new Error("Committed writes must not wait or retry."); }
  });

  assert.deepEqual(result, { revision: 12 });
  assert.equal(saves, 1);
});

test("a concurrent server revision is surfaced as a conflict and never overwritten", async () => {
  let saves = 0;
  await assert.rejects(
    () => retryTimelineSave({
      save: async () => { saves++; throw apiError(503); },
      reconcile: async () => ({ kind: "conflict" }),
      wait: async () => {}
    }),
    error => error.code === "REVISION_CONFLICT" && error.status === 409
  );
  assert.equal(saves, 1);
});

test("unknown reconciliation outcome does not retry an ambiguous write", async () => {
  let saves = 0;
  await assert.rejects(
    () => retryTimelineSave({
      save: async () => { saves++; throw apiError(503); },
      reconcile: async () => ({ kind: "unknown" }),
      wait: async () => {}
    }),
    error => error.status === 503
  );
  assert.equal(saves, 1);
});

test("a failed reconciliation does not retry an ambiguous write", async () => {
  let saves = 0;
  await assert.rejects(
    () => retryTimelineSave({
      save: async () => { saves++; throw new TypeError("Failed to fetch"); },
      reconcile: async () => { throw new Error("read failed"); },
      wait: async () => {}
    }),
    error => error instanceof TypeError
  );
  assert.equal(saves, 1);
});

test("retry attempts are bounded and use exponential backoff", async () => {
  let saves = 0;
  const delays = [];
  await assert.rejects(
    () => retryTimelineSave({
      maxAttempts: 4,
      baseDelayMs: 100,
      save: async () => { saves++; throw apiError(503); },
      reconcile: async () => ({ kind: "retry" }),
      wait: async milliseconds => { delays.push(milliseconds); }
    }),
    error => error.status === 503
  );
  assert.equal(saves, 4);
  assert.deepEqual(delays, [100, 200, 400]);
});

test("non-transient errors are never reconciled or retried", async () => {
  let saves = 0;
  let reconciliations = 0;
  await assert.rejects(
    () => retryTimelineSave({
      save: async () => { saves++; throw apiError(422, "TIMELINE_INVALID"); },
      reconcile: async () => { reconciliations++; return { kind: "retry" }; },
      wait: async () => {}
    }),
    error => error.code === "TIMELINE_INVALID"
  );
  assert.equal(saves, 1);
  assert.equal(reconciliations, 0);
});
