import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleInteractionRetentionWorker } from "../google-interaction-retention-worker.mjs";

function record(overrides = {}) {
  return {
    interactionId: "v1_abcdef123456",
    ownerId: "123e4567-e89b-42d3-a456-426614174000",
    projectId: "223e4567-e89b-42d3-a456-426614174000",
    jobId: "323e4567-e89b-42d3-a456-426614174000",
    state: "succeeded",
    ...overrides
  };
}
function harness({ failDelete = false, initialState = "succeeded" } = {}) {
  const calls = [];
  const rows = [record({ state: initialState })];
  const interactions = {
    async listExpired(args) { calls.push(["list", args]); return rows; },
    async updateInteraction(value) { calls.push(["update", value]); rows[0].state = value.state; return rows[0]; },
    async markInteractionDeleted(value) { calls.push(["markDeleted", value]); rows[0].state = "deleted"; return rows[0]; }
  };
  const client = {
    async deleteInteraction(id, context) {
      calls.push(["delete", id, context]);
      if (failDelete) throw new Error("temporary provider failure");
      return { interactionId: id, deleted: true };
    }
  };
  return { worker: createGoogleInteractionRetentionWorker({ interactions, client }), calls, rows };
}

test("marks expired interaction deleting, deletes provider state and marks durable record deleted", async () => {
  const h = harness();
  const result = await h.worker.run({ limit: 10 });
  assert.deepEqual(result, {
    scanned: 1, deleted: 1, retryPending: 0,
    results: [{ interactionId: "v1_abcdef123456", status: "deleted" }]
  });
  assert.deepEqual(h.calls.map(call => call[0]), ["list", "update", "delete", "markDeleted"]);
  assert.equal(h.calls[1][1].state, "deleting");
  assert.equal(h.calls[2][2].ownerId, h.rows[0].ownerId);
  assert.equal(h.rows[0].state, "deleted");
});

test("retries a previously deleting record without resetting its state", async () => {
  const h = harness({ initialState: "deleting" });
  await h.worker.run();
  assert.deepEqual(h.calls.map(call => call[0]), ["list", "delete", "markDeleted"]);
});

test("leaves a retryable deleting record when provider deletion fails", async () => {
  const h = harness({ failDelete: true });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(h.rows[0].state, "deleting");
  assert.equal(h.calls.some(call => call[0] === "markDeleted"), false);
});
