import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiFilesRetentionWorker } from "../google-gemini-files-retention-worker.mjs";

const row = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "files/gemini-123",
  state: "ACTIVE"
};

function harness({ failDelete = false, missing = false, failFinalize = false } = {}) {
  const calls = [];
  let state = row.state;
  const repository = {
    async listExpiredProviderFiles(args) { calls.push(["list", args]); return [{ ...row, state }]; },
    async updateProviderFileState(args) {
      calls.push(["state", args]);
      if (failFinalize && args.state === "DELETED") throw new Error("database unavailable");
      state = args.state;
      return row.id;
    }
  };
  const gateway = {
    async deleteProviderFile(name) {
      calls.push(["delete", name]);
      if (missing) throw Object.assign(new Error("not found"), { status: 404 });
      if (failDelete) throw new Error("temporary provider error");
      return true;
    }
  };
  return { worker: createGoogleGeminiFilesRetentionWorker({ repository, gateway }), calls, getState: () => state };
}

test("expires the mapping before provider deletion and finalizes it as deleted", async () => {
  const h = harness();
  const result = await h.worker.run({ before: "2026-11-05T00:00:00.000Z", limit: 20 });
  assert.deepEqual(result, {
    scanned: 1, deleted: 1, retryPending: 0,
    results: [{ recordId: row.id, status: "deleted" }]
  });
  assert.deepEqual(h.calls.map(call => call[0]), ["list", "state", "delete", "state"]);
  assert.equal(h.calls[1][1].state, "EXPIRED");
  assert.equal(h.calls[3][1].state, "DELETED");
  assert.equal(h.getState(), "DELETED");
});

test("treats a provider 404 as already deleted and finalizes the tombstone", async () => {
  const h = harness({ missing: true });
  const result = await h.worker.run();
  assert.equal(result.deleted, 1);
  assert.equal(result.retryPending, 0);
  assert.equal(h.getState(), "DELETED");
});

test("retains an expired mapping for retry when provider deletion fails", async () => {
  const h = harness({ failDelete: true });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(h.getState(), "EXPIRED");
});

test("retains an expired mapping when final database confirmation fails", async () => {
  const h = harness({ failFinalize: true });
  const result = await h.worker.run();
  assert.equal(result.deleted, 0);
  assert.equal(result.retryPending, 1);
  assert.equal(h.getState(), "EXPIRED");
});
