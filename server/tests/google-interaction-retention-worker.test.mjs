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

function harness({
  failDelete = false,
  initialState = "succeeded",
  remoteStatus = "succeeded",
  cancelStatus = "canceled",
  afterCancelStatus = cancelStatus,
  failCancel = false
} = {}) {
  const calls = [];
  const rows = [record({ state: initialState })];
  let currentRemoteStatus = remoteStatus;
  const interactions = {
    async listExpired(args) { calls.push(["list", args]); return rows; },
    async updateInteraction(value) {
      calls.push(["update", value]);
      rows[0].state = value.state;
      return rows[0];
    },
    async markInteractionDeleted(value) {
      calls.push(["markDeleted", value]);
      rows[0].state = "deleted";
      return rows[0];
    }
  };
  const client = {
    async getInteraction(id, context) {
      calls.push(["get", id, context]);
      return { interactionId: id, status: currentRemoteStatus };
    },
    async cancelInteraction(id, context) {
      calls.push(["cancel", id, context]);
      if (failCancel) throw new Error("temporary cancellation failure");
      currentRemoteStatus = afterCancelStatus;
      return { interactionId: id, status: cancelStatus };
    },
    async deleteInteraction(id, context) {
      calls.push(["delete", id, context]);
      if (failDelete) throw new Error("temporary provider failure");
      return { interactionId: id, deleted: true };
    }
  };
  return { worker: createGoogleInteractionRetentionWorker({ interactions, client }), calls, rows };
}

test("deletes expired terminal interaction and marks its durable record deleted", async () => {
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

test("cancels an expired running interaction and confirms terminal state before deletion", async () => {
  const h = harness({
    initialState: "running",
    remoteStatus: "running",
    cancelStatus: "canceled",
    afterCancelStatus: "canceled"
  });
  const result = await h.worker.run();
  assert.equal(result.deleted, 1);
  assert.deepEqual(h.calls.map(call => call[0]), ["list", "get", "cancel", "get", "update", "update", "delete", "markDeleted"]);
  assert.equal(h.calls[4][1].state, "canceled");
  assert.equal(h.calls[5][1].state, "deleting");
});

test("does not delete while cancellation remains in progress", async () => {
  const h = harness({
    initialState: "waiting",
    remoteStatus: "waiting",
    cancelStatus: "canceled",
    afterCancelStatus: "running"
  });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.deepEqual(h.calls.map(call => call[0]), ["list", "get", "cancel", "get", "update"]);
  assert.equal(h.calls.some(call => call[0] === "delete"), false);
  assert.equal(h.rows[0].state, "running");
});

test("reconciles legacy deleting records that are still active", async () => {
  const h = harness({
    initialState: "deleting",
    remoteStatus: "running",
    cancelStatus: "canceled",
    afterCancelStatus: "canceled"
  });
  const result = await h.worker.run();
  assert.equal(result.deleted, 1);
  assert.deepEqual(h.calls.map(call => call[0]), ["list", "get", "cancel", "get", "update", "update", "delete", "markDeleted"]);
});

test("leaves a retryable record when provider cancellation fails", async () => {
  const h = harness({ initialState: "running", remoteStatus: "running", failCancel: true });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(h.calls.some(call => call[0] === "delete"), false);
  assert.equal(h.rows[0].state, "running");
});

test("leaves a retryable deleting record when provider deletion fails", async () => {
  const h = harness({ failDelete: true });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(h.rows[0].state, "deleting");
  assert.equal(h.calls.some(call => call[0] === "markDeleted"), false);
});

test("treats queued provider interactions as pending rather than unknown or terminal", async () => {
  const h = harness({
    initialState: "waiting",
    remoteStatus: "waiting",
    cancelStatus: "canceled",
    afterCancelStatus: "running"
  });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(h.calls.some(call => call[0] === "delete"), false);
});
