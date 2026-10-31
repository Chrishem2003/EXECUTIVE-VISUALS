import test from "node:test";
import assert from "node:assert/strict";
import { createCloudMediaWorker } from "../cloud-media-worker.mjs";

test("cloud media worker composes the leased queue and injected media executor", async () => {
  const calls = [];
  const queue = {
    async claim() { calls.push("claim"); return null; },
    async renew() { return true; },
    async finish() { return true; },
    async recover(limit) { calls.push("recover:" + limit); return 2; }
  };
  const worker = createCloudMediaWorker({
    workerId: "media-worker-a",
    queue,
    assetService: { assets: {} },
    mediaIO: {},
    execute: async () => ({ ok: true })
  });
  assert.deepEqual(await worker.runCycle({ onEvent: event => calls.push(event.type) }), { claimed: false });
  assert.equal(await worker.recoverExpired(25), 2);
  assert.deepEqual(calls, ["claim", "recover:25"]);
});

test("cloud media worker requires an explicit stable worker identity", () => {
  assert.throws(
    () => createCloudMediaWorker({ workerId: " " }),
    /worker ID/
  );
});
